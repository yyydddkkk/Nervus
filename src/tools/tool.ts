import { Service, type Context } from "cordis";
import Ajv, { type ValidateFunction } from "ajv";

import type { ContentBlock } from "../domain/content.js";
import { Semaphore } from "../kernel/semaphore.js";
import { KernelError } from "../kernel/error.js";
import { LeasedRegistry } from "../kernel/leased-registry.js";
import type { ToolCall } from "../models/model.js";

export interface ToolExecutionContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly callId: string;
  readonly signal: AbortSignal;
  reportProgress(content: readonly ContentBlock[]): void;
}

export type ToolInvocationContext = Omit<
  ToolExecutionContext,
  "reportProgress"
>;

export interface ToolProgress {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly callId: string;
  readonly toolId: string;
  readonly content: readonly ContentBlock[];
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
  readonly revision?: number;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  execute(
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}

interface RegisteredTool {
  readonly id: string;
  readonly revision?: number;
  readonly definition: ToolDefinition;
  readonly validate: ValidateFunction;
}

export class ToolsModule extends Service {
  private readonly tools = new LeasedRegistry<RegisteredTool>();
  private readonly calls: Semaphore;
  private readonly ajv = new Ajv({ allErrors: true, strict: false });

  constructor(ctx: Context, maxConcurrentCalls: number) {
    super(ctx, "tools");
    this.calls = new Semaphore(maxConcurrentCalls);
  }

  register(tool: ToolDefinition): void {
    this.ctx.effect(() => {
      if (this.tools.contains(tool.id)) {
        throw new KernelError(
          "REGISTRATION_CONFLICT",
          `Tool is already registered: ${tool.id}`,
        );
      }

      const registered: RegisteredTool = {
        id: tool.id,
        ...(tool.revision === undefined ? {} : { revision: tool.revision }),
        definition: tool,
        validate: this.ajv.compile(tool.inputSchema),
      };
      return this.tools.register(registered);
    });
  }

  has(id: string): boolean {
    return this.tools.has(id);
  }

  revision(id: string): number {
    const revision = this.tools.revision(id);
    if (revision === undefined) {
      throw new KernelError("INVARIANT_VIOLATION", `Unknown Tool: ${id}`);
    }
    return revision;
  }

  describe(id: string): ToolDefinition {
    const tool = this.tools.get(id);
    if (!tool) {
      throw new KernelError("INVARIANT_VIOLATION", `Unknown Tool: ${id}`);
    }
    return tool.definition;
  }

  hold(id: string): () => void {
    const lease = this.tools.acquire(id);
    if (!lease) {
      throw new KernelError(
        "INVARIANT_VIOLATION",
        `Tool is not available for a Turn: ${id}`,
      );
    }
    return lease.release;
  }

  async execute(
    call: ToolCall,
    context: ToolInvocationContext,
    timeoutMs: number,
  ): Promise<ToolResult> {
    const registered = this.tools.get(call.toolId);
    if (!registered) {
      throw new KernelError(
        "INVARIANT_VIOLATION",
        `Unknown Tool: ${call.toolId}`,
      );
    }
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
      const executionContext: ToolExecutionContext = {
        ...context,
        signal,
        reportProgress: (content) => {
          this.ctx.emit("tool/progress", {
            sessionId: context.sessionId,
            turnId: context.turnId,
            stepId: context.stepId,
            callId: context.callId,
            toolId: call.toolId,
            content,
          });
        },
      };
      const result = await raceWithAbort(
        tool.execute(call.arguments, executionContext),
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

  interface Events {
    "tool/progress"(progress: ToolProgress): void;
  }
}
