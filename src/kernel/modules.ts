import type { Context } from "cordis";

import { AgentsModule } from "../agents/agent.js";
import { ContextModule } from "../context/context.js";
import { ModelsModule } from "../models/model.js";
import { SessionsModule } from "../sessions/session.js";
import { SkillsModule } from "../skills/skills.js";
import { ToolsModule } from "../tools/tool.js";

export {
  AgentsModule,
  ContextModule,
  ModelsModule,
  SessionsModule,
  SkillsModule,
  ToolsModule,
};

export function mountRequiredModules(ctx: Context): void {
  new ModelsModule(ctx);
  new ToolsModule(ctx);
  new ContextModule(ctx);
  new SkillsModule(ctx);
  new AgentsModule(ctx);
  new SessionsModule(ctx);
}
