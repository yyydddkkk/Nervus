import type { ContentBlock } from "../domain/content.js";
import type {
  ModelAdapter,
  ModelCapabilities,
  ModelEvent,
  ModelExecutionContext,
  ModelMessage,
  ModelRequest,
  ToolCall,
} from "../models/model.js";

export interface OpenAICompatibleChatAdapterOptions {
  readonly id: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly headers?: RequestInit["headers"];
  readonly fetch?: typeof globalThis.fetch;
  readonly capabilities?: Partial<ModelCapabilities>;
  readonly instructionRole?: "developer" | "system";
  readonly compatibility?: "openai" | "deepseek";
  readonly extraBody?: Readonly<Record<string, unknown>>;
}

export class OpenAICompatibleError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(status: number, message: string) {
    super(message);
    this.name = "OpenAICompatibleError";
    this.status = status;
    this.retryable =
      status === 408 || status === 409 || status === 429 || status >= 500;
  }
}

export class OpenAICompatibleChatAdapter implements ModelAdapter {
  readonly id: string;
  readonly capabilities?: Partial<ModelCapabilities>;
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #headers: RequestInit["headers"] | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #instructionRole: "developer" | "system";
  readonly #replayReasoningContent: boolean;
  readonly #requireAssistantContent: boolean;
  readonly #extraBody: Readonly<Record<string, unknown>>;

  constructor(options: OpenAICompatibleChatAdapterOptions) {
    this.id = options.id;
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#apiKey = options.apiKey;
    this.#headers = options.headers;
    this.#fetch = options.fetch ?? globalThis.fetch;
    const deepSeekCompatible = options.compatibility === "deepseek";
    this.#instructionRole =
      options.instructionRole ?? (deepSeekCompatible ? "system" : "developer");
    this.#replayReasoningContent = deepSeekCompatible;
    this.#requireAssistantContent = deepSeekCompatible;
    this.#extraBody = options.extraBody ?? {};
    if (options.capabilities) this.capabilities = options.capabilities;
  }

  async *generate(
    request: ModelRequest,
    context: ModelExecutionContext,
  ): AsyncIterable<ModelEvent> {
    const toolNames = createToolNameMap(request);
    const headers = new Headers(this.#headers);
    headers.set("content-type", "application/json");
    if (this.#apiKey) headers.set("authorization", `Bearer ${this.#apiKey}`);

    const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      signal: context.signal,
      body: JSON.stringify({
        ...this.#extraBody,
        model: request.model,
        stream: true,
        stream_options: { include_usage: true },
        messages: toChatMessages(
          request,
          toolNames.byId,
          this.#instructionRole,
          this.#replayReasoningContent,
          this.#requireAssistantContent,
        ),
        tools: request.tools.map((tool) => ({
          type: "function",
          function: {
            name: toolNames.byId.get(tool.id),
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })),
      }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new OpenAICompatibleError(
        response.status,
        `Chat Completions request failed (${response.status}): ${detail}`,
      );
    }
    if (!response.body) {
      throw new OpenAICompatibleError(
        response.status,
        "Chat Completions response has no stream body",
      );
    }

    const pending = new Map<number, PendingToolCall>();
    let completed = false;
    for await (const data of readSseData(response.body, context.signal)) {
      if (data === "[DONE]") {
        for (const [index, call] of [...pending].sort(
          ([left], [right]) => left - right,
        )) {
          yield {
            type: "tool-call",
            call: finishToolCall(index, call, toolNames.byWire),
          };
        }
        yield { type: "response-completed" };
        completed = true;
        break;
      }

      const chunk = JSON.parse(data) as ChatCompletionChunk;
      if (chunk.usage) {
        yield {
          type: "usage",
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
          totalTokens: chunk.usage.total_tokens,
        };
      }
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.reasoning_content) {
        yield {
          type: "reasoning-delta",
          delta: delta.reasoning_content,
        };
      }
      if (delta?.content) yield { type: "text-delta", delta: delta.content };
      for (const partial of delta?.tool_calls ?? []) {
        const call = pending.get(partial.index) ?? { arguments: "" };
        if (partial.id) call.id = partial.id;
        if (partial.function?.name) call.wireName = partial.function.name;
        if (partial.function?.arguments) {
          call.arguments += partial.function.arguments;
        }
        pending.set(partial.index, call);
      }
    }

    if (!completed) {
      throw new Error("Chat Completions stream ended without [DONE]");
    }
  }
}

interface ToolNameMap {
  readonly byId: ReadonlyMap<string, string>;
  readonly byWire: ReadonlyMap<string, string>;
}

interface PendingToolCall {
  id?: string;
  wireName?: string;
  arguments: string;
}

interface ChatCompletionChunk {
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens: number;
  } | null;
  readonly choices?: readonly {
    readonly delta?: {
      readonly content?: string | null;
      readonly reasoning_content?: string | null;
      readonly tool_calls?: readonly {
        readonly index: number;
        readonly id?: string;
        readonly function?: {
          readonly name?: string;
          readonly arguments?: string;
        };
      }[];
    };
  }[];
}

function createToolNameMap(request: ModelRequest): ToolNameMap {
  const byId = new Map<string, string>();
  const byWire = new Map<string, string>();
  request.tools.forEach((tool, index) => {
    const wireName = `nervus_tool_${index}`;
    byId.set(tool.id, wireName);
    byWire.set(wireName, tool.id);
  });
  return { byId, byWire };
}

function toChatMessages(
  request: ModelRequest,
  toolNames: ReadonlyMap<string, string>,
  instructionRole: "developer" | "system",
  replayReasoningContent: boolean,
  requireAssistantContent: boolean,
): readonly Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  if (request.instructions.length > 0) {
    messages.push({
      role: instructionRole,
      content: contentToText(request.instructions),
    });
  }
  messages.push(
    ...request.messages.map((message) =>
      toChatMessage(
        message,
        toolNames,
        replayReasoningContent,
        requireAssistantContent,
      ),
    ),
  );
  return messages;
}

function toChatMessage(
  message: ModelMessage,
  toolNames: ReadonlyMap<string, string>,
  replayReasoningContent: boolean,
  requireAssistantContent: boolean,
): Record<string, unknown> {
  if (message.role === "user") {
    return { role: "user", content: contentToText(message.content) };
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.callId,
      content: contentToText(message.content),
    };
  }
  const content = contentToText(message.content);
  const assistantContent =
    content.length > 0
      ? content
      : requireAssistantContent && message.toolCalls.length > 0
        ? ""
        : null;
  return {
    role: "assistant",
    content: assistantContent,
    ...(replayReasoningContent && message.reasoning
      ? { reasoning_content: message.reasoning }
      : {}),
    tool_calls: message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: toolNames.get(call.toolId) ?? encodeFallbackToolName(call.toolId),
        arguments: JSON.stringify(call.arguments),
      },
    })),
  };
}

function contentToText(content: readonly ContentBlock[]): string {
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "json") return JSON.stringify(block.value);
      return block.uri;
    })
    .join("\n");
}

function encodeFallbackToolName(toolId: string): string {
  return `nervus_${Buffer.from(toolId, "utf8").toString("base64url").slice(0, 55)}`;
}

function finishToolCall(
  index: number,
  pending: PendingToolCall,
  toolNames: ReadonlyMap<string, string>,
): ToolCall {
  if (!pending.id || !pending.wireName) {
    throw new Error(`incomplete streamed ToolCall at index ${index}`);
  }
  const toolId = toolNames.get(pending.wireName);
  if (!toolId) {
    throw new Error(`unknown streamed Tool name: ${pending.wireName}`);
  }
  const parsed: unknown = JSON.parse(pending.arguments || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`ToolCall arguments must be a JSON object: ${pending.id}`);
  }
  return {
    id: pending.id,
    toolId,
    arguments: parsed as Record<string, unknown>,
  };
}

async function* readSseData(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) yield data;
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}
