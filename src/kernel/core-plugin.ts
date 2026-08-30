import type { Plugin } from "cordis";

import { mountRequiredModules } from "./modules.js";

export const corePlugin: Plugin.Object<void> = {
  name: "nervus/core",
  apply(ctx) {
    mountRequiredModules(ctx);
  },
};
