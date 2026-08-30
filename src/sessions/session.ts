import { randomUUID } from "node:crypto";

import { Service, type Context } from "cordis";

import type { AgentSnapshot } from "../agents/agent.js";
import type { ContentBlock } from "../domain/content.js";
import { Semaphore } from "../kernel/semaphore.js";
import type {
  AssistantModelMessage,
  ToolCall,
} from "../models/model.js";
import type { SessionEvent, SessionEventEnvelope } from "./events.js";
import type { ToolExecutionContext, ToolResult } from "../tools/tool.js";
import {
  MemorySessionJournal,
  type SessionJournal,
} from "./journal.js";
import {
  projectPendingInputs,
  projectSession,
  type SessionSnapshot,
} from "./projection.js";

export interface SessionInput {
  readonly content: readonly ContentBlock[];
}

export interface TurnResult {
  readonly turnId: string;
  readonly status: "completed" | "exhausted" | "cancelled" | "failed";
  readonly output: readonly ContentBlock[];
}

export interface CreateSessionOptions {
  readonly id: string;
  readonly agentId: string;
}

export interface OpenSessionOptions {
  readonly id: string;
}

export class Session {
  readonly id: string;
  readonly agentId: string;
  readonly #ctx: Context;
  readonly #journal: SessionJournal;
  readonly #turns: Semaphore;
  #revision: number;
  #appendTail: Promise<void> = Promise.resolve();
  #turnTail: Promise<void> = Promise.resolve();
  readonly #scheduledInputs = new Map<string, Promise<TurnResult>>();
  #activeTurn: { readonly id: string; readonly controller: AbortController } | null =
    null;

  constructor(
    ctx: Context,
    options: CreateSessionOptions,
    journal: SessionJournal,
    revision: number,
    turns: Semaphore,
  ) {
    this.#ctx = ctx;
    this.id = options.id;
    this.agentId = options.agentId;
    this.#journal = journal;
    this.#revision = revision;
    this.#turns = turns;
  }

  async send(input: SessionInput): Promise<TurnResult> {
    const inputId = randomUUID();
    const accepted = this.#append({
      type: "input/accepted",
      inputId,
      content: input.content,
    });
    return this.#scheduleInput(inputId, input, accepted);
  }

  async resumePendingInputs(): Promise<readonly TurnResult[]> {
    const pending = projectPendingInputs(await this.#journal.read(this.id));
    return Promise.all(
      pending.map((input) =>
        this.#scheduleInput(
          input.id,
          { content: input.content },
          Promise.resolve(),
        ),
      ),
    );
  }

  #scheduleInput(
    inputId: string,
    input: SessionInput,
    accepted: Promise<void>,
  ): Promise<TurnResult> {
    const scheduled = this.#scheduledInputs.get(inputId);
    if (scheduled) return scheduled;

    const previousTurn = this.#turnTail;
    const turn = (async () => {
      await accepted;
      await previousTurn;
      return this.#execute(inputId, input);
    })();
    this.#turnTail = turn.then(
      () => undefined,
      () => undefined,
    );
    this.#scheduledInputs.set(inputId, turn);
    void turn.finally(() => this.#scheduledInputs.delete(inputId));
    return turn;
  }

  cancelActiveTurn(reason = "turn cancelled"): boolean {
    if (!this.#activeTurn) return false;
    this.#activeTurn.controller.abort(new DOMException(reason, "AbortError"));
    return true;
  }

  async #execute(inputId: string, input: SessionInput): Promise<TurnResult> {
    const turnId = randomUUID();
    const controller = new AbortController();
    this.#activeTurn = { id: turnId, controller };
    const agent = this.#ctx.agents.get(this.agentId).createSnapshot();
    let releaseTurn: (() => void) | undefined;

    try {
      releaseTurn = await this.#turns.acquire(controller.signal);
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

        const snapshot = await this.#ctx.context.assemble(
          agent,
          await this.#journal.read(this.id),
          turnId,
        );
        await this.#append({
          type: "model/call-started",
          stepId,
          modelCallId,
          snapshot,
        });

        let response;
        try {
          response = await this.#ctx.models.generate(
            agent.model.adapter,
            snapshot.request,
            { signal: controller.signal },
            agent.timeouts.modelMs,
          );
        } catch (error) {
          await this.#append({
            type: "model/call-failed",
            modelCallId,
            error: formatError(error),
          });
          throw error;
        }
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
        const results = await Promise.all(
          response.toolCalls.map((call) =>
            this.#executeTool(
              agent,
              call,
              {
                sessionId: this.id,
                turnId,
                stepId,
                callId: call.id,
                signal: controller.signal,
              },
              agent.timeouts.toolMs,
            ),
          ),
        );
        await this.#append(
          ...results.map<SessionEvent>((result) => ({
            type: "tool/call-completed",
            stepId,
            result,
          })),
          ...results.flatMap<SessionEvent>((result, resultIndex) => {
            const call = response.toolCalls[resultIndex];
            if (
              !call ||
              call.toolId !== "skills/activate" ||
              result.status !== "success"
            ) {
              return [];
            }
            const skillId = call.arguments.skillId;
            return typeof skillId === "string"
              ? [{ type: "skill/activated", turnId, skillId }]
              : [];
          }),
          { type: "step/completed", turnId, stepId },
        );
      }

      await this.#append({ type: "turn/exhausted", turnId });
      return { turnId, status: "exhausted", output: [] };
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = formatError(controller.signal.reason);
        await this.#append({ type: "turn/cancelled", turnId, reason });
        return { turnId, status: "cancelled", output: [] };
      }
      const message = formatError(error);
      await this.#append({ type: "turn/failed", turnId, error: message });
      return { turnId, status: "failed", output: [] };
    } finally {
      releaseTurn?.();
      if (this.#activeTurn?.id === turnId) this.#activeTurn = null;
    }
  }

  async events(): Promise<readonly SessionEventEnvelope[]> {
    return this.#journal.read(this.id);
  }

  async #executeTool(
    agent: AgentSnapshot,
    call: ToolCall,
    context: ToolExecutionContext,
    timeoutMs: number,
  ): Promise<ToolResult> {
    if (!agent.tools.includes(call.toolId)) {
      return toolError(call, `Tool is not selected by AgentSpec: ${call.toolId}`);
    }
    if (call.toolId === "skills/activate") {
      const skillId = call.arguments.skillId;
      const allowed =
        typeof skillId === "string" &&
        agent.skills.some(
          (skill) => skill.id === skillId && skill.mode === "available",
        );
      if (!allowed) {
        return toolError(call, `Skill is not available to this Agent: ${String(skillId)}`);
      }
    }
    return this.#ctx.tools.execute(call, context, timeoutMs);
  }

  async snapshot(): Promise<SessionSnapshot> {
    return projectSession(this.id, await this.#journal.read(this.id));
  }

  async #append(...events: readonly SessionEvent[]): Promise<void> {
    const operation = this.#appendTail.then(async () => {
      const appended = await this.#journal.append(
        this.id,
        this.#revision,
        events,
      );
      this.#revision += appended.length;
    });
    this.#appendTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toolError(call: ToolCall, message: string): ToolResult {
  return {
    callId: call.id,
    toolId: call.toolId,
    status: "error",
    content: [{ type: "text", text: message }],
  };
}

export class SessionsModule extends Service {
  private readonly sessions = new Map<string, Session>();
  private readonly journal: SessionJournal;
  private readonly turns: Semaphore;

  constructor(
    ctx: Context,
    journal: SessionJournal = new MemorySessionJournal(),
    maxActiveTurns = 8,
  ) {
    super(ctx, "sessions");
    this.journal = journal;
    this.turns = new Semaphore(maxActiveTurns);
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
      this.turns,
    );
    this.sessions.set(options.id, session);
    return session;
  }

  async open(options: OpenSessionOptions): Promise<Session> {
    const alreadyOpen = this.sessions.get(options.id);
    if (alreadyOpen) return alreadyOpen;

    let events = await this.journal.read(options.id);
    const created = events.find(
      (event) => event.payload.type === "session/created",
    );
    if (!created || created.payload.type !== "session/created") {
      throw new Error(`session does not exist: ${options.id}`);
    }
    this.ctx.agents.get(created.payload.agentId);

    const snapshot = projectSession(options.id, events);
    if (snapshot.latestTurn?.status === "active") {
      await this.journal.append(options.id, events.length, [
        {
          type: "turn/interrupted",
          turnId: snapshot.latestTurn.id,
          reason: "Kernel restarted before the Turn reached a terminal event",
        },
      ]);
      events = await this.journal.read(options.id);
    }

    const session = new Session(
      this.ctx,
      { id: options.id, agentId: created.payload.agentId },
      this.journal,
      events.length,
      this.turns,
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
