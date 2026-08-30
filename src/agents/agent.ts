import { Service, type Context } from "cordis";

import type { ContentBlock } from "../domain/content.js";
import type { ContextContributorRef } from "../context/context.js";
import type { CallTimeouts } from "../kernel/options.js";
import { KernelError } from "../kernel/error.js";
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
  readonly modelRevision: number;
  readonly instructions: readonly ContentBlock[];
  readonly tools: readonly string[];
  readonly toolRevisions: Readonly<Record<string, number>>;
  readonly limits: TurnLimits;
  readonly timeouts: CallTimeouts;
  readonly skills: readonly SkillRef[];
  readonly skillRevisions: Readonly<Record<string, number>>;
  readonly contextContributors: readonly ContextContributorRef[];
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

  createSnapshot(
    contextContributors: readonly ContextContributorRef[] =
      this.#snapshot.contextContributors,
  ): AgentSnapshot {
    return Object.freeze({
      ...this.#snapshot,
      contextContributors: Object.freeze(
        contextContributors.map((contributor) =>
          Object.freeze({ ...contributor }),
        ),
      ),
    });
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
      throw new KernelError(
        "INVALID_AGENT_SPEC",
        `Agent is already defined: ${spec.id}`,
      );
    }
    return this.resolve(spec, 1);
  }

  update(spec: AgentSpec): Agent {
    const current = this.agents.get(spec.id);
    if (!current) {
      throw new KernelError(
        "INVALID_AGENT_SPEC",
        `Cannot update unknown Agent: ${spec.id}`,
      );
    }
    return this.resolve(spec, current.createSnapshot().revision + 1);
  }

  private resolve(spec: AgentSpec, revision: number): Agent {
    if (!this.ctx.models.has(spec.model.adapter)) {
      throw new KernelError(
        "INVALID_AGENT_SPEC",
        `Unknown Model Adapter: ${spec.model.adapter}`,
      );
    }

    const skills = [...(spec.skills ?? [])];
    for (const skill of skills) {
      if (!this.ctx.skills.has(skill.id)) {
        throw new KernelError(
          "INVALID_AGENT_SPEC",
          `Unknown Skill: ${skill.id}`,
        );
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
        throw new KernelError("INVALID_AGENT_SPEC", `Unknown Tool: ${toolId}`);
      }
    }
    if (tools.length > 0 && !this.ctx.models.capabilities(spec.model.adapter).supportsTools) {
      throw new KernelError(
        "INVALID_AGENT_SPEC",
        `Model Adapter does not support Tools: ${spec.model.adapter}`,
      );
    }

    const snapshot: AgentSnapshot = Object.freeze({
      agentId: spec.id,
      revision,
      model: Object.freeze({ ...spec.model }),
      modelRevision: this.ctx.models.revision(spec.model.adapter),
      instructions: Object.freeze([...(spec.instructions ?? [])]),
      tools: Object.freeze(tools),
      toolRevisions: Object.freeze(
        Object.fromEntries(
          tools.map((toolId) => [toolId, this.ctx.tools.revision(toolId)]),
        ),
      ),
      limits: Object.freeze({ ...DEFAULT_LIMITS, ...spec.limits }),
      timeouts: Object.freeze({ ...this.defaultTimeouts, ...spec.timeouts }),
      skills: Object.freeze(skills.map((skill) => Object.freeze({ ...skill }))),
      skillRevisions: Object.freeze(
        Object.fromEntries(
          skills.map((skill) => [skill.id, this.ctx.skills.revision(skill.id)]),
        ),
      ),
      contextContributors: Object.freeze([]),
    });
    const agent = new Agent(snapshot);
    this.agents.set(spec.id, agent);
    return agent;
  }

  get(id: string): Agent {
    const agent = this.agents.get(id);
    if (!agent) {
      throw new KernelError("INVALID_AGENT_SPEC", `Unknown Agent: ${id}`);
    }
    return agent;
  }

  snapshot(
    id: string,
    contextContributors = this.ctx.context.contributorRefs(),
  ): AgentSnapshot {
    return this.get(id).createSnapshot(contextContributors);
  }
}

declare module "cordis" {
  interface Context {
    agents: AgentsModule;
  }
}
