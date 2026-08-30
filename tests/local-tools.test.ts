import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Plugin } from "cordis";
import { describe, expect, it } from "vitest";

import {
  createKernel,
  localToolsPlugin,
  type ModelAdapter,
} from "../src/index.js";

describe("local reference Tools", () => {
  it("writes, reads, and runs a shell command through a complete Turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "nervus-tools-"));
    const model: ModelAdapter = {
      id: "scripted/local-tools",
      async *generate(request) {
        const results = request.messages.filter(
          (message) => message.role === "tool",
        );
        if (results.length === 0) {
          yield {
            type: "tool-call",
            call: {
              id: "write-call",
              toolId: "fs/write",
              arguments: { path: "nested/example.txt", content: "hello" },
            },
          };
        } else if (results.length === 1) {
          yield {
            type: "tool-call",
            call: {
              id: "list-call",
              toolId: "fs/list",
              arguments: { path: "nested" },
            },
          };
          yield {
            type: "tool-call",
            call: {
              id: "read-call",
              toolId: "fs/read",
              arguments: { path: "nested/example.txt" },
            },
          };
          yield {
            type: "tool-call",
            call: {
              id: "shell-call",
              toolId: "shell/run",
              arguments: { command: "printf shell-ok", cwd: "." },
            },
          };
        } else {
          expect(results.map((result) => result.role === "tool" && result.status)).toEqual([
            "success",
            "success",
            "success",
            "success",
          ]);
          const read = results.find(
            (result) => result.role === "tool" && result.callId === "read-call",
          );
          expect(read?.content).toContainEqual({ type: "text", text: "hello" });
          const shell = results.find(
            (result) => result.role === "tool" && result.callId === "shell-call",
          );
          expect(shell?.content).toContainEqual({
            type: "json",
            value: {
              command: "printf shell-ok",
              cwd: ".",
              exitCode: 0,
              signal: null,
              stdout: "shell-ok",
              stderr: "",
            },
          });
          const list = results.find(
            (result) => result.role === "tool" && result.callId === "list-call",
          );
          expect(list?.content).toContainEqual({
            type: "json",
            value: {
              path: "nested",
              entries: [
                {
                  path: "nested/example.txt",
                  name: "example.txt",
                  type: "file",
                  size: 5,
                },
              ],
            },
          });
          yield { type: "text-delta", delta: "local tools complete" };
        }
        yield { type: "response-completed" };
      },
    };
    const modelPlugin: Plugin.Object<void> = {
      name: "test/local-tools-model",
      inject: ["models"],
      apply(ctx) {
        ctx.models.register(model);
      },
    };
    const kernel = await createKernel({
      plugins: [modelPlugin, localToolsPlugin({ root })],
    });

    try {
      const agent = await kernel.createAgent({
        id: "local-tools-agent",
        model: { adapter: model.id, model: "scripted" },
        tools: ["fs/read", "fs/list", "fs/write", "shell/run"],
      });
      const session = await kernel.createSession({
        id: "local-tools-session",
        agentId: agent.id,
      });

      await expect(
        session.send({ content: [{ type: "text", text: "use local tools" }] }),
      ).resolves.toMatchObject({
        status: "completed",
        output: [{ type: "text", text: "local tools complete" }],
      });
      await expect(readFile(join(root, "nested/example.txt"), "utf8")).resolves.toBe(
        "hello",
      );
    } finally {
      await kernel.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
