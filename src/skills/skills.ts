import { Service, type Context } from "cordis";

export class SkillsModule extends Service {
  constructor(ctx: Context) {
    super(ctx, "skills");
  }
}

declare module "cordis" {
  interface Context {
    skills: SkillsModule;
  }
}
