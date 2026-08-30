import type { Context } from "cordis";

import { AgentsModule } from "../agents/agent.js";
import { ContextModule } from "../context/context.js";
import { ModelsModule } from "../models/model.js";
import { SessionsModule } from "../sessions/session.js";
import { SkillsModule } from "../skills/skills.js";
import { ToolsModule } from "../tools/tool.js";
import type { KernelRuntimeOptions } from "./options.js";

export {
  AgentsModule,
  ContextModule,
  ModelsModule,
  SessionsModule,
  SkillsModule,
  ToolsModule,
};

export function mountRequiredModules(
  ctx: Context,
  options: KernelRuntimeOptions,
): void {
  new ModelsModule(ctx, options.concurrency.maxModelCalls);
  new ToolsModule(ctx, options.concurrency.maxToolCalls);
  new ContextModule(ctx);
  new SkillsModule(ctx);
  new AgentsModule(ctx, options.timeouts);
  new SessionsModule(ctx, undefined, options.concurrency.maxActiveTurns);
}
