import { mkdtemp, rm } from "node:fs/promises";
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
});
