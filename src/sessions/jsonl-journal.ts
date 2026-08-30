import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";

import type { SessionEvent, SessionEventEnvelope } from "./events.js";
import type { SessionJournal } from "./journal.js";
import { KernelError } from "../kernel/error.js";

export interface JsonlSessionJournalOptions {
  readonly directory: string;
}

export class JsonlSessionJournal implements SessionJournal {
  readonly #directory: string;
  readonly #tails = new Map<string, Promise<void>>();

  constructor(options: JsonlSessionJournalOptions) {
    if (!options.directory) {
      throw new KernelError(
        "SESSION_CONFLICT",
        "JSONL SessionJournal requires an explicit directory",
      );
    }
    this.#directory = options.directory;
  }

  append(
    sessionId: string,
    expectedRevision: number,
    events: readonly SessionEvent[],
  ): Promise<readonly SessionEventEnvelope[]> {
    if (events.length === 0) {
      return Promise.reject(
        new KernelError("SESSION_CONFLICT", "Event batch must not be empty"),
      );
    }

    const previous = this.#tails.get(sessionId) ?? Promise.resolve();
    const operation = previous.then(() =>
      this.#appendUnlocked(sessionId, expectedRevision, events),
    );
    this.#tails.set(
      sessionId,
      operation.then(
        () => undefined,
        () => undefined,
      ),
    );
    return operation;
  }

  async read(sessionId: string): Promise<readonly SessionEventEnvelope[]> {
    await this.#tails.get(sessionId);
    return this.#readUnlocked(sessionId);
  }

  async #appendUnlocked(
    sessionId: string,
    expectedRevision: number,
    events: readonly SessionEvent[],
  ): Promise<readonly SessionEventEnvelope[]> {
    const current = await this.#readUnlocked(sessionId);
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
    const complete = [...current, ...appended];
    await mkdir(this.#directory, { recursive: true });

    const target = this.#pathFor(sessionId);
    const temporary = join(
      this.#directory,
      `.${this.#fileNameFor(sessionId)}.${randomUUID()}.tmp`,
    );
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(
        `${complete.map((event) => JSON.stringify(event)).join("\n")}\n`,
        "utf8",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    return appended;
  }

  async #readUnlocked(
    sessionId: string,
  ): Promise<readonly SessionEventEnvelope[]> {
    let source: string;
    try {
      source = await readFile(this.#pathFor(sessionId), "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }

    const events = source
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line, index) => parseEnvelope(line, sessionId, index + 1));
    return Object.freeze(events);
  }

  #pathFor(sessionId: string): string {
    return join(this.#directory, this.#fileNameFor(sessionId));
  }

  #fileNameFor(sessionId: string): string {
    return `${Buffer.from(sessionId, "utf8").toString("base64url")}.jsonl`;
  }
}

function parseEnvelope(
  line: string,
  sessionId: string,
  expectedSequence: number,
): SessionEventEnvelope {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object") {
    throw new KernelError(
      "INVARIANT_VIOLATION",
      `Invalid SessionEvent envelope at sequence ${expectedSequence}`,
    );
  }

  const envelope = value as Partial<SessionEventEnvelope>;
  if (
    envelope.schemaVersion !== 1 ||
    envelope.sessionId !== sessionId ||
    envelope.sequence !== expectedSequence ||
    typeof envelope.id !== "string" ||
    typeof envelope.timestamp !== "string" ||
    typeof envelope.type !== "string" ||
    !envelope.payload ||
    envelope.payload.type !== envelope.type
  ) {
    throw new KernelError(
      "INVARIANT_VIOLATION",
      `Invalid SessionEvent envelope at sequence ${expectedSequence}`,
    );
  }
  return envelope as SessionEventEnvelope;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
