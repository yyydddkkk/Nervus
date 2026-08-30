export interface CallTimeouts {
  readonly modelMs: number;
  readonly toolMs: number;
}

export interface ConcurrencyLimits {
  readonly maxActiveTurns: number;
  readonly maxModelCalls: number;
  readonly maxToolCalls: number;
}

export interface ModelRetryOptions {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export interface KernelRuntimeOptions {
  readonly timeouts: CallTimeouts;
  readonly concurrency: ConcurrencyLimits;
  readonly journal: SessionJournal;
  readonly retry: ModelRetryOptions;
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

const DEFAULT_RETRY: ModelRetryOptions = {
  baseDelayMs: 100,
  maxDelayMs: 1_000,
};

export function resolveKernelRuntimeOptions(options: {
  readonly timeouts?: Partial<CallTimeouts>;
  readonly concurrency?: Partial<ConcurrencyLimits>;
  readonly journal?: SessionJournal;
  readonly retry?: Partial<ModelRetryOptions>;
}): KernelRuntimeOptions {
  return {
    timeouts: Object.freeze({ ...DEFAULT_TIMEOUTS, ...options.timeouts }),
    concurrency: Object.freeze({
      ...DEFAULT_CONCURRENCY,
      ...options.concurrency,
    }),
    journal: options.journal ?? new MemorySessionJournal(),
    retry: Object.freeze({ ...DEFAULT_RETRY, ...options.retry }),
  };
}
import {
  MemorySessionJournal,
  type SessionJournal,
} from "../sessions/journal.js";
