import { Service, type Context } from "cordis";

import type { ContextBlock } from "../context/context.js";
import type { ContentBlock } from "../domain/content.js";
import type { SessionEventEnvelope } from "../sessions/events.js";
import { KernelError } from "../kernel/error.js";
import {
  LeasedRegistry,
  type RegistrationLease,
} from "../kernel/leased-registry.js";

export interface SkillResource {
  readonly uri: string;
  readonly mediaType?: string;
}

export interface SkillDefinition {
  readonly id: string;
  readonly revision?: number;
  readonly name: string;
  readonly description: string;
  readonly instructions: readonly ContentBlock[];
  readonly resources?: readonly SkillResource[];
}

export interface SkillRef {
  readonly id: string;
  readonly mode: "eager" | "available";
}

export class SkillsModule extends Service {
  private readonly skills = new LeasedRegistry<SkillDefinition>();

  constructor(ctx: Context) {
    super(ctx, "skills");
    const skills = this.skills;
    ctx.tools.register({
      id: "skills/activate",
      description: "Activate one available Skill for the remainder of this Turn.",
      inputSchema: {
        type: "object",
        properties: { skillId: { type: "string" } },
        required: ["skillId"],
        additionalProperties: false,
      },
      async execute(input) {
        const { skillId } = input as { skillId: string };
        if (!skills.has(skillId)) {
          return {
            status: "error",
            content: [{ type: "text", text: `unknown Skill: ${skillId}` }],
          };
        }
        return {
          status: "success",
          content: [{ type: "text", text: `activated Skill: ${skillId}` }],
        };
      },
    });
  }

  register(skill: SkillDefinition): void {
    this.ctx.effect(() => {
      if (this.skills.contains(skill.id)) {
        throw new KernelError(
          "REGISTRATION_CONFLICT",
          `Skill is already registered: ${skill.id}`,
        );
      }
      return this.skills.register(skill);
    });
  }

  has(id: string): boolean {
    return this.skills.has(id);
  }

  revision(id: string): number {
    const revision = this.skills.revision(id);
    if (revision === undefined) {
      throw new KernelError("INVARIANT_VIOLATION", `Unknown Skill: ${id}`);
    }
    return revision;
  }

  hold(ids: readonly string[]): () => void {
    const leases: RegistrationLease<SkillDefinition>[] = [];
    for (const id of ids) {
      const lease = this.skills.acquire(id);
      if (!lease) {
        for (const acquired of leases) acquired.release();
        throw new KernelError(
          "INVARIANT_VIOLATION",
          `Skill is not available for a Turn: ${id}`,
        );
      }
      leases.push(lease);
    }
    return () => {
      for (const lease of leases.reverse()) lease.release();
    };
  }

  contextBlocks(
    refs: readonly SkillRef[],
    events: readonly SessionEventEnvelope[],
    turnId: string,
  ): readonly ContextBlock[] {
    const activated = new Set(
      events.flatMap((event) =>
        event.payload.type === "skill/activated" &&
        event.payload.turnId === turnId
          ? [event.payload.skillId]
          : [],
      ),
    );

    return refs.map((ref, order) => {
      const skill = this.skills.get(ref.id);
      if (!skill) {
        throw new KernelError(
          "INVARIANT_VIOLATION",
          `Unknown Skill: ${ref.id}`,
        );
      }
      if (ref.mode === "eager" || activated.has(ref.id)) {
        return {
          id: `skill/${ref.id}/instructions`,
          source: ref.id,
          layer: "skill",
          order,
          retention: "required",
          content: { type: "instructions", blocks: skill.instructions },
        };
      }
      return {
        id: `skill/${ref.id}/discovery`,
        source: ref.id,
        layer: "skill",
        order,
        retention: "preferred",
        content: {
          type: "instructions",
          blocks: [
            {
              type: "text",
              text: `Available Skill ${skill.name} (${skill.id}): ${skill.description}`,
            },
          ],
        },
      };
    });
  }
}

declare module "cordis" {
  interface Context {
    skills: SkillsModule;
  }
}
