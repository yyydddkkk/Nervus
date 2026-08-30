import { Service, type Context } from "cordis";

import type { AgentSnapshot } from "../agents/agent.js";
import type { ContentBlock } from "../domain/content.js";
import type { ModelMessage, ModelRequest } from "../models/model.js";
import type { SessionEventEnvelope } from "../sessions/events.js";

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
}

export interface ContextContributionInput {
  readonly agent: AgentSnapshot;
  readonly events: readonly SessionEventEnvelope[];
  readonly turnId: string;
}

export interface ContextContributor {
  readonly id: string;
  contribute(
    input: ContextContributionInput,
  ): readonly ContextBlock[] | Promise<readonly ContextBlock[]>;
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

export interface ModelRequestSnapshot {
  readonly request: ModelRequest;
  readonly blocks: readonly AssembledContextBlock[];
  readonly report: ContextAssemblyReport;
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
  private readonly contributors = new Map<string, ContextContributor>();

  constructor(ctx: Context) {
    super(ctx, "context");
  }

  register(contributor: ContextContributor): void {
    this.ctx.effect(() => {
      if (this.contributors.has(contributor.id)) {
        throw new Error(
          `ContextContributor is already registered: ${contributor.id}`,
        );
      }
      this.contributors.set(contributor.id, contributor);
      return () => {
        if (this.contributors.get(contributor.id) === contributor) {
          this.contributors.delete(contributor.id);
        }
      };
    });
  }

  async assemble(
    agent: AgentSnapshot,
    events: readonly SessionEventEnvelope[],
    turnId: string,
  ): Promise<ModelRequestSnapshot> {
    const messages = projectMessages(events);
    const blocks: ContextBlock[] = [
      {
        id: "agent/instructions",
        source: "nervus/agents",
        layer: "agent",
        order: 0,
        retention: "required",
        content: { type: "instructions", blocks: agent.instructions },
      },
      {
        id: "history/messages",
        source: "nervus/sessions",
        layer: "history",
        order: 0,
        retention: "preferred",
        content: { type: "messages", messages },
      },
    ];
    blocks.push(...this.ctx.skills.contextBlocks(agent.skills, events, turnId));

    const input: ContextContributionInput = { agent, events, turnId };
    for (const contributor of this.contributors.values()) {
      blocks.push(...(await contributor.contribute(input)));
    }

    const identities = new Set<string>();
    for (const block of blocks) {
      if (identities.has(block.id)) {
        throw new Error(`duplicate ContextBlock identity: ${block.id}`);
      }
      identities.add(block.id);
    }

    const assembled = blocks
      .map<AssembledContextBlock>((block) => ({
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
    let estimatedInputTokens = totalTokens(selected);

    for (const retention of ["optional", "preferred"] as const) {
      for (let index = selected.length - 1; index >= 0; index -= 1) {
        if (estimatedInputTokens <= inputBudget) break;
        const block = selected[index];
        if (!block || block.retention !== retention) continue;
        selected.splice(index, 1);
        estimatedInputTokens -= block.tokenEstimate;
        dropped.unshift({ id: block.id, reason: "input budget exceeded" });
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
          selected.splice(index, 1);
          dropped.unshift({ id: block.id, reason: "input budget exceeded" });
          request = buildRequest();
          estimatedInputTokens = await capabilities.countTokens(request);
        }
      }
    }

    if (estimatedInputTokens > inputBudget) {
      throw new Error(
        `required ContextBlocks exceed model input budget: ${estimatedInputTokens} > ${inputBudget}`,
      );
    }

    return {
      request,
      blocks: selected,
      report: {
        inputBudget,
        estimatedInputTokens,
        includedBlockIds: selected.map((block) => block.id),
        dropped,
      },
    };
  }
}

function projectMessages(
  events: readonly SessionEventEnvelope[],
): readonly ModelMessage[] {
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
  return messages;
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
      return total + estimateContentTokens(message.content) + toolCallTokens;
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

declare module "cordis" {
  interface Context {
    context: ContextModule;
  }
}
