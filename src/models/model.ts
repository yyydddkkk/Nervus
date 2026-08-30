import { Service, type Context } from "cordis";

import type { ContentBlock } from "../domain/content.js";
import { Semaphore } from "../kernel/semaphore.js";

export interface ToolCall {
  readonly id: string;
  readonly toolId: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface ModelToolDefinition {
  readonly id: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface UserModelMessage {
  readonly role: "user";
  readonly content: readonly ContentBlock[];
}

export interface AssistantModelMessage {
  readonly role: "assistant";
  readonly content: readonly ContentBlock[];
  readonly toolCalls: readonly ToolCall[];
}

export interface ToolModelMessage {
  readonly role: "tool";
  readonly callId: string;
  readonly toolId: string;
  readonly status: "success" | "error";
  readonly content: readonly ContentBlock[];
}

export type ModelMessage =
  | UserModelMessage
  | AssistantModelMessage
  | ToolModelMessage;

export interface ModelRequest {
  readonly model: string;
  readonly instructions: readonly ContentBlock[];
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
}

export type ModelEvent =
  | { readonly type: "text-delta"; readonly delta: string }
  | { readonly type: "tool-call"; readonly call: ToolCall }
  | { readonly type: "response-completed" };

export interface ModelExecutionContext {
  readonly signal: AbortSignal;
}

export interface ModelAdapter {
  readonly id: string;
  generate(
    request: ModelRequest,
    context: ModelExecutionContext,
  ): AsyncIterable<ModelEvent>;
}

export interface ModelResponse {
  readonly content: readonly ContentBlock[];
  readonly toolCalls: readonly ToolCall[];
}

export class ModelsModule extends Service {
  private readonly adapters = new Map<string, ModelAdapter>();
  private readonly calls: Semaphore;

  constructor(ctx: Context, maxConcurrentCalls: number) {
    super(ctx, "models");
    this.calls = new Semaphore(maxConcurrentCalls);
  }

  register(adapter: ModelAdapter): void {
    this.ctx.effect(() => {
      if (this.adapters.has(adapter.id)) {
        throw new Error(`model adapter is already registered: ${adapter.id}`);
      }

      this.adapters.set(adapter.id, adapter);
      return () => {
        if (this.adapters.get(adapter.id) === adapter) {
          this.adapters.delete(adapter.id);
        }
      };
    });
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  async generate(
    adapterId: string,
    request: ModelRequest,
    context: ModelExecutionContext,
    timeoutMs: number,
  ): Promise<ModelResponse> {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) throw new Error(`unknown model adapter: ${adapterId}`);

    const release = await this.calls.acquire(context.signal);

    let text = "";
    let completed = false;
    const toolCalls: ToolCall[] = [];

    const timeoutController = new AbortController();
    const timer = setTimeout(() => {
      timeoutController.abort(
        new DOMException(
          `model call timed out after ${timeoutMs}ms`,
          "TimeoutError",
        ),
      );
    }, timeoutMs);
    timer.unref();
    const signal = AbortSignal.any([context.signal, timeoutController.signal]);

    try {
      for await (const event of adapter.generate(request, { signal })) {
        switch (event.type) {
          case "text-delta":
            text += event.delta;
            break;
          case "tool-call":
            toolCalls.push(event.call);
            break;
          case "response-completed":
            completed = true;
            break;
        }
      }
    } finally {
      clearTimeout(timer);
      release();
    }

    if (!completed) {
      throw new Error(`model adapter ended without a terminal event: ${adapterId}`);
    }

    return {
      content: text ? [{ type: "text", text }] : [],
      toolCalls,
    };
  }
}

declare module "cordis" {
  interface Context {
    models: ModelsModule;
  }
}
