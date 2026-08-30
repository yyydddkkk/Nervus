# SessionEvents are the source of truth

Nervus treats the append-only SessionJournal as authoritative and derives Session views from SessionEvents. This costs more explicit event modeling than mutable Session persistence, but makes queueing, replay, interruption recovery, request snapshots, and causal debugging share one consistent history.
