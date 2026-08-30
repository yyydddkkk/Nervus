import { Service, type Context } from "cordis";
import Ajv, { type ValidateFunction } from "ajv";

import type { ContentBlock } from "../domain/content.js";
import { Semaphore } from "../kernel/semaphore.js";
import type { ToolCall } from "../models/model.js";

export interface ToolExecutionContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly callId: string;
  readonly signal: AbortSignal;
}

export interface ToolExecutionResult {
  readonly status: "success" | "error";
  readonly content: readonly ContentBlock[];
}

export interface ToolResult extends ToolExecutionResult {
  readonly callId: string;
  readonly toolId: string;
}

export interface ToolDefinition {
  readonly id: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  execute(
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}

interface RegisteredTool {
  readonly definition: ToolDefinition;
  readonly validate: ValidateFunction;
}

export class ToolsModule extends Service {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly calls: Semaphore;
  private readonly ajv = new Ajv({ allErrors: true, strict: false });

  constructor(ctx: Context, maxConcurrentCalls: number) {
    super(ctx, "tools");
    this.calls = new Semaphore(maxConcurrentCalls);
  }

  register(tool: ToolDefinition): void {
    this.ctx.effect(() => {
      if (this.tools.has(tool.id)) {
        throw new Error(`tool is already registered: ${tool.id}`);
      }

      const registered: RegisteredTool = {
        definition: tool,
        validate: this.ajv.compile(tool.inputSchema),
      };
      this.tools.set(tool.id, registered);
      return () => {
        if (this.tools.get(tool.id) === registered) {
          this.tools.delete(tool.id);
        }
      };
    });
  }

  has(id: string): boolean {
    return this.tools.has(id);
  }

  describe(id: string): ToolDefinition {
    const tool = this.tools.get(id);
    if (!tool) throw new Error(`unknown tool: ${id}`);
    return tool.definition;
  }

  async execute(
    call: ToolCall,
    context: ToolExecutionContext,
    timeoutMs: number,
  ): Promise<ToolResult> {
    const registered = this.tools.get(call.toolId);
    if (!registered) throw new Error(`unknown tool: ${call.toolId}`);
    if (!registered.validate(call.arguments)) {
      return {
        callId: call.id,
        toolId: call.toolId,
        status: "error",
        content: [
          {
            type: "text",
            text: `invalid tool arguments: ${this.ajv.errorsText(registered.validate.errors)}`,
          },
        ],
      };
    }

    const tool = registered.definition;
    const release = await this.calls.acquire(context.signal);
    const timeoutController = new AbortController();
    const timer = setTimeout(() => {
      timeoutController.abort(
        new DOMException(
          `tool call timed out after ${timeoutMs}ms`,
          "TimeoutError",
        ),
      );
    }, timeoutMs);
    timer.unref();
    const signal = AbortSignal.any([context.signal, timeoutController.signal]);

    try {
      const result = await raceWithAbort(
        tool.execute(call.arguments, { ...context, signal }),
        signal,
      );
      return {
        callId: call.id,
        toolId: call.toolId,
        ...result,
      };
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason;
      return {
        callId: call.id,
        toolId: call.toolId,
        status: "error",
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    } finally {
      clearTimeout(timer);
      release();
    }
  }
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

declare module "cordis" {
  interface Context {
    tools: ToolsModule;
  }
}
