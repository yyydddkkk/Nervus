import { randomUUID } from "node:crypto";

import { Service, type Context } from "cordis";

import type { AgentSnapshot } from "../agents/agent.js";
import type { ContentBlock } from "../domain/content.js";
import { Semaphore } from "../kernel/semaphore.js";
import { KernelError } from "../kernel/error.js";
import type {
  AssistantModelMessage,
  ToolCall,
} from "../models/model.js";
import type { SessionEvent, SessionEventEnvelope } from "./events.js";
import type { ToolInvocationContext, ToolResult } from "../tools/tool.js";
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
  #stopping = false;
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
    if (this.#stopping) {
      throw new KernelError(
        "KERNEL_DISPOSING",
        "Session cannot accept Input while the Kernel is disposing",
      );
    }
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
      if (this.#stopping) {
        throw new KernelError(
          "KERNEL_DISPOSING",
          "Queued Input will remain durable while the Kernel is disposing",
        );
      }
      return this.#execute(inputId, input);
    })();
    this.#turnTail = turn.then(
      () => undefined,
      () => undefined,
    );
    this.#scheduledInputs.set(inputId, turn);
    const cleanup = () => this.#scheduledInputs.delete(inputId);
    void turn.then(cleanup, cleanup);
    return turn;
  }

  cancelActiveTurn(reason = "turn cancelled"): boolean {
    if (!this.#activeTurn) return false;
    this.#activeTurn.controller.abort(new DOMException(reason, "AbortError"));
    return true;
  }

  async shutdown(reason = "Kernel is disposing"): Promise<void> {
    this.#stopping = true;
    this.cancelActiveTurn(reason);
    await this.#turnTail;
    await this.#appendTail;
  }

  async #execute(inputId: string, input: SessionInput): Promise<TurnResult> {
    const turnId = randomUUID();
    const controller = new AbortController();
    this.#activeTurn = { id: turnId, controller };
    let agent!: AgentSnapshot;
    let releaseTurn: (() => void) | undefined;
    const capabilityReleases: (() => void)[] = [];

    try {
      const contributors = this.#ctx.context.holdContributors();
      capabilityReleases.push(contributors.release);
      agent = this.#ctx.agents.snapshot(this.agentId, contributors.refs);
      await this.#append(
        { type: "turn/started", turnId, inputId, agent },
        { type: "user/message", turnId, content: input.content },
      );
      capabilityReleases.push(this.#ctx.models.hold(agent.model.adapter));
      for (const toolId of agent.tools) {
        capabilityReleases.push(this.#ctx.tools.hold(toolId));
      }
      capabilityReleases.push(
        this.#ctx.skills.hold(agent.skills.map((skill) => skill.id)),
      );
      releaseTurn = await this.#turns.acquire(controller.signal);

      let toolCallCount = 0;
      let modelAttemptCount = 0;
      for (let index = 1; index <= agent.limits.maxSteps; index += 1) {
        let remainingAttempts =
          agent.limits.maxModelAttempts - modelAttemptCount;
        if (remainingAttempts <= 0) {
          await this.#append({ type: "turn/exhausted", turnId });
          return { turnId, status: "exhausted", output: [] };
        }

        const stepId = randomUUID();
        await this.#append({
          type: "step/started",
          turnId,
          stepId,
          index,
        });

        let events = await this.#journal.read(this.id);
        let snapshot = await this.#ctx.context.assemble(
          agent,
          events,
          turnId,
        );
        let compactionPasses = 0;
        while (snapshot.report.needsCompaction) {
          compactionPasses += 1;
          if (compactionPasses > 4) {
            throw new KernelError(
              "COMPACTION_FAILED",
              "History Compaction did not produce a context that fits after 4 passes",
            );
          }
          remainingAttempts =
            agent.limits.maxModelAttempts - modelAttemptCount;
          if (remainingAttempts <= 0) {
            await this.#append({ type: "turn/exhausted", turnId });
            return { turnId, status: "exhausted", output: [] };
          }

          const plan = await this.#ctx.context.planCompaction(
            agent,
            events,
            turnId,
          );
          const compactionModelCallId = randomUUID();
          await this.#append({
            type: "model/call-started",
            stepId,
            modelCallId: compactionModelCallId,
            snapshot: plan.snapshot,
          });
          let compacted;
          try {
            compacted = await this.#ctx.historyCompactor.compact(
              agent.model.adapter,
              plan.snapshot.request,
              {
                signal: controller.signal,
                sessionId: this.id,
                turnId,
                stepId,
                modelCallId: compactionModelCallId,
                timeoutMs: agent.timeouts.modelMs,
                maxAttempts: remainingAttempts,
                purpose: "compaction",
                onAttemptStarted: async (attempt) => {
                  modelAttemptCount += 1;
                  await this.#append({
                    type: "model/attempt-started",
                    modelCallId: compactionModelCallId,
                    attempt,
                  });
                },
                onAttemptFailed: async (attempt, error, retryable) => {
                  await this.#append({
                    type: "model/attempt-failed",
                    modelCallId: compactionModelCallId,
                    attempt,
                    error: formatError(error),
                    retryable,
                  });
                },
              },
            );
          } catch (error) {
            await this.#append({
              type: "model/call-failed",
              modelCallId: compactionModelCallId,
              error: formatError(error),
            });
            throw error;
          }
          await this.#append(
            {
              type: "model/call-completed",
              modelCallId: compactionModelCallId,
              content: compacted.content,
              toolCalls: [],
              reasoning: compacted.reasoning,
              ...(compacted.usage ? { usage: compacted.usage } : {}),
            },
            {
              type: "history/compacted",
              throughSequence: plan.throughSequence,
              summary: compacted.content,
              modelCallId: compactionModelCallId,
            },
          );
          events = await this.#journal.read(this.id);
          snapshot = await this.#ctx.context.assemble(agent, events, turnId);
        }

        remainingAttempts = agent.limits.maxModelAttempts - modelAttemptCount;
        if (remainingAttempts <= 0) {
          await this.#append({ type: "turn/exhausted", turnId });
          return { turnId, status: "exhausted", output: [] };
        }
        const modelCallId = randomUUID();
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
            {
              signal: controller.signal,
              sessionId: this.id,
              turnId,
              stepId,
              modelCallId,
              timeoutMs: agent.timeouts.modelMs,
              maxAttempts: remainingAttempts,
              onAttemptStarted: async (attempt) => {
                modelAttemptCount += 1;
                await this.#append({
                  type: "model/attempt-started",
                  modelCallId,
                  attempt,
                });
              },
              onAttemptFailed: async (attempt, error, retryable) => {
                await this.#append({
                  type: "model/attempt-failed",
                  modelCallId,
                  attempt,
                  error: formatError(error),
                  retryable,
                });
              },
            },
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
          ...(response.reasoning ? { reasoning: response.reasoning } : {}),
          toolCalls: response.toolCalls,
        };
        await this.#append(
          {
            type: "model/call-completed",
            modelCallId,
            content: response.content,
            toolCalls: response.toolCalls,
            reasoning: response.reasoning,
            ...(response.usage ? { usage: response.usage } : {}),
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
        const settled = await Promise.allSettled(
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
        const results: ToolResult[] = [];
        const terminalEvents: SessionEvent[] = [];
        const activationEvents: SessionEvent[] = [];
        let firstFailure: unknown;
        settled.forEach((outcome, resultIndex) => {
          const call = response.toolCalls[resultIndex];
          if (!call) return;
          if (outcome.status === "fulfilled") {
            results.push(outcome.value);
            terminalEvents.push({
              type: "tool/call-completed",
              stepId,
              result: outcome.value,
            });
            if (
              call.toolId === "skills/activate" &&
              outcome.value.status === "success" &&
              typeof call.arguments.skillId === "string"
            ) {
              activationEvents.push({
                type: "skill/activated",
                turnId,
                skillId: call.arguments.skillId,
              });
            }
            return;
          }

          firstFailure ??= outcome.reason;
          terminalEvents.push(
            controller.signal.aborted
              ? {
                  type: "tool/call-cancelled",
                  stepId,
                  callId: call.id,
                  reason: formatError(controller.signal.reason),
                }
              : {
                  type: "tool/call-failed",
                  stepId,
                  callId: call.id,
                  error: formatError(outcome.reason),
                },
          );
        });
        await this.#append(
          ...terminalEvents,
          ...activationEvents,
          ...(firstFailure
            ? []
            : [{ type: "step/completed", turnId, stepId } as const]),
        );
        if (firstFailure) throw firstFailure;
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
      for (const releaseCapability of capabilityReleases.reverse()) {
        releaseCapability();
      }
      if (this.#activeTurn?.id === turnId) this.#activeTurn = null;
    }
  }

  async events(): Promise<readonly SessionEventEnvelope[]> {
    return this.#journal.read(this.id);
  }

  async #executeTool(
    agent: AgentSnapshot,
    call: ToolCall,
    context: ToolInvocationContext,
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
      throw new KernelError(
        "SESSION_CONFLICT",
        `Session is already open: ${options.id}`,
      );
    }
    this.ctx.agents.get(options.agentId);

    const existing = await this.journal.read(options.id);
    if (existing.length > 0) {
      throw new KernelError(
        "SESSION_CONFLICT",
        `Session already exists: ${options.id}`,
      );
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
      throw new KernelError(
        "SESSION_CONFLICT",
        `Session does not exist: ${options.id}`,
      );
    }
    this.ctx.agents.get(created.payload.agentId);

    const snapshot = projectSession(options.id, events);
    if (snapshot.latestTurn?.status === "active") {
      const reason = "Kernel restarted before execution reached a terminal event";
      await this.journal.append(options.id, events.length, [
        ...repairInterruptedCalls(events, reason),
        {
          type: "turn/interrupted",
          turnId: snapshot.latestTurn.id,
          reason,
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

  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].map((session) => session.shutdown()),
    );
  }
}

function repairInterruptedCalls(
  events: readonly SessionEventEnvelope[],
  reason: string,
): readonly SessionEvent[] {
  const modelCalls = new Set<string>();
  const toolCalls = new Map<string, string>();
  for (const envelope of events) {
    const event = envelope.payload;
    switch (event.type) {
      case "model/call-started":
        modelCalls.add(event.modelCallId);
        break;
      case "model/call-completed":
      case "model/call-failed":
      case "model/call-interrupted":
        modelCalls.delete(event.modelCallId);
        break;
      case "tool/call-started":
        toolCalls.set(event.call.id, event.stepId);
        break;
      case "tool/call-completed":
        toolCalls.delete(event.result.callId);
        break;
      case "tool/call-cancelled":
      case "tool/call-failed":
      case "tool/call-interrupted":
        toolCalls.delete(event.callId);
        break;
    }
  }
  return [
    ...[...modelCalls].map<SessionEvent>((modelCallId) => ({
      type: "model/call-interrupted",
      modelCallId,
      reason,
    })),
    ...[...toolCalls].map<SessionEvent>(([callId, stepId]) => ({
      type: "tool/call-interrupted",
      stepId,
      callId,
      reason,
    })),
  ];
}

declare module "cordis" {
  interface Context {
    sessions: SessionsModule;
  }
}
