import type { Context } from "cordis";

import { AgentsModule } from "../agents/agent.js";
import { ContextModule } from "../context/context.js";
import { HistoryCompactorModule } from "../context/compactor.js";
import { ModelsModule } from "../models/model.js";
import { SessionsModule } from "../sessions/session.js";
import { SkillsModule } from "../skills/skills.js";
import { ToolAuthorizationModule } from "../tools/authorization.js";
import { ToolsModule } from "../tools/tool.js";
import type { KernelRuntimeOptions } from "./options.js";

export {
  AgentsModule,
  ContextModule,
  HistoryCompactorModule,
  ModelsModule,
  SessionsModule,
  SkillsModule,
  ToolAuthorizationModule,
  ToolsModule,
};

export function mountRequiredModules(
  ctx: Context,
  options: KernelRuntimeOptions,
): void {
  new ModelsModule(
    ctx,
    options.concurrency.maxModelCalls,
    options.retry,
  );
  new ToolsModule(ctx, options.concurrency.maxToolCalls);
  new ToolAuthorizationModule(ctx, options.toolAuthorizer);
  new ContextModule(ctx);
  new HistoryCompactorModule(ctx);
  new SkillsModule(ctx);
  new AgentsModule(ctx, options.timeouts);
  new SessionsModule(
    ctx,
    options.journal,
    options.concurrency.maxActiveTurns,
  );
}
