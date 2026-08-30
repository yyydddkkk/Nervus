import { Context, type Plugin } from "cordis";

import { corePlugin } from "./core-plugin.js";

export type KernelState = "ready" | "disposing" | "disposed";

export interface KernelOptions {
  plugins?: readonly Plugin<void>[];
}

export class Kernel {
  readonly context: Context;

  #state: KernelState = "ready";
  #disposePromise?: Promise<void>;

  constructor(context: Context) {
    this.context = context;
  }

  get state(): KernelState {
    return this.#state;
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;

    this.#state = "disposing";
    const disposePromise = this.context.fiber.dispose().finally(() => {
      this.#state = "disposed";
    });
    this.#disposePromise = disposePromise;

    return disposePromise;
  }
}

export async function createKernel(options: KernelOptions = {}): Promise<Kernel> {
  const context = new Context();

  try {
    await context.plugin(corePlugin);

    for (const plugin of options.plugins ?? []) {
      await context.plugin(plugin);
    }

    return new Kernel(context);
  } catch (error) {
    await context.fiber.dispose();
    throw error;
  }
}
