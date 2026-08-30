import { Service, type Context } from "cordis";

import type { ContentBlock } from "../domain/content.js";

export interface ModelRef {
  readonly adapter: string;
  readonly model: string;
}

export interface TurnLimits {
  readonly maxSteps: number;
  readonly maxToolCalls: number;
  readonly maxToolCallsPerStep: number;
  readonly maxModelAttempts: number;
}

export interface AgentSpec {
  readonly id: string;
  readonly model: ModelRef;
  readonly instructions?: readonly ContentBlock[];
  readonly tools?: readonly string[];
  readonly limits?: Partial<TurnLimits>;
}

export interface AgentSnapshot {
  readonly agentId: string;
  readonly revision: number;
  readonly model: ModelRef;
  readonly instructions: readonly ContentBlock[];
  readonly tools: readonly string[];
  readonly limits: TurnLimits;
}

const DEFAULT_LIMITS: TurnLimits = {
  maxSteps: 16,
  maxToolCalls: 64,
  maxToolCallsPerStep: 16,
  maxModelAttempts: 3,
};

export class Agent {
  readonly id: string;
  readonly #snapshot: AgentSnapshot;

  constructor(snapshot: AgentSnapshot) {
    this.id = snapshot.agentId;
    this.#snapshot = snapshot;
  }

  createSnapshot(): AgentSnapshot {
    return this.#snapshot;
  }
}

export class AgentsModule extends Service {
  private readonly agents = new Map<string, Agent>();

  constructor(ctx: Context) {
    super(ctx, "agents");
  }

  create(spec: AgentSpec): Agent {
    if (this.agents.has(spec.id)) {
      throw new Error(`agent is already defined: ${spec.id}`);
    }
    if (!this.ctx.models.has(spec.model.adapter)) {
      throw new Error(`unknown model adapter: ${spec.model.adapter}`);
    }

    const tools = [...(spec.tools ?? [])];
    for (const toolId of tools) {
      if (!this.ctx.tools.has(toolId)) {
        throw new Error(`unknown tool: ${toolId}`);
      }
    }

    const snapshot: AgentSnapshot = Object.freeze({
      agentId: spec.id,
      revision: 1,
      model: Object.freeze({ ...spec.model }),
      instructions: Object.freeze([...(spec.instructions ?? [])]),
      tools: Object.freeze(tools),
      limits: Object.freeze({ ...DEFAULT_LIMITS, ...spec.limits }),
    });
    const agent = new Agent(snapshot);
    this.agents.set(spec.id, agent);
    return agent;
  }

  get(id: string): Agent {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`unknown agent: ${id}`);
    return agent;
  }
}

declare module "cordis" {
  interface Context {
    agents: AgentsModule;
  }
}
