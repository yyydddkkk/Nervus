export interface RegistrationLease<T> {
  readonly value: T;
  readonly revision: number;
  release(): void;
}

interface Registration<T> {
  readonly value: T;
  readonly revision: number;
  active: boolean;
  leases: number;
  readonly drained: Promise<void>;
  resolveDrained(): void;
}

export class LeasedRegistry<
  T extends { readonly id: string; readonly revision?: number },
> {
  readonly #entries = new Map<string, Registration<T>>();

  contains(id: string): boolean {
    return this.#entries.has(id);
  }

  has(id: string): boolean {
    return this.#entries.get(id)?.active === true;
  }

  activeValues(): readonly T[] {
    return [...this.#entries.values()]
      .filter((registration) => registration.active)
      .map((registration) => registration.value);
  }

  register(value: T): () => Promise<void> {
    let resolveDrained!: () => void;
    const registration: Registration<T> = {
      value,
      revision: value.revision ?? 1,
      active: true,
      leases: 0,
      drained: new Promise<void>((resolve) => {
        resolveDrained = resolve;
      }),
      resolveDrained,
    };
    this.#entries.set(value.id, registration);

    return async () => {
      registration.active = false;
      if (registration.leases > 0) await registration.drained;
      if (this.#entries.get(value.id) === registration) {
        this.#entries.delete(value.id);
      }
    };
  }

  get(id: string): T | undefined {
    return this.#entries.get(id)?.value;
  }

  revision(id: string): number | undefined {
    return this.#entries.get(id)?.revision;
  }

  acquire(id: string): RegistrationLease<T> | undefined {
    const registration = this.#entries.get(id);
    if (!registration?.active) return undefined;
    registration.leases += 1;
    let released = false;
    return {
      value: registration.value,
      revision: registration.revision,
      release: () => {
        if (released) return;
        released = true;
        registration.leases -= 1;
        if (!registration.active && registration.leases === 0) {
          registration.resolveDrained();
        }
      },
    };
  }
}
