export interface CallTimeouts {
  readonly modelMs: number;
  readonly toolMs: number;
}

export interface ConcurrencyLimits {
  readonly maxActiveTurns: number;
  readonly maxModelCalls: number;
  readonly maxToolCalls: number;
}

export interface KernelRuntimeOptions {
  readonly timeouts: CallTimeouts;
  readonly concurrency: ConcurrencyLimits;
}

const DEFAULT_TIMEOUTS: CallTimeouts = {
  modelMs: 60_000,
  toolMs: 60_000,
};

const DEFAULT_CONCURRENCY: ConcurrencyLimits = {
  maxActiveTurns: 8,
  maxModelCalls: 4,
  maxToolCalls: 16,
};

export function resolveKernelRuntimeOptions(options: {
  readonly timeouts?: Partial<CallTimeouts>;
  readonly concurrency?: Partial<ConcurrencyLimits>;
}): KernelRuntimeOptions {
  return {
    timeouts: Object.freeze({ ...DEFAULT_TIMEOUTS, ...options.timeouts }),
    concurrency: Object.freeze({
      ...DEFAULT_CONCURRENCY,
      ...options.concurrency,
    }),
  };
}
