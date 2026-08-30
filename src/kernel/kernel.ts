import { Context, type Plugin } from "cordis";

import type { Agent, AgentSpec } from "../agents/agent.js";
import type {
  CreateSessionOptions,
  Session,
} from "../sessions/session.js";
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

  async createAgent(spec: AgentSpec): Promise<Agent> {
    this.#assertReady();
    return this.context.agents.create(spec);
  }

  async createSession(options: CreateSessionOptions): Promise<Session> {
    this.#assertReady();
    return this.context.sessions.create(options);
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

  #assertReady(): void {
    if (this.#state !== "ready") {
      throw new Error(`kernel is not ready: ${this.#state}`);
    }
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
