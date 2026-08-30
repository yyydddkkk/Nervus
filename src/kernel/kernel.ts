import { Context, type Plugin } from "cordis";

import type { Agent, AgentSpec } from "../agents/agent.js";
import type {
  CreateSessionOptions,
  OpenSessionOptions,
  Session,
} from "../sessions/session.js";
import type { SessionJournal } from "../sessions/journal.js";
import { corePlugin } from "./core-plugin.js";
import { KernelError } from "./error.js";
import {
  resolveKernelRuntimeOptions,
  type CallTimeouts,
  type ConcurrencyLimits,
  type ModelRetryOptions,
} from "./options.js";

export type KernelState = "ready" | "disposing" | "disposed";

export interface KernelOptions {
  plugins?: readonly Plugin<void>[];
  timeouts?: Partial<CallTimeouts>;
  concurrency?: Partial<ConcurrencyLimits>;
  journal?: SessionJournal;
  retry?: Partial<ModelRetryOptions>;
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

  async updateAgent(spec: AgentSpec): Promise<Agent> {
    this.#assertReady();
    return this.context.agents.update(spec);
  }

  async createSession(options: CreateSessionOptions): Promise<Session> {
    this.#assertReady();
    return this.context.sessions.create(options);
  }

  async openSession(options: OpenSessionOptions): Promise<Session> {
    this.#assertReady();
    return this.context.sessions.open(options);
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;

    this.#state = "disposing";
    const disposePromise = (async () => {
      try {
        await this.context.sessions.shutdown();
      } finally {
        try {
          await this.context.fiber.dispose();
        } finally {
          this.#state = "disposed";
        }
      }
    })();
    this.#disposePromise = disposePromise;

    return disposePromise;
  }

  #assertReady(): void {
    if (this.#state !== "ready") {
      throw new KernelError(
        "KERNEL_DISPOSING",
        `Kernel is not ready: ${this.#state}`,
      );
    }
  }
}

export async function createKernel(options: KernelOptions = {}): Promise<Kernel> {
  const context = new Context();

  try {
    await context.plugin(corePlugin, resolveKernelRuntimeOptions(options));

    for (const plugin of options.plugins ?? []) {
      await context.plugin(plugin);
    }

    return new Kernel(context);
  } catch (error) {
    await context.fiber.dispose();
    throw error;
  }
}
