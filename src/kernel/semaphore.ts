interface Waiter {
  readonly signal: AbortSignal;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: unknown) => void;
  readonly onAbort: () => void;
}

export class Semaphore {
  readonly #limit: number;
  readonly #queue: Waiter[] = [];
  #active = 0;

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`concurrency limit must be a positive integer: ${limit}`);
    }
    this.#limit = limit;
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.#active < this.#limit) {
      this.#active += 1;
      return Promise.resolve(this.#createRelease());
    }

    return new Promise<() => void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.#queue.indexOf(waiter);
        if (index >= 0) this.#queue.splice(index, 1);
        reject(signal.reason);
      };
      const waiter: Waiter = { signal, resolve, reject, onAbort };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#queue.push(waiter);
    });
  }

  #createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;

      const waiter = this.#queue.shift();
      if (waiter) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.resolve(this.#createRelease());
      } else {
        this.#active -= 1;
      }
    };
  }
}
