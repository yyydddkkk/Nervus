# Nervus completion audit

Audit date: 2026-08-30.

Scope: the accepted [architecture blueprint](./ARCHITECTURE.md) and M0–M6 [implementation plan](./IMPLEMENTATION.md). This audit distinguishes implemented requirements from items explicitly deferred by the blueprint.

## Milestone evidence

| Milestone | Status | Authoritative evidence |
| --- | --- | --- |
| M0 Foundation | Complete | `package.json`, pinned `cordis@4.0.0-rc.9`, `src/kernel/*`, and `tests/kernel.test.ts`. |
| M1 First complete Turn | Complete | `tests/turn.test.ts` proves Model → Tool → Model and event-projected SessionSnapshot behavior. |
| M2 Bounded execution | Complete | `tests/bounded-execution.test.ts` proves FIFO Inputs, cancellation, model/tool timeouts, three independent concurrency limits, JSON Schema validation, parallel ordered collect-all, and TurnLimits. |
| M3 Durable Sessions | Complete | `tests/durable-sessions.test.ts` proves JSONL restart replay, queued Input recovery, interrupted call repair, atomic batches, and stale revision rejection. |
| M4 Context and Skills | Complete | `tests/context-and-skills.test.ts` proves stable layers, attributable snapshots, estimate and exact-token budgets, current-Turn retention, truncators, and Turn-scoped Skill activation. |
| M5 Real Adapters | Complete | `tests/openai-compatible.test.ts`, `tests/local-tools.test.ts`, `examples/openai-compatible.ts`, and `.env.example`. |
| M6 Lifecycle hardening | Complete | `tests/lifecycle-hardening.test.ts` proves retries and attempt facts, Turn-wide provider leases, immediate Kernel cancellation, stable errors, forced timeouts, AgentSpec revisions, call terminal facts, and transient updates. |

## Architecture requirements

| Area | Evidence and conclusion |
| --- | --- |
| Cordis foundation | Exactly pinned in `package.json`; six required modules are mounted by `src/kernel/core-plugin.ts` and verified by Kernel tests. |
| Public facade | `Kernel.createAgent`, `updateAgent`, `createSession`, `openSession`, `dispose`, plus the advanced `kernel.context` escape hatch. |
| Agent identity | AgentSpec is serializable; each Turn records an immutable AgentSnapshot with Spec, model, Tool, Skill, and ContextContributor revisions. Later Turns observe `updateAgent`; active Turns retain their Snapshot. |
| Execution hierarchy | Session → Turn → Step → ModelCall/ToolCall is represented by versioned SessionEvents and exercised end to end. No overlapping `Run` concept exists. |
| Source of truth | Memory and JSONL SessionJournal Adapters use expected revisions and atomic non-empty batches; SessionSnapshot and pending Inputs are event projections. |
| Recovery | `openSession` marks unterminated ModelCalls, ToolCalls, and Turns interrupted; queued Inputs remain durable and require explicit `resumePendingInputs()`. |
| Models | Async ModelEvent stream supports text, reasoning, ToolCall, usage, completion, and failure. Models enforces timeouts even for non-cooperative Adapters, concurrency, retry classification, backoff, and durable attempts. |
| Tools | JSON Schema validation precedes execution. Tool failures become ToolResults; parent cancellation receives explicit call terminal facts. Same-Step calls are concurrent, collect-all, and ordered. |
| Context | Contributors return isolated ContextBlocks. Named layers, duplicate rejection, retention, truncation, exact counters, current-Turn preservation, and serializable ModelRequestSnapshots are implemented. |
| Skills | Declarative Skills support resources metadata, eager and available modes, built-in `skills/activate`, Agent selection checks, and Turn-local activation. |
| Concurrency and limits | Separate abortable semaphores govern Turns, ModelCalls, and ToolCalls. TurnLimits cover Steps, total ToolCalls, per-Step ToolCalls, and total Model attempts. |
| Cancellation and disposal | Turn cancellation preserves Session state. Kernel disposal rejects new work, cancels active Turns, preserves queued Inputs, drains provider leases, and reaches `disposed`. |
| Errors | Public/invariant failures use stable KernelError codes; Tool operation errors remain ToolResults and Turn outcomes remain projected facts. |
| Real adapters | OpenAI-compatible Chat Completions SSE and root-scoped file/shell Tools have deterministic protocol and real local-process tests. A live network smoke is opt-in because it requires caller credentials. |
| Observability | Model text/reasoning/usage and Tool progress are transient Cordis events. Completed reasoning/usage and every lifecycle terminal are durable Session facts. |

## Kernel invariant evidence

1. Side effects are preceded by `model/call-started`, `model/attempt-started`, or `tool/call-started` Journal writes.
2. Both Journals reject stale expected revisions; the JSONL test proves a rejected batch leaves no partial event.
3. Session FIFO tests prove one active Turn per Session.
4. Agent update tests prove one frozen revision per Turn and newer revisions only on later Turns.
5. Cancellation and recovery tests prove ModelCalls and ToolCalls receive completed, failed, cancelled, or interrupted terminal facts.
6. Parallel Tool tests prove one ordered ToolResult per successful model-issued call before the next Step.
7. ContextContributor interfaces do not expose a shared mutable draft; duplicate Block identities fail.
8. `model/call-started` durably contains the full ModelRequestSnapshot before Adapter execution.
9. Models records assistant content only after a terminal `response-completed`; interrupted streams create call failure/interruption facts instead.
10. Provider lease tests and Kernel disposal tests prove no active registration lease remains after disposal.

## Explicitly deferred

These are not missing from M0–M6; the accepted blueprint explicitly defers them:

- MCP Adapter and concrete Memory plugins.
- Automatic history Compaction and a production HistoryCompactor.
- YAML loading, overlays, HMR, UI, and distributed execution.
- Permissions, approvals, sandboxing, and cross-model fallback.
- Public npm publication and API compatibility guarantees.

## Verification commands

The completion gate is:

```sh
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
```

Coverage thresholds are enforced in `vitest.config.ts`; they are supporting evidence, not a substitute for the behavior mappings above.
