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
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`,
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
        type: "usage",
        inputTokens: 5,
        outputTokens: 2,
        totalTokens: 7,
      },
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

  it("supports a system instruction role and DeepSeek reasoning deltas", async () => {
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: readonly { role: string; content?: string }[];
      };
      expect(body.messages[0]).toEqual({
        role: "system",
        content: "Use DeepSeek-compatible instructions.",
      });
      const events = [
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "reason" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: "answer" } }] })}\n\n`,
        "data: [DONE]\n\n",
      ].join("");
      return new Response(splitStream(events), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    const adapter = new OpenAICompatibleChatAdapter({
      id: "deepseek/test",
      baseUrl: "https://api.deepseek.com",
      apiKey: "test-key",
      instructionRole: "system",
      fetch,
    });
    const request: ModelRequest = {
      model: "deepseek-v4-flash",
      instructions: [
        { type: "text", text: "Use DeepSeek-compatible instructions." },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ],
      tools: [],
    };

    const events = [];
    for await (const event of adapter.generate(request, {
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "reasoning-delta", delta: "reason" },
      { type: "text-delta", delta: "answer" },
      { type: "response-completed" },
    ]);
  });

  it("replays assistant reasoning for DeepSeek thinking-mode ToolCalls", async () => {
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        thinking?: { type: string };
        reasoning_effort?: string;
        messages: readonly Record<string, unknown>[];
      };
      expect(body.thinking).toEqual({ type: "enabled" });
      expect(body.reasoning_effort).toBe("high");
      expect(body.messages[0]).toMatchObject({
        role: "assistant",
        content: "",
        reasoning_content: "I need to call the tool.",
      });
      return new Response(splitStream("data: [DONE]\n\n"), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    const adapter = new OpenAICompatibleChatAdapter({
      id: "deepseek/replay",
      baseUrl: "https://api.deepseek.com",
      apiKey: "test-key",
      compatibility: "deepseek",
      extraBody: {
        thinking: { type: "enabled" },
        reasoning_effort: "high",
      },
      fetch,
    });
    const request: ModelRequest = {
      model: "deepseek-v4-flash",
      instructions: [],
      messages: [
        {
          role: "assistant",
          content: [],
          reasoning: "I need to call the tool.",
          toolCalls: [
            {
              id: "call-1",
              toolId: "test/tool",
              arguments: {},
            },
          ],
        },
        {
          role: "tool",
          callId: "call-1",
          toolId: "test/tool",
          status: "success",
          content: [{ type: "text", text: "tool result" }],
        },
      ],
      tools: [
        {
          id: "test/tool",
          description: "Test tool.",
          inputSchema: { type: "object" },
        },
      ],
    };

    const events = [];
    for await (const event of adapter.generate(request, {
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }
    expect(events).toEqual([{ type: "response-completed" }]);
  });
});
