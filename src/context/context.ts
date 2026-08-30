import { Service, type Context } from "cordis";

import type { AgentSnapshot } from "../agents/agent.js";
import type { ContentBlock } from "../domain/content.js";
import type { ModelMessage, ModelRequest } from "../models/model.js";
import type { SessionEventEnvelope } from "../sessions/events.js";
import { KernelError } from "../kernel/error.js";
import { LeasedRegistry } from "../kernel/leased-registry.js";

export type ContextLayer =
  | "kernel"
  | "agent"
  | "skill"
  | "memory"
  | "runtime"
  | "history";

export type ContextRetention = "required" | "preferred" | "optional";

export type ContextBlockContent =
  | {
      readonly type: "instructions";
      readonly blocks: readonly ContentBlock[];
    }
  | {
      readonly type: "messages";
      readonly messages: readonly ModelMessage[];
    };

export interface ContextBlock {
  readonly id: string;
  readonly source: string;
  readonly layer: ContextLayer;
  readonly order: number;
  readonly retention: ContextRetention;
  readonly content: ContextBlockContent;
  readonly tokenEstimate?: number;
  readonly truncate?: (targetTokens: number) => ContextBlockContent | null;
}

export interface ContextContributionInput {
  readonly agent: AgentSnapshot;
  readonly events: readonly SessionEventEnvelope[];
  readonly turnId: string;
}

export interface ContextContributor {
  readonly id: string;
  readonly revision?: number;
  contribute(
    input: ContextContributionInput,
  ): readonly ContextBlock[] | Promise<readonly ContextBlock[]>;
}

export interface ContextContributorRef {
  readonly id: string;
  readonly revision: number;
}

export interface ContextContributorLease {
  readonly refs: readonly ContextContributorRef[];
  release(): void;
}

export interface ContextDrop {
  readonly id: string;
  readonly reason: "input budget exceeded";
}

export interface ContextAssemblyReport {
  readonly inputBudget: number;
  readonly estimatedInputTokens: number;
  readonly includedBlockIds: readonly string[];
  readonly dropped: readonly ContextDrop[];
  readonly truncated: readonly ContextTruncation[];
  readonly needsCompaction: boolean;
}

export interface ContextTruncation {
  readonly id: string;
  readonly fromTokens: number;
  readonly toTokens: number;
}

export interface AssembledContextBlock {
  readonly id: string;
  readonly source: string;
  readonly layer: ContextLayer;
  readonly order: number;
  readonly retention: ContextRetention;
  readonly content: ContextBlockContent;
  readonly tokenEstimate: number;
}

interface CandidateContextBlock extends AssembledContextBlock {
  readonly truncate?: (targetTokens: number) => ContextBlockContent | null;
}

export interface ModelRequestSnapshot {
  readonly request: ModelRequest;
  readonly blocks: readonly AssembledContextBlock[];
  readonly report: ContextAssemblyReport;
}

export interface HistoryCompactionPlan {
  readonly throughSequence: number;
  readonly snapshot: ModelRequestSnapshot;
}

const LAYER_ORDER: Readonly<Record<ContextLayer, number>> = {
  kernel: 0,
  agent: 1,
  skill: 2,
  memory: 3,
  runtime: 4,
  history: 5,
};

export class ContextModule extends Service {
  private readonly contributors = new LeasedRegistry<ContextContributor>();

  constructor(ctx: Context) {
    super(ctx, "context");
  }

  register(contributor: ContextContributor): void {
    this.ctx.effect(() => {
      if (this.contributors.contains(contributor.id)) {
        throw new KernelError(
          "REGISTRATION_CONFLICT",
          `ContextContributor is already registered: ${contributor.id}`,
        );
      }
      return this.contributors.register(contributor);
    });
  }

  contributorRefs(): readonly ContextContributorRef[] {
    return this.contributors.activeValues().map((contributor) => ({
      id: contributor.id,
      revision: contributor.revision ?? 1,
    }));
  }

  holdContributors(): ContextContributorLease {
    const leases = this.contributors.activeValues().map((contributor) => {
      const lease = this.contributors.acquire(contributor.id);
      if (!lease) {
        throw new KernelError(
          "INVARIANT_VIOLATION",
          `ContextContributor became unavailable: ${contributor.id}`,
        );
      }
      return lease;
    });
    return {
      refs: leases.map((lease) => ({
        id: lease.value.id,
        revision: lease.revision,
      })),
      release: () => {
        for (const lease of leases.reverse()) lease.release();
      },
    };
  }

  async assemble(
    agent: AgentSnapshot,
    events: readonly SessionEventEnvelope[],
    turnId: string,
  ): Promise<ModelRequestSnapshot> {
    const history = projectMessages(events, turnId);
    const blocks: ContextBlock[] = [
      {
        id: "agent/instructions",
        source: "nervus/agents",
        layer: "agent",
        order: 0,
        retention: "required",
        content: { type: "instructions", blocks: agent.instructions },
      },
    ];
    if (history.summary.length > 0) {
      blocks.push({
        id: "history/summary",
        source: "nervus/compaction",
        layer: "history",
        order: 0,
        retention: "preferred",
        content: { type: "instructions", blocks: history.summary },
      });
    }
    if (history.prior.length > 0) {
      blocks.push({
        id: "history/prior",
        source: "nervus/sessions",
        layer: "history",
        order: 1,
        retention: "preferred",
        content: { type: "messages", messages: history.prior },
      });
    }
    blocks.push({
      id: "history/messages",
      source: "nervus/sessions",
      layer: "history",
      order: 2,
      retention: "required",
      content: { type: "messages", messages: history.current },
    });
    blocks.push(...this.ctx.skills.contextBlocks(agent.skills, events, turnId));

    const input: ContextContributionInput = { agent, events, turnId };
    for (const ref of agent.contextContributors) {
      const contributor = this.contributors.get(ref.id);
      if (!contributor) {
        throw new KernelError(
          "INVARIANT_VIOLATION",
          `Frozen ContextContributor is unavailable: ${ref.id}`,
        );
      }
      blocks.push(...(await contributor.contribute(input)));
    }

    const identities = new Set<string>();
    for (const block of blocks) {
      if (identities.has(block.id)) {
        throw new KernelError(
          "INVARIANT_VIOLATION",
          `Duplicate ContextBlock identity: ${block.id}`,
        );
      }
      identities.add(block.id);
    }

    const assembled = blocks
      .map<CandidateContextBlock>((block) => ({
        ...block,
        tokenEstimate: block.tokenEstimate ?? estimateBlockTokens(block.content),
      }))
      .sort(compareBlocks);
    const capabilities = this.ctx.models.capabilities(agent.model.adapter);
    const reservedOutput =
      agent.model.maxOutputTokens ?? capabilities.maxOutputTokens;
    const inputBudget = Math.max(
      0,
      capabilities.contextWindow -
        reservedOutput -
        capabilities.safetyMarginTokens,
    );
    const selected = [...assembled];
    const dropped: ContextDrop[] = [];
    const truncated: ContextTruncation[] = [];
    let estimatedInputTokens = totalTokens(selected);

    const tryTruncate = (index: number, targetTokens: number): boolean => {
      const block = selected[index];
      if (!block?.truncate) return false;
      const content = block.truncate(Math.max(1, targetTokens));
      if (!content) return false;
      const tokenEstimate = estimateBlockTokens(content);
      if (tokenEstimate >= block.tokenEstimate) return false;
      const { truncate: _truncate, ...serializable } = block;
      selected[index] = { ...serializable, content, tokenEstimate };
      truncated.push({
        id: block.id,
        fromTokens: block.tokenEstimate,
        toTokens: tokenEstimate,
      });
      return true;
    };

    for (const retention of ["optional", "preferred"] as const) {
      for (let index = selected.length - 1; index >= 0; index -= 1) {
        if (estimatedInputTokens <= inputBudget) break;
        const block = selected[index];
        if (!block || block.retention !== retention) continue;
        const targetTokens =
          block.tokenEstimate - (estimatedInputTokens - inputBudget);
        if (tryTruncate(index, targetTokens)) {
          estimatedInputTokens = totalTokens(selected);
          if (estimatedInputTokens <= inputBudget) continue;
        }
        const current = selected[index];
        if (!current) continue;
        selected.splice(index, 1);
        estimatedInputTokens -= current.tokenEstimate;
        dropped.unshift({ id: current.id, reason: "input budget exceeded" });
      }
    }

    const buildRequest = (): ModelRequest => {
      const instructions: ContentBlock[] = [];
      const requestMessages: ModelMessage[] = [];
      for (const block of selected) {
        if (block.content.type === "instructions") {
          instructions.push(...block.content.blocks);
        } else {
          requestMessages.push(...block.content.messages);
        }
      }
      return {
        model: agent.model.model,
        instructions,
        messages: requestMessages,
        tools: agent.tools.map((toolId) => {
          const tool = this.ctx.tools.describe(toolId);
          return {
            id: tool.id,
            description: tool.description,
            inputSchema: tool.inputSchema,
          };
        }),
      };
    };

    let request = buildRequest();
    if (capabilities.countTokens) {
      estimatedInputTokens = await capabilities.countTokens(request);
      for (const retention of ["optional", "preferred"] as const) {
        for (let index = selected.length - 1; index >= 0; index -= 1) {
          if (estimatedInputTokens <= inputBudget) break;
          const block = selected[index];
          if (!block || block.retention !== retention) continue;
          const targetTokens =
            block.tokenEstimate - (estimatedInputTokens - inputBudget);
          if (tryTruncate(index, targetTokens)) {
            request = buildRequest();
            estimatedInputTokens = await capabilities.countTokens(request);
            if (estimatedInputTokens <= inputBudget) continue;
          }
          const current = selected[index];
          if (!current) continue;
          selected.splice(index, 1);
          dropped.unshift({ id: current.id, reason: "input budget exceeded" });
          request = buildRequest();
          estimatedInputTokens = await capabilities.countTokens(request);
        }
      }
    }

    if (estimatedInputTokens > inputBudget) {
      throw new KernelError(
        "CONTEXT_OVERFLOW",
        `required ContextBlocks exceed model input budget: ${estimatedInputTokens} > ${inputBudget}`,
      );
    }

    return {
      request,
      blocks: selected.map(stripTruncator),
      report: {
        inputBudget,
        estimatedInputTokens,
        includedBlockIds: selected.map((block) => block.id),
        dropped,
        truncated,
        needsCompaction: dropped.some(
          (drop) =>
            drop.id === "history/prior" || drop.id === "history/summary",
        ),
      },
    };
  }

  async planCompaction(
    agent: AgentSnapshot,
    events: readonly SessionEventEnvelope[],
    turnId: string,
  ): Promise<HistoryCompactionPlan> {
    const history = projectHistory(events, turnId);
    const currentTurn = events.find(
      (envelope) =>
        envelope.payload.type === "turn/started" &&
        envelope.payload.turnId === turnId,
    );
    if (!currentTurn) {
      throw new KernelError(
        "INVARIANT_VIOLATION",
        `Cannot compact history before Turn start: ${turnId}`,
      );
    }

    const terminalSequences = events
      .filter(
        (envelope) =>
          envelope.sequence < currentTurn.sequence &&
          envelope.sequence > history.throughSequence &&
          isTurnTerminal(envelope.payload.type),
      )
      .map((envelope) => envelope.sequence)
      .sort((left, right) => right - left);
    const candidates = [
      ...terminalSequences,
      ...(history.summary.length > 0 ? [history.throughSequence] : []),
    ];
    const capabilities = this.ctx.models.capabilities(agent.model.adapter);
    const reservedOutput =
      agent.model.maxOutputTokens ?? capabilities.maxOutputTokens;
    const inputBudget = Math.max(
      0,
      capabilities.contextWindow -
        reservedOutput -
        capabilities.safetyMarginTokens,
    );
    const directive: ContentBlock = {
      type: "text",
      text: "Summarize this history for future turns. Preserve decisions, facts, constraints, tool outcomes, and open tasks.",
    };

    for (const throughSequence of candidates) {
      const messages = history.prior
        .filter((item) => item.sequence <= throughSequence)
        .map((item) => item.message);
      const instructions = [directive, ...history.summary];
      if (messages.length === 0 && history.summary.length === 0) continue;
      const request: ModelRequest = {
        model: agent.model.model,
        instructions,
        messages,
        tools: [],
      };
      const blocks: readonly AssembledContextBlock[] = [
        {
          id: "kernel/compaction-instructions",
          source: "nervus/compaction",
          layer: "kernel",
          order: 0,
          retention: "required",
          content: { type: "instructions", blocks: instructions },
          tokenEstimate: estimateContentTokens(instructions),
        },
        ...(messages.length > 0
          ? [
              {
                id: "history/compaction-source",
                source: "nervus/sessions",
                layer: "history" as const,
                order: 0,
                retention: "required" as const,
                content: { type: "messages" as const, messages },
                tokenEstimate: estimateBlockTokens({
                  type: "messages",
                  messages,
                }),
              },
            ]
          : []),
      ];
      const estimatedInputTokens = capabilities.countTokens
        ? await capabilities.countTokens(request)
        : blocks.reduce((total, block) => total + block.tokenEstimate, 0);
      if (estimatedInputTokens > inputBudget) continue;
      return {
        throughSequence,
        snapshot: {
          request,
          blocks,
          report: {
            inputBudget,
            estimatedInputTokens,
            includedBlockIds: blocks.map((block) => block.id),
            dropped: [],
            truncated: [],
            needsCompaction: false,
          },
        },
      };
    }

    throw new KernelError(
      "CONTEXT_OVERFLOW",
      "Session history cannot fit in a Compaction ModelCall",
    );
  }
}

function projectMessages(
  events: readonly SessionEventEnvelope[],
  currentTurnId: string,
): {
  readonly summary: readonly ContentBlock[];
  readonly prior: readonly ModelMessage[];
  readonly current: readonly ModelMessage[];
} {
  const history = projectHistory(events, currentTurnId);
  return {
    summary: history.summary,
    prior: history.prior.map((item) => item.message),
    current: history.current,
  };
}

interface SequencedMessage {
  readonly sequence: number;
  readonly message: ModelMessage;
}

function projectHistory(
  events: readonly SessionEventEnvelope[],
  currentTurnId: string,
): {
  readonly summary: readonly ContentBlock[];
  readonly throughSequence: number;
  readonly prior: readonly SequencedMessage[];
  readonly current: readonly ModelMessage[];
} {
  const currentTurnSequence =
    events.find(
      (envelope) =>
        envelope.payload.type === "turn/started" &&
        envelope.payload.turnId === currentTurnId,
    )?.sequence ?? Number.POSITIVE_INFINITY;
  const latestCompaction = events
    .filter(
      (envelope) =>
        envelope.payload.type === "history/compacted" &&
        envelope.payload.throughSequence < currentTurnSequence,
    )
    .at(-1);
  const summary =
    latestCompaction?.payload.type === "history/compacted"
      ? latestCompaction.payload.summary
      : [];
  const throughSequence =
    latestCompaction?.payload.type === "history/compacted"
      ? latestCompaction.payload.throughSequence
      : 0;
  const prior: SequencedMessage[] = [];
  const current: ModelMessage[] = [];
  const stepTurns = new Map<string, string>();
  const append = (
    envelope: SessionEventEnvelope,
    turnId: string | undefined,
    message: ModelMessage,
  ) => {
    if (turnId === currentTurnId) {
      current.push(message);
    } else if (envelope.sequence > throughSequence) {
      prior.push({ sequence: envelope.sequence, message });
    }
  };
  for (const envelope of events) {
    const event = envelope.payload;
    switch (event.type) {
      case "step/started":
        stepTurns.set(event.stepId, event.turnId);
        break;
      case "user/message":
        append(envelope, event.turnId, {
          role: "user",
          content: event.content,
        });
        break;
      case "assistant/message":
        append(envelope, stepTurns.get(event.stepId), event.message);
        break;
      case "tool/call-completed":
        append(envelope, stepTurns.get(event.stepId), {
          role: "tool",
          callId: event.result.callId,
          toolId: event.result.toolId,
          status: event.result.status,
          content: event.result.content,
        });
        break;
    }
  }
  return { summary, throughSequence, prior, current };
}

function isTurnTerminal(type: string): boolean {
  return (
    type === "turn/completed" ||
    type === "turn/exhausted" ||
    type === "turn/cancelled" ||
    type === "turn/failed" ||
    type === "turn/interrupted"
  );
}

function compareBlocks(
  left: AssembledContextBlock,
  right: AssembledContextBlock,
): number {
  return (
    LAYER_ORDER[left.layer] - LAYER_ORDER[right.layer] ||
    left.order - right.order ||
    left.id.localeCompare(right.id)
  );
}

function estimateBlockTokens(content: ContextBlockContent): number {
  if (content.type === "instructions") {
    return estimateContentTokens(content.blocks);
  }
  return Math.max(
    1,
    content.messages.reduce((total, message) => {
      const toolCallTokens =
        message.role === "assistant"
          ? Math.ceil(JSON.stringify(message.toolCalls).length / 4)
          : 0;
      const reasoningTokens =
        message.role === "assistant" && message.reasoning
          ? Math.ceil(message.reasoning.length / 4)
          : 0;
      return (
        total +
        estimateContentTokens(message.content) +
        toolCallTokens +
        reasoningTokens
      );
    }, 0),
  );
}

function estimateContentTokens(blocks: readonly ContentBlock[]): number {
  return Math.max(
    1,
    blocks.reduce((total, block) => {
      if (block.type === "text") {
        return total + Math.ceil(block.text.length / 4);
      }
      if (block.type === "json") {
        return total + Math.ceil(JSON.stringify(block.value).length / 4);
      }
      return total + Math.ceil(block.uri.length / 4);
    }, 0),
  );
}

function totalTokens(blocks: readonly AssembledContextBlock[]): number {
  return blocks.reduce((total, block) => total + block.tokenEstimate, 0);
}

function stripTruncator(block: CandidateContextBlock): AssembledContextBlock {
  const { truncate: _truncate, ...serializable } = block;
  return serializable;
}

declare module "cordis" {
  interface Context {
    context: ContextModule;
  }
}
