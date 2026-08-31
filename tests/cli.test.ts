import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  runNervusCli,
  ScriptedModelAdapter,
  type CliIO,
  type ModelAdapter,
} from "../src/index.js";

function deferred(): {
  readonly promise: Promise<void>;
  resolve(): void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function captureIO(): CliIO & {
  readonly output: string[];
  readonly errors: string[];
} {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    write(text) {
      output.push(text);
    },
    writeError(text) {
      errors.push(text);
    },
    async *readLines() {
      // One-shot tests do not enter interactive mode.
    },
    onInterrupt() {
      return () => undefined;
    },
  };
}

describe("Nervus CLI", () => {
  it("creates, resumes, lists, and inspects a durable Session", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nervus-cli-"));
    const sessionId = "cli-session";

    try {
      const firstIO = captureIO();
      const firstExit = await runNervusCli(
        [
          "--",
          "chat",
          "--workspace",
          workspace,
          "--session",
          sessionId,
          "first input",
        ],
        {
          io: firstIO,
          modelAdapter: new ScriptedModelAdapter({
            id: "scripted/cli",
            steps: [
              [
                { type: "text-delta", delta: "first answer" },
                { type: "response-completed" },
              ],
            ],
          }),
        },
      );
      expect(firstExit).toBe(0);
      expect(firstIO.output.join("")).toContain("first answer");

      const resumeIO = captureIO();
      const resumeExit = await runNervusCli(
        [
          "sessions",
          "resume",
          sessionId,
          "--workspace",
          workspace,
          "second input",
        ],
        {
          io: resumeIO,
          modelAdapter: new ScriptedModelAdapter({
            id: "scripted/cli",
            steps: [
              [
                { type: "text-delta", delta: "second answer" },
                { type: "response-completed" },
              ],
            ],
          }),
        },
      );
      expect(resumeExit).toBe(0);
      expect(resumeIO.output.join("")).toContain("second answer");

      const listIO = captureIO();
      expect(
        await runNervusCli(
          ["sessions", "list", "--workspace", workspace],
          { io: listIO },
        ),
      ).toBe(0);
      expect(listIO.output.join("")).toContain(sessionId);

      const inspectIO = captureIO();
      expect(
        await runNervusCli(
          ["sessions", "inspect", sessionId, "--workspace", workspace],
          { io: inspectIO },
        ),
      ).toBe(0);
      const inspected = JSON.parse(inspectIO.output.join("")) as {
        snapshot: {
          id: string;
          turnCount: number;
          latestTurn: { status: string };
        };
      };
      expect(inspected.snapshot).toMatchObject({
        id: sessionId,
        turnCount: 2,
        latestTurn: { status: "completed" },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("cancels the active Turn on interrupt and keeps the CLI Session usable", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nervus-cli-cancel-"));
    const started = deferred();
    let interrupt: (() => void) | undefined;
    const output: string[] = [];
    const errors: string[] = [];
    const io: CliIO = {
      write(text) {
        output.push(text);
      },
      writeError(text) {
        errors.push(text);
      },
      async *readLines() {
        yield "wait";
        yield "/exit";
      },
      onInterrupt(handler) {
        interrupt = handler;
        return () => {
          interrupt = undefined;
        };
      },
    };
    const model: ModelAdapter = {
      id: "scripted/cli-cancel",
      async *generate(_request, context) {
        started.resolve();
        await new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(context.signal.reason);
          if (context.signal.aborted) onAbort();
          else context.signal.addEventListener("abort", onAbort, { once: true });
        });
      },
    };

    try {
      const running = runNervusCli(
        [
          "chat",
          "--workspace",
          workspace,
          "--session",
          "cancel-session",
        ],
        { io, modelAdapter: model },
      );
      await started.promise;
      interrupt?.();
      await expect(running).resolves.toBe(0);
      expect(errors.join("")).toContain("cancelled active Turn");

      const inspectIO = captureIO();
      await runNervusCli(
        ["sessions", "inspect", "cancel-session", "--workspace", workspace],
        { io: inspectIO },
      );
      const inspected = JSON.parse(inspectIO.output.join("")) as {
        snapshot: { latestTurn: { status: string } };
      };
      expect(inspected.snapshot.latestTurn.status).toBe("cancelled");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("hides internal Compaction text from the user-facing stream", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nervus-cli-compact-"));
    const firstInput = "A".repeat(52);
    const secondInput = "C".repeat(80);
    const capabilities = { contextWindow: 8_270, maxOutputTokens: 10 };

    try {
      await expect(
        runNervusCli(
          ["chat", "--workspace", workspace, "--session", "compact", firstInput],
          {
            io: captureIO(),
            modelAdapter: {
              id: "scripted/cli-compaction",
              capabilities,
              async *generate() {
                yield { type: "text-delta", delta: "B".repeat(52) };
                yield { type: "response-completed" };
              },
            },
          },
        ),
      ).resolves.toBe(0);

      const io = captureIO();
      const model: ModelAdapter = {
        id: "scripted/cli-compaction",
        capabilities,
        async *generate(request) {
          const compacting = request.instructions.some(
            (block) =>
              block.type === "text" &&
              block.text.includes("Summarize this history"),
          );
          yield {
            type: "text-delta",
            delta: compacting ? "private internal summary" : "visible answer",
          };
          yield { type: "response-completed" };
        },
      };
      await expect(
        runNervusCli(
          [
            "sessions",
            "resume",
            "compact",
            "--workspace",
            workspace,
            secondInput,
          ],
          { io, modelAdapter: model },
        ),
      ).resolves.toBe(0);

      expect(io.output.join("")).toContain("visible answer");
      expect(io.output.join("")).not.toContain("private internal summary");
      expect(io.errors.join("")).toContain("[compacting history]");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("assembles the generic Host from a strict Profile", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nervus-cli-profile-"));
    const profile = join(workspace, "profile.yaml");
    await writeFile(profile, `profileVersion: 2
id: generic-profile
host:
  type: nervus-cli
  options: {}
capabilities:
  roots: []
  select: [nervus/filesystem]
  configure:
    nervus/filesystem:
      root:
        $runtime: workspace
agent:
  id: generic-profile-agent
  model:
    adapter: scripted/cli-profile
    name: generic-profile-model
  tools: [fs/list]
state:
  journal:
    kind: jsonl
    directory: ${JSON.stringify(join(workspace, ".nervus", "sessions"))}
`, "utf8");
    const io = captureIO();
    const model: ModelAdapter = {
      id: "scripted/cli-profile",
      async *generate(request) {
        expect(request.model).toBe("generic-profile-model");
        expect(request.tools.map((tool) => tool.id)).toEqual(["fs/list"]);
        yield { type: "text-delta", delta: "generic profile" };
        yield { type: "response-completed" };
      },
    };
    try {
      await expect(runNervusCli([
        "chat", "--workspace", workspace, "--session", "generic-profile-session",
        "--profile", profile, "profile task",
      ], { io, env: { OPENAI_MODEL: "ignored" }, modelAdapter: model })).resolves.toBe(0);
      const resolutionDirectory = join(workspace, ".nervus", "sessions", ".host-assembly", "resolutions");
      const [resolutionFile] = await readdir(resolutionDirectory);
      const resolution = await readFile(join(resolutionDirectory, resolutionFile!), "utf8");
      expect(resolution).toContain("generic-profile");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("validates, explains, and runs a Profile without a workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "nervus-cli-profile-command-"));
    const profile = join(root, "agent.yaml");
    await writeFile(profile, `profileVersion: 2
id: remote-agent
host:
  type: nervus-cli
  options: {}
capabilities:
  roots: []
  select: []
  configure: {}
agent:
  id: remote-agent
  model:
    adapter: scripted/remote
    name: remote-model
  instructions: Remote only
state:
  journal:
    kind: memory
`, "utf8");
    const model = new ScriptedModelAdapter({
      id: "scripted/remote",
      steps: [[{ type: "text-delta", delta: "remote answer" }, { type: "response-completed" }]],
    });
    try {
      const validateIO = captureIO();
      expect(await runNervusCli(["profiles", "validate", profile], { io: validateIO, modelAdapter: model })).toBe(0);
      expect(JSON.parse(validateIO.output.join(""))).toMatchObject({
        profile: { profileId: "remote-agent", resolved: false },
      });

      const explainIO = captureIO();
      expect(await runNervusCli(["profiles", "explain", profile, "--json"], { io: explainIO, modelAdapter: model })).toBe(0);
      expect(JSON.parse(explainIO.output.join(""))).toMatchObject({
        agent: { id: "remote-agent", model: { name: "remote-model" } },
        state: { journal: "memory" },
      });

      const chatIO = captureIO();
      expect(await runNervusCli(["chat", "--profile", profile, "--json", "hello"], { io: chatIO, modelAdapter: model })).toBe(0);
      expect(JSON.parse(chatIO.output.join(""))).toMatchObject({
        turn: { status: "completed" },
      });
      expect(chatIO.errors.join("")).toContain("remote answer");

      const runIO = captureIO();
      expect(await runNervusCli(["run", "hello"], { io: runIO })).toBe(1);
      expect(runIO.output.join("")).toContain("nervus chat");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("attributes changed Profile assembly on resume and requires the Profile explicitly", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nervus-cli-profile-resume-"));
    const profile = join(workspace, "agent.yaml");
    const stateDirectory = join(workspace, ".nervus", "sessions");
    const writeProfile = (modelName: string) => writeFile(profile, `profileVersion: 2
id: evolving-profile
host:
  type: nervus-cli
  options: {}
capabilities:
  roots: []
  select: []
  configure: {}
agent:
  id: nervus-cli-agent
  model:
    adapter: scripted/evolving
    name: ${modelName}
state:
  journal:
    kind: jsonl
    directory: ${JSON.stringify(stateDirectory)}
`, "utf8");
    try {
      await writeProfile("first-model");
      const first = captureIO();
      expect(await runNervusCli([
        "chat", "--profile", profile, "--workspace", workspace,
        "--session", "evolving-session", "first",
      ], {
        io: first,
        modelAdapter: new ScriptedModelAdapter({
          id: "scripted/evolving",
          steps: [[{ type: "text-delta", delta: "first" }, { type: "response-completed" }]],
        }),
      })).toBe(0);

      await writeProfile("second-model");
      const second = captureIO();
      expect(await runNervusCli([
        "sessions", "resume", "evolving-session", "--profile", profile,
        "--workspace", workspace, "second",
      ], {
        io: second,
        modelAdapter: new ScriptedModelAdapter({
          id: "scripted/evolving",
          steps: [[{ type: "text-delta", delta: "second" }, { type: "response-completed" }]],
        }),
      })).toBe(0);
      expect(second.errors.join("")).toContain("[assembly changed");

      const missingProfile = captureIO();
      expect(await runNervusCli([
        "sessions", "resume", "evolving-session", "--workspace", workspace, "third",
      ], {
        io: missingProfile,
        modelAdapter: new ScriptedModelAdapter({ id: "scripted/evolving", steps: [] }),
      })).toBe(1);
      expect(missingProfile.errors.join("")).toContain("requires an explicit --profile");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("applies ordered Overlay data and additive Capability CLI options", async () => {
    const root = await mkdtemp(join(tmpdir(), "nervus-cli-overlay-"));
    const workspace = join(root, "workspace");
    const capabilityRoot = join(root, "capabilities");
    const packageRoot = join(capabilityRoot, "fixture-tool");
    const profile = join(root, "agent.yaml");
    const overlay = join(root, "overlay.yaml");
    await mkdir(workspace, { recursive: true });
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, "capability.json"), JSON.stringify({
      schemaVersion: 1,
      id: "fixture/tool-package",
      version: "1.0.0",
      kind: "plugin",
      entry: "./index.js",
      provides: [{ kind: "tool", id: "fixture/tool" }],
      dependencies: [],
    }), "utf8");
    await writeFile(join(packageRoot, "index.js"), `export default () => ({
  name: "fixture/tool-package",
  inject: ["tools"],
  apply(ctx) {
    ctx.tools.register({
      id: "fixture/tool",
      description: "fixture",
      inputSchema: { type: "object", additionalProperties: false },
      async execute() { return { status: "success", content: [{ type: "text", text: "ok" }] }; }
    });
  }
});
`, "utf8");
    await writeFile(profile, `profileVersion: 2
id: overlay-profile
host: { type: nervus-cli, options: {} }
capabilities: { roots: [], select: [], configure: {} }
agent:
  id: overlay-agent
  model: { adapter: scripted/overlay, name: base-model }
state: { journal: { kind: memory } }
`, "utf8");
    await writeFile(overlay, `agent:
  tools: [fixture/tool]
`, "utf8");
    const io = captureIO();
    const model: ModelAdapter = {
      id: "scripted/overlay",
      async *generate(request) {
        expect(request.model).toBe("cli-model");
        expect(request.tools.map((tool) => tool.id)).toEqual(["fixture/tool"]);
        yield { type: "text-delta", delta: "overlay ok" };
        yield { type: "response-completed" };
      },
    };
    try {
      expect(await runNervusCli([
        "chat", "--profile", profile, "--overlay", overlay,
        "--workspace", workspace, "--capability-root", capabilityRoot,
        "--capability", "fixture/tool-package", "--model", "cli-model",
        "hello",
      ], { io, modelAdapter: model })).toBe(0);
      expect(io.output.join("")).toContain("overlay ok");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
