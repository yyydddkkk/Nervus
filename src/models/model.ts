import { Service, type Context } from "cordis";

import type { ContentBlock } from "../domain/content.js";
import { Semaphore } from "../kernel/semaphore.js";
import type { ModelRetryOptions } from "../kernel/options.js";
import { KernelError } from "../kernel/error.js";
import { LeasedRegistry } from "../kernel/leased-registry.js";

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
  readonly reasoning?: string;
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

export interface ModelCapabilities {
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly safetyMarginTokens: number;
  readonly supportsTools: boolean;
  readonly supportsImages: boolean;
  readonly countTokens?: (request: ModelRequest) => number | Promise<number>;
}

export type ModelEvent =
  | { readonly type: "text-delta"; readonly delta: string }
  | { readonly type: "reasoning-delta"; readonly delta: string }
  | { readonly type: "tool-call"; readonly call: ToolCall }
  | {
      readonly type: "usage";
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly totalTokens: number;
    }
  | {
      readonly type: "response-failed";
      readonly error: string;
      readonly retryable: boolean;
    }
  | { readonly type: "response-completed" };

export interface ModelExecutionContext {
  readonly signal: AbortSignal;
}

export interface ModelAdapter {
  readonly id: string;
  readonly revision?: number;
  readonly capabilities?: Partial<ModelCapabilities>;
  generate(
    request: ModelRequest,
    context: ModelExecutionContext,
  ): AsyncIterable<ModelEvent>;
}

export interface ModelResponse {
  readonly content: readonly ContentBlock[];
  readonly toolCalls: readonly ToolCall[];
  readonly reasoning: string;
  readonly usage?: ModelUsage;
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface ModelCallOptions extends ModelExecutionContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly modelCallId: string;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly purpose?: ModelCallPurpose;
  readonly onAttemptStarted: (attempt: number) => void | Promise<void>;
  readonly onAttemptFailed: (
    attempt: number,
    error: unknown,
    retryable: boolean,
  ) => void | Promise<void>;
}

export type ModelCallPurpose = "response" | "compaction";

export interface ModelDeltaUpdate {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly modelCallId: string;
  readonly purpose: ModelCallPurpose;
  readonly delta: string;
}

export interface ModelUsageUpdate {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly modelCallId: string;
  readonly purpose: ModelCallPurpose;
  readonly usage: ModelUsage;
}

export class ModelsModule extends Service {
  private readonly adapters = new LeasedRegistry<ModelAdapter>();
  private readonly calls: Semaphore;
  private readonly retry: ModelRetryOptions;

  constructor(
    ctx: Context,
    maxConcurrentCalls: number,
    retry: ModelRetryOptions,
  ) {
    super(ctx, "models");
    this.calls = new Semaphore(maxConcurrentCalls);
    this.retry = retry;
  }

  register(adapter: ModelAdapter): void {
    this.ctx.effect(() => {
      if (this.adapters.contains(adapter.id)) {
        throw new KernelError(
          "REGISTRATION_CONFLICT",
          `Model Adapter is already registered: ${adapter.id}`,
        );
      }

      return this.adapters.register(adapter);
    });
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  revision(id: string): number {
    const revision = this.adapters.revision(id);
    if (revision === undefined) {
      throw new KernelError(
        "INVARIANT_VIOLATION",
        `Unknown Model Adapter: ${id}`,
      );
    }
    return revision;
  }

  capabilities(id: string): ModelCapabilities {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new KernelError(
        "INVARIANT_VIOLATION",
        `Unknown Model Adapter: ${id}`,
      );
    }
    return {
      contextWindow: adapter.capabilities?.contextWindow ?? 128_000,
      maxOutputTokens: adapter.capabilities?.maxOutputTokens ?? 4_096,
      safetyMarginTokens: adapter.capabilities?.safetyMarginTokens ?? 0,
      supportsTools: adapter.capabilities?.supportsTools ?? true,
      supportsImages: adapter.capabilities?.supportsImages ?? false,
      ...(adapter.capabilities?.countTokens
        ? { countTokens: adapter.capabilities.countTokens }
        : {}),
    };
  }

  hold(id: string): () => void {
    const lease = this.adapters.acquire(id);
    if (!lease) {
      throw new KernelError(
        "INVARIANT_VIOLATION",
        `Model Adapter is not available for a Turn: ${id}`,
      );
    }
    return lease.release;
  }

  async generate(
    adapterId: string,
    request: ModelRequest,
    options: ModelCallOptions,
  ): Promise<ModelResponse> {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) {
      throw new KernelError(
        "INVARIANT_VIOLATION",
        `Unknown Model Adapter: ${adapterId}`,
      );
    }

    for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
      await options.onAttemptStarted(attempt);
      try {
        return await this.generateAttempt(adapter, request, options);
      } catch (error) {
        const retryable = isRetryableModelError(error, options.signal);
        await options.onAttemptFailed(attempt, error, retryable);
        if (!retryable || attempt === options.maxAttempts) throw error;
        const delay = Math.min(
          this.retry.maxDelayMs,
          this.retry.baseDelayMs * 2 ** (attempt - 1),
        );
        await abortableDelay(delay, options.signal);
      }
    }
    throw new KernelError(
      "INVARIANT_VIOLATION",
      "ModelCall has no available attempts",
    );
  }

  private async generateAttempt(
    adapter: ModelAdapter,
    request: ModelRequest,
    options: ModelCallOptions,
  ): Promise<ModelResponse> {
    const release = await this.calls.acquire(options.signal);

    let text = "";
    let reasoning = "";
    let usage: ModelUsage | undefined;
    let completed = false;
    const toolCalls: ToolCall[] = [];

    const timeoutController = new AbortController();
    const timer = setTimeout(() => {
      timeoutController.abort(
        new DOMException(
          `model call timed out after ${options.timeoutMs}ms`,
          "TimeoutError",
        ),
      );
    }, options.timeoutMs);
    timer.unref();
    const signal = AbortSignal.any([options.signal, timeoutController.signal]);

    const iterator = adapter.generate(request, { signal })[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await raceWithAbort(iterator.next(), signal);
        if (next.done) break;
        const event = next.value;
        switch (event.type) {
          case "text-delta":
            text += event.delta;
            this.ctx.emit("model/text-delta", modelUpdate(options, event.delta));
            break;
          case "reasoning-delta":
            reasoning += event.delta;
            this.ctx.emit(
              "model/reasoning-delta",
              modelUpdate(options, event.delta),
            );
            break;
          case "tool-call":
            toolCalls.push(event.call);
            break;
          case "usage":
            usage = {
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              totalTokens: event.totalTokens,
            };
            this.ctx.emit("model/usage", {
              sessionId: options.sessionId,
              turnId: options.turnId,
              stepId: options.stepId,
              modelCallId: options.modelCallId,
              purpose: options.purpose ?? "response",
              usage,
            });
            break;
          case "response-failed":
            throw Object.assign(new Error(event.error), {
              retryable: event.retryable,
            });
          case "response-completed":
            completed = true;
            break;
        }
      }
    } finally {
      clearTimeout(timer);
      if (signal.aborted && iterator.return) {
        void iterator.return().catch(() => undefined);
      }
      release();
    }

    if (!completed) {
      throw new KernelError(
        "INVARIANT_VIOLATION",
        `Model Adapter ended without a terminal event: ${adapter.id}`,
      );
    }

    return {
      content: text ? [{ type: "text", text }] : [],
      toolCalls,
      reasoning,
      ...(usage ? { usage } : {}),
    };
  }
}

function modelUpdate(
  options: ModelCallOptions,
  delta: string,
): ModelDeltaUpdate {
  return {
    sessionId: options.sessionId,
    turnId: options.turnId,
    stepId: options.stepId,
    modelCallId: options.modelCallId,
    purpose: options.purpose ?? "response",
    delta,
  };
}

async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function isRetryableModelError(error: unknown, turnSignal: AbortSignal): boolean {
  if (turnSignal.aborted) return false;
  if (error instanceof DOMException && error.name === "TimeoutError") return true;
  return (
    !!error &&
    typeof error === "object" &&
    "retryable" in error &&
    (error as { retryable?: unknown }).retryable === true
  );
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    timer.unref();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

declare module "cordis" {
  interface Context {
    models: ModelsModule;
  }

  interface Events {
    "model/text-delta"(update: ModelDeltaUpdate): void;
    "model/reasoning-delta"(update: ModelDeltaUpdate): void;
    "model/usage"(update: ModelUsageUpdate): void;
  }
}
