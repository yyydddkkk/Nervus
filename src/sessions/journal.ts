import { randomUUID } from "node:crypto";

import type { SessionEvent, SessionEventEnvelope } from "./events.js";
import { KernelError } from "../kernel/error.js";

export interface SessionJournal {
  append(
    sessionId: string,
    expectedRevision: number,
    events: readonly SessionEvent[],
  ): Promise<readonly SessionEventEnvelope[]>;
  read(sessionId: string): Promise<readonly SessionEventEnvelope[]>;
  list(): Promise<readonly string[]>;
}

export class MemorySessionJournal implements SessionJournal {
  readonly #streams = new Map<string, readonly SessionEventEnvelope[]>();

  async append(
    sessionId: string,
    expectedRevision: number,
    events: readonly SessionEvent[],
  ): Promise<readonly SessionEventEnvelope[]> {
    if (events.length === 0) {
      throw new KernelError("SESSION_CONFLICT", "Event batch must not be empty");
    }

    const current = this.#streams.get(sessionId) ?? [];
    if (current.length !== expectedRevision) {
      throw new KernelError(
        "SESSION_CONFLICT",
        `session revision conflict: expected ${expectedRevision}, actual ${current.length}`,
      );
    }

    const appended = events.map<SessionEventEnvelope>((payload, index) => ({
      schemaVersion: 1,
      id: randomUUID(),
      sessionId,
      sequence: expectedRevision + index + 1,
      timestamp: new Date().toISOString(),
      type: payload.type,
      payload,
    }));
    this.#streams.set(sessionId, Object.freeze([...current, ...appended]));
    return appended;
  }

  async read(sessionId: string): Promise<readonly SessionEventEnvelope[]> {
    return this.#streams.get(sessionId) ?? [];
  }

  async list(): Promise<readonly string[]> {
    return [...this.#streams.keys()].sort();
  }
}
