import { Service, type Context } from "cordis";

import type { ContentBlock } from "../domain/content.js";
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

export class ToolsModule extends Service {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(ctx: Context) {
    super(ctx, "tools");
  }

  register(tool: ToolDefinition): void {
    this.ctx.effect(() => {
      if (this.tools.has(tool.id)) {
        throw new Error(`tool is already registered: ${tool.id}`);
      }

      this.tools.set(tool.id, tool);
      return () => {
        if (this.tools.get(tool.id) === tool) {
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
    return tool;
  }

  async execute(
    call: ToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const tool = this.describe(call.toolId);

    try {
      const result = await tool.execute(call.arguments, context);
      return {
        callId: call.id,
        toolId: call.toolId,
        ...result,
      };
    } catch (error) {
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
    }
  }
}

declare module "cordis" {
  interface Context {
    tools: ToolsModule;
  }
}
