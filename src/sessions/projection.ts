import type { ContentBlock } from "../domain/content.js";
import type { SessionEventEnvelope } from "./events.js";

export interface TurnSnapshot {
  readonly id: string;
  readonly status: "active" | "completed" | "exhausted";
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

export function projectSession(
  sessionId: string,
  events: readonly SessionEventEnvelope[],
): SessionSnapshot {
  let agentId: string | undefined;
  let turnCount = 0;
  let latestTurn: TurnSnapshot | null = null;
  const pendingInputs = new Set<string>();

  for (const envelope of events) {
    const event = envelope.payload;
    switch (event.type) {
      case "session/created":
        agentId = event.agentId;
        break;
      case "input/accepted":
        pendingInputs.add(event.inputId);
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
