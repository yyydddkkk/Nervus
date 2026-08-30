import type { AgentSnapshot } from "../agents/agent.js";
import type { ContentBlock } from "../domain/content.js";
import type { ModelRequestSnapshot } from "../context/context.js";
import type { AssistantModelMessage, ToolCall } from "../models/model.js";
import type { ToolResult } from "../tools/tool.js";

export type SessionEvent =
  | { readonly type: "session/created"; readonly agentId: string }
  | {
      readonly type: "input/accepted";
      readonly inputId: string;
      readonly content: readonly ContentBlock[];
    }
  | {
      readonly type: "turn/started";
      readonly turnId: string;
      readonly inputId: string;
      readonly agent: AgentSnapshot;
    }
  | {
      readonly type: "user/message";
      readonly turnId: string;
      readonly content: readonly ContentBlock[];
    }
  | {
      readonly type: "step/started";
      readonly turnId: string;
      readonly stepId: string;
      readonly index: number;
    }
  | {
      readonly type: "model/call-started";
      readonly stepId: string;
      readonly modelCallId: string;
      readonly snapshot: ModelRequestSnapshot;
    }
  | {
      readonly type: "model/call-completed";
      readonly modelCallId: string;
      readonly content: readonly ContentBlock[];
      readonly toolCalls: readonly ToolCall[];
    }
  | {
      readonly type: "model/call-failed";
      readonly modelCallId: string;
      readonly error: string;
    }
  | {
      readonly type: "assistant/message";
      readonly stepId: string;
      readonly message: AssistantModelMessage;
    }
  | {
      readonly type: "tool/call-started";
      readonly stepId: string;
      readonly call: ToolCall;
    }
  | {
      readonly type: "tool/call-completed";
      readonly stepId: string;
      readonly result: ToolResult;
    }
  | {
      readonly type: "skill/activated";
      readonly turnId: string;
      readonly skillId: string;
    }
  | {
      readonly type: "step/completed";
      readonly turnId: string;
      readonly stepId: string;
    }
  | {
      readonly type: "turn/completed";
      readonly turnId: string;
      readonly output: readonly ContentBlock[];
    }
  | {
      readonly type: "turn/cancelled";
      readonly turnId: string;
      readonly reason: string;
    }
  | {
      readonly type: "turn/failed";
      readonly turnId: string;
      readonly error: string;
    }
  | {
      readonly type: "turn/interrupted";
      readonly turnId: string;
      readonly reason: string;
    }
  | { readonly type: "turn/exhausted"; readonly turnId: string };

export interface SessionEventEnvelope<
  T extends SessionEvent = SessionEvent,
> {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: T["type"];
  readonly payload: T;
}
