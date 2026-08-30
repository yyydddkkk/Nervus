import { Service, type Context } from "cordis";

abstract class RequiredModule extends Service {
  protected constructor(ctx: Context, name: string) {
    super(ctx, name);
  }
}

export class AgentsModule extends RequiredModule {
  constructor(ctx: Context) {
    super(ctx, "agents");
  }
}

export class SessionsModule extends RequiredModule {
  constructor(ctx: Context) {
    super(ctx, "sessions");
  }
}

export class ModelsModule extends RequiredModule {
  constructor(ctx: Context) {
    super(ctx, "models");
  }
}

export class ToolsModule extends RequiredModule {
  constructor(ctx: Context) {
    super(ctx, "tools");
  }
}

export class ContextModule extends RequiredModule {
  constructor(ctx: Context) {
    super(ctx, "context");
  }
}

export class SkillsModule extends RequiredModule {
  constructor(ctx: Context) {
    super(ctx, "skills");
  }
}

declare module "cordis" {
  interface Context {
    agents: AgentsModule;
    sessions: SessionsModule;
    models: ModelsModule;
    tools: ToolsModule;
    context: ContextModule;
    skills: SkillsModule;
  }
}

export function mountRequiredModules(ctx: Context): void {
  new AgentsModule(ctx);
  new SessionsModule(ctx);
  new ModelsModule(ctx);
  new ToolsModule(ctx);
  new ContextModule(ctx);
  new SkillsModule(ctx);
}
