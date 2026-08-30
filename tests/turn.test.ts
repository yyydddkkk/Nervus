import type { Plugin } from "cordis";
import { describe, expect, it } from "vitest";

import {
  createKernel,
  type ModelAdapter,
  type ModelRequest,
  type ToolDefinition,
} from "../src/index.js";

function hasToolResult(request: ModelRequest): boolean {
  return request.messages.some((message) => {
    if (message.role !== "tool") return false;
    return message.content.some(
      (block) => block.type === "text" && block.text === "42",
    );
  });
}

describe("Turn", () => {
  it("completes an Input after the model consumes one ToolResult", async () => {
    const model: ModelAdapter = {
      id: "scripted/test",
      async *generate(request) {
        if (!hasToolResult(request)) {
          yield {
            type: "tool-call",
            call: {
              id: "call-double-21",
              toolId: "math/double",
              arguments: { value: 21 },
            },
          };
        } else {
          yield {
            type: "text-delta",
            delta: "The answer is 42.",
          };
        }

        yield { type: "response-completed" };
      },
    };

    const tool: ToolDefinition = {
      id: "math/double",
      description: "Double a number.",
      inputSchema: {
        type: "object",
        properties: {
          value: { type: "number" },
        },
        required: ["value"],
        additionalProperties: false,
      },
      async execute(input) {
        const { value } = input as { value: number };
        return {
          status: "success",
          content: [{ type: "text", text: String(value * 2) }],
        };
      },
    };

    const capabilities: Plugin.Object<void> = {
      name: "test/capabilities",
      inject: ["models", "tools"],
      apply(ctx) {
        ctx.models.register(model);
        ctx.tools.register(tool);
      },
    };

    const kernel = await createKernel({ plugins: [capabilities] });

    try {
      const agent = await kernel.createAgent({
        id: "calculator",
        model: { adapter: "scripted/test", model: "scripted" },
        tools: ["math/double"],
      });
      const session = await kernel.createSession({
        id: "session-1",
        agentId: agent.id,
      });

      const result = await session.send({
        content: [{ type: "text", text: "Double 21." }],
      });

      expect(result.status).toBe("completed");
      expect(result.output).toEqual([
        { type: "text", text: "The answer is 42." },
      ]);
      expect(await session.snapshot()).toMatchObject({
        id: "session-1",
        agentId: "calculator",
        pendingInputCount: 0,
        turnCount: 1,
        latestTurn: {
          id: result.turnId,
          status: "completed",
          output: [{ type: "text", text: "The answer is 42." }],
        },
      });
    } finally {
      await kernel.dispose();
    }
  });
});
