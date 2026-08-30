import type { Plugin } from "cordis";

import { mountRequiredModules } from "./modules.js";
import type { KernelRuntimeOptions } from "./options.js";

export const corePlugin: Plugin.Object<KernelRuntimeOptions> = {
  name: "nervus/core",
  apply(ctx, options) {
    mountRequiredModules(ctx, options);
  },
};
