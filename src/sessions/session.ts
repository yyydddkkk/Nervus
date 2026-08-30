import { randomUUID } from "node:crypto";

import { Service, type Context } from "cordis";

import type { AgentSnapshot } from "../agents/agent.js";
import type { ContentBlock } from "../domain/content.js";
import type { AssistantModelMessage } from "../models/model.js";
import type { SessionEvent, SessionEventEnvelope } from "./events.js";
import {
  MemorySessionJournal,
  type SessionJournal,
} from "./journal.js";
import { projectSession, type SessionSnapshot } from "./projection.js";

export interface SessionInput {
  readonly content: readonly ContentBlock[];
}

export interface TurnResult {
  readonly turnId: string;
  readonly status: "completed" | "exhausted";
  readonly output: readonly ContentBlock[];
}

export interface CreateSessionOptions {
  readonly id: string;
  readonly agentId: string;
}

export class Session {
  readonly id: string;
  readonly agentId: string;
  readonly #ctx: Context;
  readonly #journal: SessionJournal;
  #revision: number;

  constructor(
    ctx: Context,
    options: CreateSessionOptions,
    journal: SessionJournal,
    revision: number,
  ) {
    this.#ctx = ctx;
    this.id = options.id;
    this.agentId = options.agentId;
    this.#journal = journal;
    this.#revision = revision;
  }

  async send(input: SessionInput): Promise<TurnResult> {
    const inputId = randomUUID();
    const turnId = randomUUID();
    const agent = this.#ctx.agents.get(this.agentId).createSnapshot();

    await this.#append({
      type: "input/accepted",
      inputId,
      content: input.content,
    });
    await this.#append(
      { type: "turn/started", turnId, inputId, agent },
      { type: "user/message", turnId, content: input.content },
    );

    let toolCallCount = 0;
    for (let index = 1; index <= agent.limits.maxSteps; index += 1) {
      const stepId = randomUUID();
      const modelCallId = randomUUID();
      await this.#append({
        type: "step/started",
        turnId,
        stepId,
        index,
      });

      const request = this.#ctx.context.assemble(
        agent,
        await this.#journal.read(this.id),
      );
      await this.#append({
        type: "model/call-started",
        stepId,
        modelCallId,
        request,
      });

      const response = await this.#ctx.models.generate(
        agent.model.adapter,
        request,
      );
      const assistantMessage: AssistantModelMessage = {
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
      };
      await this.#append(
        {
          type: "model/call-completed",
          modelCallId,
          content: response.content,
          toolCalls: response.toolCalls,
        },
        { type: "assistant/message", stepId, message: assistantMessage },
      );

      if (response.toolCalls.length === 0) {
        await this.#append(
          { type: "step/completed", turnId, stepId },
          { type: "turn/completed", turnId, output: response.content },
        );
        return {
          turnId,
          status: "completed",
          output: response.content,
        };
      }

      toolCallCount += response.toolCalls.length;
      if (
        response.toolCalls.length > agent.limits.maxToolCallsPerStep ||
        toolCallCount > agent.limits.maxToolCalls
      ) {
        await this.#append({ type: "turn/exhausted", turnId });
        return { turnId, status: "exhausted", output: [] };
      }

      await this.#append(
        ...response.toolCalls.map<SessionEvent>((call) => ({
          type: "tool/call-started",
          stepId,
          call,
        })),
      );
      const controller = new AbortController();
      const results = await Promise.all(
        response.toolCalls.map((call) =>
          this.#ctx.tools.execute(call, {
            sessionId: this.id,
            turnId,
            stepId,
            callId: call.id,
            signal: controller.signal,
          }),
        ),
      );
      await this.#append(
        ...results.map<SessionEvent>((result) => ({
          type: "tool/call-completed",
          stepId,
          result,
        })),
        { type: "step/completed", turnId, stepId },
      );
    }

    await this.#append({ type: "turn/exhausted", turnId });
    return { turnId, status: "exhausted", output: [] };
  }

  async events(): Promise<readonly SessionEventEnvelope[]> {
    return this.#journal.read(this.id);
  }

  async snapshot(): Promise<SessionSnapshot> {
    return projectSession(this.id, await this.#journal.read(this.id));
  }

  async #append(...events: readonly SessionEvent[]): Promise<void> {
    const appended = await this.#journal.append(
      this.id,
      this.#revision,
      events,
    );
    this.#revision += appended.length;
  }
}

export class SessionsModule extends Service {
  private readonly sessions = new Map<string, Session>();
  private readonly journal: SessionJournal;

  constructor(ctx: Context, journal: SessionJournal = new MemorySessionJournal()) {
    super(ctx, "sessions");
    this.journal = journal;
  }

  async create(options: CreateSessionOptions): Promise<Session> {
    if (this.sessions.has(options.id)) {
      throw new Error(`session is already open: ${options.id}`);
    }
    this.ctx.agents.get(options.agentId);

    const existing = await this.journal.read(options.id);
    if (existing.length > 0) {
      throw new Error(`session already exists: ${options.id}`);
    }

    const created = await this.journal.append(options.id, 0, [
      { type: "session/created", agentId: options.agentId },
    ]);
    const session = new Session(
      this.ctx,
      options,
      this.journal,
      created.length,
    );
    this.sessions.set(options.id, session);
    return session;
  }
}

declare module "cordis" {
  interface Context {
    sessions: SessionsModule;
  }
}
