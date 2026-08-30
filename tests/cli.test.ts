import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    await writeFile(profile, `profileVersion: 1\nid: generic-profile\nhost:\n  type: nervus-cli\n  options: {}\ncapabilities:\n  roots: []\n  select: [nervus/filesystem]\n  configure:\n    nervus/filesystem:\n      root:\n        $runtime: workspace\nmodel:\n  name: generic-profile-model\nagent:\n  tools: [fs/list]\n  skills: []\n`, "utf8");
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
      const resolution = await readFile(join(workspace, ".nervus", "sessions", "profile-resolution.json"), "utf8");
      expect(resolution).toContain("generic-profile");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
