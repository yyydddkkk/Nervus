import { describe, expect, it } from "vitest";

import {
  OpenAICompatibleChatAdapter,
  type ModelRequest,
} from "../src/index.js";

function splitStream(source: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(source);
  const middle = Math.floor(bytes.length / 2);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, middle));
      controller.enqueue(bytes.slice(middle));
      controller.close();
    },
  });
}

describe("OpenAI-compatible Chat Completions Adapter", () => {
  it("normalizes a streamed function ToolCall split across SSE chunks", async () => {
    const fetch: typeof globalThis.fetch = async (input, init) => {
      expect(String(input)).toBe("https://example.test/v1/chat/completions");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer test-key",
      );
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        stream: boolean;
        messages: readonly { role: string; content?: string }[];
        tools: readonly {
          function: { name: string; description: string; parameters: unknown };
        }[];
      };
      expect(body).toMatchObject({
        model: "test-model",
        stream: true,
        messages: [
          { role: "developer", content: "Follow the test instructions." },
          { role: "user", content: "Double 21." },
        ],
      });
      const wireName = body.tools[0]?.function.name;
      if (!wireName) throw new Error("missing encoded Tool name");
      const events = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: wireName, arguments: '{"value":' } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "21}" } }] }, finish_reason: "tool_calls" }] })}\n\n`,
        "data: [DONE]\n\n",
      ].join("");
      return new Response(splitStream(events), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    const adapter = new OpenAICompatibleChatAdapter({
      id: "openai-compatible/test",
      baseUrl: "https://example.test/v1/",
      apiKey: "test-key",
      fetch,
    });
    const request: ModelRequest = {
      model: "test-model",
      instructions: [
        { type: "text", text: "Follow the test instructions." },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "Double 21." }] },
      ],
      tools: [
        {
          id: "math/double",
          description: "Double a number.",
          inputSchema: {
            type: "object",
            properties: { value: { type: "number" } },
            required: ["value"],
          },
        },
      ],
    };

    const events = [];
    for await (const event of adapter.generate(request, {
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text-delta", delta: "hello" },
      {
        type: "tool-call",
        call: {
          id: "call-1",
          toolId: "math/double",
          arguments: { value: 21 },
        },
      },
      { type: "response-completed" },
    ]);
  });
});
