import { KernelError } from "../kernel/error.js";
import type {
  ModelAdapter,
  ModelCapabilities,
  ModelEvent,
  ModelExecutionContext,
  ModelRequest,
} from "../models/model.js";

export interface ScriptedModelAdapterOptions {
  readonly id: string;
  readonly steps: readonly (readonly ModelEvent[])[];
  readonly capabilities?: Partial<ModelCapabilities>;
}

export class ScriptedModelAdapter implements ModelAdapter {
  readonly id: string;
  readonly capabilities?: Partial<ModelCapabilities>;
  readonly #steps: readonly (readonly ModelEvent[])[];
  #index = 0;

  constructor(options: ScriptedModelAdapterOptions) {
    this.id = options.id;
    this.#steps = options.steps.map((step) => [...step]);
    if (options.capabilities) this.capabilities = options.capabilities;
  }

  async *generate(
    _request: ModelRequest,
    context: ModelExecutionContext,
  ): AsyncIterable<ModelEvent> {
    const step = this.#steps[this.#index];
    if (!step) {
      throw new KernelError(
        "INVARIANT_VIOLATION",
        `Scripted Model has no step at index ${this.#index}`,
      );
    }
    this.#index += 1;
    for (const event of step) {
      if (context.signal.aborted) throw context.signal.reason;
      yield event;
    }
  }
}
