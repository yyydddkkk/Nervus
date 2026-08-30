import { Service, type Context } from "cordis";

import type { AgentSnapshot } from "../agents/agent.js";
import type { ModelMessage, ModelRequest } from "../models/model.js";
import type { SessionEventEnvelope } from "../sessions/events.js";

export class ContextModule extends Service {
  constructor(ctx: Context) {
    super(ctx, "context");
  }

  assemble(
    agent: AgentSnapshot,
    events: readonly SessionEventEnvelope[],
  ): ModelRequest {
    const messages: ModelMessage[] = [];

    for (const envelope of events) {
      const event = envelope.payload;
      switch (event.type) {
        case "user/message":
          messages.push({ role: "user", content: event.content });
          break;
        case "assistant/message":
          messages.push(event.message);
          break;
        case "tool/call-completed":
          messages.push({
            role: "tool",
            callId: event.result.callId,
            toolId: event.result.toolId,
            status: event.result.status,
            content: event.result.content,
          });
          break;
      }
    }

    return {
      model: agent.model.model,
      instructions: agent.instructions,
      messages,
      tools: agent.tools.map((toolId) => {
        const tool = this.ctx.tools.describe(toolId);
        return {
          id: tool.id,
          description: tool.description,
          inputSchema: tool.inputSchema,
        };
      }),
    };
  }
}

declare module "cordis" {
  interface Context {
    context: ContextModule;
  }
}
