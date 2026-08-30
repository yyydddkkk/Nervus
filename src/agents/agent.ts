import { Service, type Context } from "cordis";

import type { ContentBlock } from "../domain/content.js";
import type { CallTimeouts } from "../kernel/options.js";
import type { SkillRef } from "../skills/skills.js";

export interface ModelRef {
  readonly adapter: string;
  readonly model: string;
  readonly maxOutputTokens?: number;
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
  readonly timeouts?: Partial<CallTimeouts>;
  readonly skills?: readonly SkillRef[];
}

export interface AgentSnapshot {
  readonly agentId: string;
  readonly revision: number;
  readonly model: ModelRef;
  readonly instructions: readonly ContentBlock[];
  readonly tools: readonly string[];
  readonly limits: TurnLimits;
  readonly timeouts: CallTimeouts;
  readonly skills: readonly SkillRef[];
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
  private readonly defaultTimeouts: CallTimeouts;

  constructor(ctx: Context, defaultTimeouts: CallTimeouts) {
    super(ctx, "agents");
    this.defaultTimeouts = defaultTimeouts;
  }

  create(spec: AgentSpec): Agent {
    if (this.agents.has(spec.id)) {
      throw new Error(`agent is already defined: ${spec.id}`);
    }
    if (!this.ctx.models.has(spec.model.adapter)) {
      throw new Error(`unknown model adapter: ${spec.model.adapter}`);
    }

    const skills = [...(spec.skills ?? [])];
    for (const skill of skills) {
      if (!this.ctx.skills.has(skill.id)) {
        throw new Error(`unknown Skill: ${skill.id}`);
      }
    }

    const tools = [...(spec.tools ?? [])];
    if (
      skills.some((skill) => skill.mode === "available") &&
      !tools.includes("skills/activate")
    ) {
      tools.push("skills/activate");
    }
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
      timeouts: Object.freeze({ ...this.defaultTimeouts, ...spec.timeouts }),
      skills: Object.freeze(skills.map((skill) => Object.freeze({ ...skill }))),
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
