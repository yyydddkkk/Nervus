import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  runCodingCli,
  type CodingCliIO,
} from "../apps/coding-agent/src/index.js";
import {
  JsonlSessionJournal,
  type ModelAdapter,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

function captureIO(): CodingCliIO & {
  readonly output: string[];
  readonly errors: string[];
} {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    write(value) {
      output.push(value);
    },
    writeError(value) {
      errors.push(value);
    },
    onInterrupt() {
      return () => undefined;
    },
  };
}

describe("Reference Coding Host", () => {
  it("runs one durable coding Session with the Coding Skill and root instructions", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nervus-code-workspace-"));
    const stateDirectory = await mkdtemp(join(tmpdir(), "nervus-code-state-"));
    await writeFile(
      join(workspace, "AGENTS.md"),
      "Always mention the fixture rule.",
      "utf8",
    );
    const io = captureIO();
    const model: ModelAdapter = {
      id: "scripted/coding-host",
      async *generate(request) {
        expect(request.tools.map((tool) => tool.id)).toEqual([
          "fs/read",
          "fs/list",
          "fs/write",
          "shell/run",
        ]);
        const instructions = request.instructions
          .filter((block) => block.type === "text")
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("\n");
        expect(instructions).toContain("inspect repository evidence");
        expect(instructions).toContain("never pass a directory to fs/read");
        expect(instructions).toContain("Always mention the fixture rule.");
        expect(request.messages.at(-1)).toMatchObject({
          role: "user",
          content: [{ type: "text", text: "Inspect this repository" }],
        });
        yield { type: "text-delta", delta: "Repository inspected" };
        yield { type: "response-completed" };
      },
    };

    try {
      await expect(
        runCodingCli(
          [
            "run",
            "--workspace",
            workspace,
            "--state-dir",
            stateDirectory,
            "--session",
            "fixture-session",
            "Inspect this repository",
          ],
          {
            io,
            env: { OPENAI_MODEL: "scripted" },
            modelAdapter: model,
          },
        ),
      ).resolves.toBe(0);
      expect(io.output.join("")).toContain("Repository inspected");
      expect(io.errors.join("")).toContain("[session fixture-session]");

      const journal = new JsonlSessionJournal({ directory: stateDirectory });
      const events = await journal.read("fixture-session");
      expect(events.at(-1)?.payload).toMatchObject({
        type: "turn/completed",
        output: [{ type: "text", text: "Repository inspected" }],
      });
      const call = events.find(
        (event) => event.payload.type === "model/call-started",
      );
      if (!call || call.payload.type !== "model/call-started") {
        throw new Error("missing ModelCall");
      }
      expect(call.payload.snapshot.report.includedBlockIds).toEqual(
        expect.arrayContaining([
          "skill/nervus/coding/instructions",
          "host/root-agents",
        ]),
      );
    } finally {
      await Promise.all([
        rm(workspace, { recursive: true, force: true }),
        rm(stateDirectory, { recursive: true, force: true }),
      ]);
    }
  });

  it("resumes an existing Session with its recorded history", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nervus-code-resume-workspace-"));
    const stateDirectory = await mkdtemp(join(tmpdir(), "nervus-code-resume-state-"));
    const firstIO = captureIO();
    const firstModel: ModelAdapter = {
      id: "scripted/coding-resume",
      async *generate() {
        yield { type: "text-delta", delta: "first result" };
        yield { type: "response-completed" };
      },
    };

    try {
      await runCodingCli(
        [
          "run",
          "--workspace",
          workspace,
          "--state-dir",
          stateDirectory,
          "--session",
          "resume-session",
          "first task",
        ],
        {
          io: firstIO,
          env: { OPENAI_MODEL: "scripted" },
          modelAdapter: firstModel,
        },
      );

      const resumeIO = captureIO();
      const resumeModel: ModelAdapter = {
        id: "scripted/coding-resume",
        async *generate(request) {
          expect(
            request.messages
              .filter((message) => message.role === "user")
              .map((message) => message.content),
          ).toEqual([
            [{ type: "text", text: "first task" }],
            [{ type: "text", text: "follow-up task" }],
          ]);
          expect(
            request.messages.some(
              (message) =>
                message.role === "assistant" &&
                message.content.some(
                  (block) =>
                    block.type === "text" && block.text === "first result",
                ),
            ),
          ).toBe(true);
          yield { type: "text-delta", delta: "resumed result" };
          yield { type: "response-completed" };
        },
      };
      await expect(
        runCodingCli(
          [
            "resume",
            "resume-session",
            "--workspace",
            workspace,
            "--state-dir",
            stateDirectory,
            "follow-up task",
          ],
          {
            io: resumeIO,
            env: { OPENAI_MODEL: "scripted" },
            modelAdapter: resumeModel,
          },
        ),
      ).resolves.toBe(0);
      expect(resumeIO.output.join("")).toContain("resumed result");

      const journal = new JsonlSessionJournal({ directory: stateDirectory });
      const events = await journal.read("resume-session");
      expect(
        events.filter((event) => event.type === "turn/completed"),
      ).toHaveLength(2);
    } finally {
      await Promise.all([
        rm(workspace, { recursive: true, force: true }),
        rm(stateDirectory, { recursive: true, force: true }),
      ]);
    }
  });

  it("partitions default durable state by canonical workspace outside the repository", async () => {
    const workspaceOne = await mkdtemp(join(tmpdir(), "nervus-code-state-one-"));
    const workspaceTwo = await mkdtemp(join(tmpdir(), "nervus-code-state-two-"));
    const stateHome = await mkdtemp(join(tmpdir(), "nervus-code-state-home-"));
    const model: ModelAdapter = {
      id: "scripted/coding-state",
      async *generate() {
        yield { type: "text-delta", delta: "done" };
        yield { type: "response-completed" };
      },
    };

    try {
      for (const workspace of [workspaceOne, workspaceTwo]) {
        const io = captureIO();
        await expect(
          runCodingCli(
            ["run", "--workspace", workspace, "state task"],
            {
              io,
              env: {
                OPENAI_MODEL: "scripted",
                XDG_STATE_HOME: stateHome,
              },
              modelAdapter: model,
            },
          ),
        ).resolves.toBe(0);
        expect(io.errors.join("")).toMatch(
          /\[session code-\d{14}-[a-f0-9]{6}\]/,
        );
      }

      const partitions = await readdir(
        join(stateHome, "nervus", "coding"),
      );
      expect(partitions).toHaveLength(2);
      for (const partition of partitions) {
        const journals = (
          await readdir(
            join(stateHome, "nervus", "coding", partition, "sessions"),
          )
        ).filter((name) => name.endsWith(".jsonl"));
        expect(journals).toHaveLength(1);
        expect(journals[0]).toMatch(/\.jsonl$/);
      }
      await expect(access(join(workspaceOne, ".nervus"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(access(join(workspaceTwo, ".nervus"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await Promise.all([
        rm(workspaceOne, { recursive: true, force: true }),
        rm(workspaceTwo, { recursive: true, force: true }),
        rm(stateHome, { recursive: true, force: true }),
      ]);
    }
  });

  it("emits one Journal-derived JSON record without mixing streamed text", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nervus-code-json-workspace-"));
    const stateDirectory = await mkdtemp(join(tmpdir(), "nervus-code-json-state-"));
    const io = captureIO();
    const model: ModelAdapter = {
      id: "scripted/coding-json",
      async *generate() {
        yield { type: "text-delta", delta: "structured answer" };
        yield {
          type: "usage",
          inputTokens: 4,
          outputTokens: 2,
          totalTokens: 6,
        };
        yield { type: "response-completed" };
      },
    };

    try {
      await expect(
        runCodingCli(
          [
            "run",
            "--workspace",
            workspace,
            "--state-dir",
            stateDirectory,
            "--session",
            "json-session",
            "--json",
            "json task",
          ],
          {
            io,
            env: { OPENAI_MODEL: "scripted" },
            modelAdapter: model,
          },
        ),
      ).resolves.toBe(0);

      const record = JSON.parse(io.output.join("")) as Record<string, unknown>;
      expect(record).toMatchObject({
        schemaVersion: 1,
        workspace,
        sessionId: "json-session",
        status: "completed",
        output: [{ type: "text", text: "structured answer" }],
        eventCount: expect.any(Number),
        toolCallCount: 0,
        toolErrorCount: 0,
        usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
      });
      expect(record.turnId).toEqual(expect.any(String));
      expect(io.output).toHaveLength(1);
    } finally {
      await Promise.all([
        rm(workspace, { recursive: true, force: true }),
        rm(stateDirectory, { recursive: true, force: true }),
      ]);
    }
  });

  it("edits, verifies, and reviews a fixture through recorded local Tools", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nervus-code-edit-workspace-"));
    const stateDirectory = await mkdtemp(join(tmpdir(), "nervus-code-edit-state-"));
    await writeFile(join(workspace, "value.txt"), "broken\n", "utf8");
    await execFileAsync("git", ["init", "-q"], { cwd: workspace });
    await execFileAsync("git", ["add", "value.txt"], { cwd: workspace });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Nervus Fixture",
        "-c",
        "user.email=fixture@nervus.invalid",
        "commit",
        "-qm",
        "fixture",
      ],
      { cwd: workspace },
    );
    const io = captureIO();
    const model: ModelAdapter = {
      id: "scripted/coding-edit",
      async *generate(request) {
        const results = request.messages.filter(
          (message) => message.role === "tool",
        );
        if (results.length === 0) {
          yield {
            type: "tool-call",
            call: {
              id: "read-value",
              toolId: "fs/read",
              arguments: { path: "value.txt" },
            },
          };
        } else if (results.length === 1) {
          expect(results[0]?.content).toEqual([
            { type: "text", text: "broken\n" },
          ]);
          yield {
            type: "tool-call",
            call: {
              id: "write-value",
              toolId: "fs/write",
              arguments: { path: "value.txt", content: "fixed\n" },
            },
          };
        } else if (results.length === 2) {
          yield {
            type: "tool-call",
            call: {
              id: "verify-value",
              toolId: "shell/run",
              arguments: {
                command:
                  'test "$(cat value.txt)" = fixed && git diff -- value.txt && git status --short',
              },
            },
          };
        } else {
          const verification = results.at(-1)?.content[0];
          expect(verification).toMatchObject({
            type: "json",
            value: {
              exitCode: 0,
              stdout: expect.stringContaining("M value.txt"),
            },
          });
          yield {
            type: "text-delta",
            delta: "Fixed value.txt and verified the final diff.",
          };
        }
        yield { type: "response-completed" };
      },
    };

    try {
      await expect(
        runCodingCli(
          [
            "run",
            "--workspace",
            workspace,
            "--state-dir",
            stateDirectory,
            "--session",
            "edit-session",
            "Fix value.txt",
          ],
          {
            io,
            env: { OPENAI_MODEL: "scripted" },
            modelAdapter: model,
          },
        ),
      ).resolves.toBe(0);
      await expect(readFile(join(workspace, "value.txt"), "utf8")).resolves.toBe(
        "fixed\n",
      );
      expect(io.output.join("")).toContain("Fixed value.txt");
      expect(io.errors.join("")).toContain("[progress fs/read]");
      expect(io.errors.join("")).toContain("[progress fs/write]");
      expect(io.errors.join("")).toContain("[progress shell/run]");

      const journal = new JsonlSessionJournal({ directory: stateDirectory });
      expect(
        (await journal.read("edit-session"))
          .filter((event) => event.payload.type === "tool/call-started")
          .map((event) =>
            event.payload.type === "tool/call-started"
              ? event.payload.call.toolId
              : "",
          ),
      ).toEqual(["fs/read", "fs/write", "shell/run"]);
    } finally {
      await Promise.all([
        rm(workspace, { recursive: true, force: true }),
        rm(stateDirectory, { recursive: true, force: true }),
      ]);
    }
  });

  it("reads nearer scoped instructions before a nested edit", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nervus-code-scoped-workspace-"));
    const stateDirectory = await mkdtemp(join(tmpdir(), "nervus-code-scoped-state-"));
    await writeFile(join(workspace, "AGENTS.md"), "Root fixture instructions.\n", "utf8");
    await mkdir(join(workspace, "nested"), { recursive: true });
    await writeFile(
      join(workspace, "nested", "AGENTS.md"),
      "Write scoped-value.\n",
      "utf8",
    );
    await writeFile(join(workspace, "nested", "value.txt"), "old\n", "utf8");
    await execFileAsync("git", ["init", "-q"], { cwd: workspace });
    await execFileAsync("git", ["add", "."], { cwd: workspace });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Nervus Fixture",
        "-c",
        "user.email=fixture@nervus.invalid",
        "commit",
        "-qm",
        "fixture",
      ],
      { cwd: workspace },
    );
    const io = captureIO();
    const model: ModelAdapter = {
      id: "scripted/coding-scoped",
      async *generate(request) {
        const results = request.messages.filter(
          (message) => message.role === "tool",
        );
        if (results.length === 0) {
          yield {
            type: "tool-call",
            call: {
              id: "read-scoped-agents",
              toolId: "fs/read",
              arguments: { path: "nested/AGENTS.md" },
            },
          };
        } else if (results.length === 1) {
          expect(results[0]?.content).toEqual([
            { type: "text", text: "Write scoped-value.\n" },
          ]);
          yield {
            type: "tool-call",
            call: {
              id: "write-scoped-value",
              toolId: "fs/write",
              arguments: {
                path: "nested/value.txt",
                content: "scoped-value\n",
              },
            },
          };
        } else if (results.length === 2) {
          yield {
            type: "tool-call",
            call: {
              id: "verify-scoped-value",
              toolId: "shell/run",
              arguments: {
                command:
                  'test "$(cat nested/value.txt)" = scoped-value && git diff -- nested/value.txt && git status --short',
              },
            },
          };
        } else {
          yield { type: "text-delta", delta: "Applied scoped instructions." };
        }
        yield { type: "response-completed" };
      },
    };

    try {
      await expect(
        runCodingCli(
          [
            "run",
            "--workspace",
            workspace,
            "--state-dir",
            stateDirectory,
            "--session",
            "scoped-session",
            "Update nested/value.txt",
          ],
          {
            io,
            env: { OPENAI_MODEL: "scripted" },
            modelAdapter: model,
          },
        ),
      ).resolves.toBe(0);
      await expect(
        readFile(join(workspace, "nested", "value.txt"), "utf8"),
      ).resolves.toBe("scoped-value\n");
      expect(io.errors.join("")).toContain(
        "[progress fs/read] reading nested/AGENTS.md",
      );

      const journal = new JsonlSessionJournal({ directory: stateDirectory });
      const calls = (await journal.read("scoped-session"))
        .filter((event) => event.payload.type === "tool/call-started")
        .map((event) =>
          event.payload.type === "tool/call-started"
            ? [event.payload.call.toolId, event.payload.call.arguments]
            : [],
        );
      expect(calls.slice(0, 2)).toEqual([
        ["fs/read", { path: "nested/AGENTS.md" }],
        [
          "fs/write",
          { path: "nested/value.txt", content: "scoped-value\n" },
        ],
      ]);
    } finally {
      await Promise.all([
        rm(workspace, { recursive: true, force: true }),
        rm(stateDirectory, { recursive: true, force: true }),
      ]);
    }
  });

  it("rejects resuming a state partition against a different workspace", async () => {
    const workspaceOne = await mkdtemp(join(tmpdir(), "nervus-code-owner-one-"));
    const workspaceTwo = await mkdtemp(join(tmpdir(), "nervus-code-owner-two-"));
    const stateDirectory = await mkdtemp(join(tmpdir(), "nervus-code-owner-state-"));
    const firstModel: ModelAdapter = {
      id: "scripted/coding-owner",
      async *generate() {
        yield { type: "text-delta", delta: "created" };
        yield { type: "response-completed" };
      },
    };

    try {
      await runCodingCli(
        [
          "run",
          "--workspace",
          workspaceOne,
          "--state-dir",
          stateDirectory,
          "--session",
          "owned-session",
          "create state",
        ],
        {
          io: captureIO(),
          env: { OPENAI_MODEL: "scripted" },
          modelAdapter: firstModel,
        },
      );
      const resumeIO = captureIO();
      const forbiddenModel: ModelAdapter = {
        id: "scripted/coding-owner",
        async *generate() {
          throw new Error("model must not run for a mismatched workspace");
        },
      };
      await expect(
        runCodingCli(
          [
            "resume",
            "owned-session",
            "--workspace",
            workspaceTwo,
            "--state-dir",
            stateDirectory,
            "continue",
          ],
          {
            io: resumeIO,
            env: { OPENAI_MODEL: "scripted" },
            modelAdapter: forbiddenModel,
          },
        ),
      ).resolves.toBe(1);
      expect(resumeIO.errors.join("")).toContain(
        "state partition belongs to a different workspace",
      );
    } finally {
      await Promise.all([
        rm(workspaceOne, { recursive: true, force: true }),
        rm(workspaceTwo, { recursive: true, force: true }),
        rm(stateDirectory, { recursive: true, force: true }),
      ]);
    }
  });

  it("assembles Model, Capabilities, and AgentSpec from a strict Profile without persisting secrets", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nervus-code-profile-workspace-"));
    const stateDirectory = await mkdtemp(join(tmpdir(), "nervus-code-profile-state-"));
    const profileDirectory = await mkdtemp(join(tmpdir(), "nervus-code-profiles-"));
    const profile = join(profileDirectory, "coding.yaml");
    await writeFile(profile, `profileVersion: 2
id: coding-profile
host:
  type: nervus-code
  options: {}
capabilities:
  roots: []
  select: [nervus/filesystem, nervus/openai-compatible]
  configure:
    nervus/filesystem:
      root:
        $runtime: workspace
    nervus/openai-compatible:
      baseUrl: https://example.invalid
      apiKey:
        $env: API_KEY
agent:
  id: coding-profile-agent
  model:
    adapter: scripted/coding-profile
    name: profile-model
  tools: [fs/list]
  skills: []
`, "utf8");
    const io = captureIO();
    const model: ModelAdapter = {
      id: "scripted/coding-profile",
      async *generate(request) {
        expect(request.model).toBe("profile-model");
        expect(request.tools.map((tool) => tool.id)).toEqual(["fs/list"]);
        yield { type: "text-delta", delta: "profile assembled" };
        yield { type: "response-completed" };
      },
    };
    try {
      await expect(runCodingCli([
        "run", "--workspace", workspace, "--state-dir", stateDirectory,
        "--session", "profile-session", "--profile", profile,
        "profile task",
      ], { io, env: { OPENAI_MODEL: "ignored", API_KEY: "secret-value" }, modelAdapter: model })).resolves.toBe(0);
      const resolutionDirectory = join(stateDirectory, ".host-assembly", "resolutions");
      const [resolutionFile] = await readdir(resolutionDirectory);
      const resolution = await readFile(join(resolutionDirectory, resolutionFile!), "utf8");
      expect(resolution).toContain("coding-profile");
      expect(resolution).toContain("nervus/filesystem");
      expect(resolution).not.toContain("secret-value");
    } finally {
      await Promise.all([
        rm(workspace, { recursive: true, force: true }),
        rm(stateDirectory, { recursive: true, force: true }),
        rm(profileDirectory, { recursive: true, force: true }),
      ]);
    }
  });
});
