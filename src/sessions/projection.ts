import type { ContentBlock } from "../domain/content.js";
import type { SessionEventEnvelope } from "./events.js";

export interface TurnSnapshot {
  readonly id: string;
  readonly status:
    | "active"
    | "completed"
    | "exhausted"
    | "cancelled"
    | "failed"
    | "interrupted";
  readonly output: readonly ContentBlock[];
}

export interface SessionSnapshot {
  readonly id: string;
  readonly agentId: string;
  readonly revision: number;
  readonly pendingInputCount: number;
  readonly turnCount: number;
  readonly latestTurn: TurnSnapshot | null;
}

export interface PendingInput {
  readonly id: string;
  readonly content: readonly ContentBlock[];
}

export function projectSession(
  sessionId: string,
  events: readonly SessionEventEnvelope[],
): SessionSnapshot {
  let agentId: string | undefined;
  let turnCount = 0;
  let latestTurn: TurnSnapshot | null = null;
  const pendingInputs = new Map<string, readonly ContentBlock[]>();

  for (const envelope of events) {
    const event = envelope.payload;
    switch (event.type) {
      case "session/created":
        agentId = event.agentId;
        break;
      case "input/accepted":
        pendingInputs.set(event.inputId, event.content);
        break;
      case "turn/started":
        pendingInputs.delete(event.inputId);
        turnCount += 1;
        latestTurn = { id: event.turnId, status: "active", output: [] };
        break;
      case "turn/completed":
        latestTurn = {
          id: event.turnId,
          status: "completed",
          output: event.output,
        };
        break;
      case "turn/exhausted":
        latestTurn = {
          id: event.turnId,
          status: "exhausted",
          output: [],
        };
        break;
      case "turn/cancelled":
        latestTurn = {
          id: event.turnId,
          status: "cancelled",
          output: [],
        };
        break;
      case "turn/failed":
        latestTurn = {
          id: event.turnId,
          status: "failed",
          output: [],
        };
        break;
      case "turn/interrupted":
        latestTurn = {
          id: event.turnId,
          status: "interrupted",
          output: [],
        };
        break;
    }
  }

  if (!agentId) {
    throw new Error(`session has no creation event: ${sessionId}`);
  }

  return {
    id: sessionId,
    agentId,
    revision: events.length,
    pendingInputCount: pendingInputs.size,
    turnCount,
    latestTurn,
  };
}

export function projectPendingInputs(
  events: readonly SessionEventEnvelope[],
): readonly PendingInput[] {
  const pending = new Map<string, readonly ContentBlock[]>();
  for (const envelope of events) {
    const event = envelope.payload;
    if (event.type === "input/accepted") {
      pending.set(event.inputId, event.content);
    } else if (event.type === "turn/started") {
      pending.delete(event.inputId);
    }
  }
  return [...pending].map(([id, content]) => ({ id, content }));
}
