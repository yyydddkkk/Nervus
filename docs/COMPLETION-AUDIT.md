# Nervus completion audit

Audit date: 2026-08-31.

Scope: the accepted [architecture blueprint](./ARCHITECTURE.md) and completed M0–M15 [implementation milestones](./IMPLEMENTATION.md), with intentionally deferred items listed below.

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
| M7 Live DeepSeek Tool use | Complete | `examples/deepseek-tool-agent.ts` and `docs/evidence/deepseek-tool-use.md` prove a real four-Step DeepSeek V4 run with parallel read/shell, write, read-back, JSONL persistence, leak scan, and restart recovery. |
| M8 Interactive CLI host | Complete | `src/cli.ts`, `src/cli/cli.ts`, `tests/cli.test.ts`, and `docs/evidence/deepseek-cli.md` prove chat, resume, list, inspect, Ctrl-C cancellation, durable history, and live DeepSeek Tool use. |
| M9 MCP Adapter | Complete | `src/mcp/mcp.ts`, `tests/mcp.test.ts`, and `docs/evidence/mcp-adapter.md` prove official SDK v2 discovery, Tool/Resource/Prompt mapping, Agent invocation, and lifecycle ownership. |
| M10 Automatic history Compaction | Complete | `src/context/compactor.ts`, `src/context/context.ts`, `tests/compaction.test.ts`, and `docs/evidence/automatic-compaction.md` prove pre-drop detection, durable summaries, restart reuse, model-attempt accounting, and explicit failure. |
| M11 Reference Coding Host | Complete | `apps/coding-agent`, `tests/coding-host.test.ts`, `examples/deepseek-coding-host.ts`, and `docs/evidence/deepseek-coding-host.md` prove package-root integration, run/resume, external state partitioning, JSON output, scoped repository instructions, real edits, independent verification, and two live DeepSeek tasks. |
| M12 Coding Host stabilization | Complete | `fs/list`, `apps/coding-agent/src/metrics.ts`, `examples/deepseek-coding-stabilization.ts`, `docs/evidence/m12-stabilization.json`, and `docs/evidence/m12-coding-host-stabilization.md` prove a two-pass six-task matrix, evidence-gated Prompt adjustment, zero final directory errors, full-repository repair, resume, and real Compaction. |
| M13 Capability Library | Complete | `packages/capability-library`, `capabilities/filesystem`, `tests/capability-library.test.ts`, and `docs/evidence/capability-library.md` prove strict manifests, explicit resolution, Bundle/dependency ordering, configuration, path/error contracts, stable Resolution, and reuse by both Hosts. |
| M14 Profile/YAML | Complete | `packages/profile`, both Host `--profile` paths, `tests/profile-loader.test.ts`, Host integration tests, and `docs/evidence/profile-yaml.md` prove strict YAML, inheritance/overlay semantics, runtime/env references, secret redaction, Resolution composition, and startup-only assembly. |
| M15 Profile-driven Host Assembly | Complete | `packages/host`, Profile v2, two-phase Capability planning, `capabilities/openai-compatible`, `tests/host-assembly.test.ts`, expanded Host tests, and `docs/evidence/m15-profile-driven-host-assembly.md` prove complete shared assembly, attributable contributions/resume, immutable redacted evidence, real generic/Coding DeepSeek Profiles, and zero key leakage. |

## Architecture requirements

| Area | Evidence and conclusion |
| --- | --- |
| Cordis foundation | Exactly pinned in `package.json`; seven required modules are mounted by `src/kernel/core-plugin.ts` and verified by Kernel tests. |
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
| Real adapters | OpenAI-compatible Chat Completions SSE and root-scoped file/shell Tools have deterministic tests. DeepSeek V4 has a live Tool-Use receipt covering `reasoning_content` replay, four ToolCalls, persisted usage, artifact verification, and restart recovery. |
| Observability | Model text/reasoning/usage and Tool progress are transient Cordis events. Completed reasoning/usage and every lifecycle terminal are durable Session facts. |
| Reference host | The packaged `nervus` CLI provides explicit workspaces, interactive and one-shot chat, durable Session resume/list/inspect, streamed updates, Tool summaries, and cancellation. |
| MCP | The official MCP v2 Client is isolated behind a Cordis Plugin. stdio, Streamable HTTP, and connected-Client entry points map server capabilities into existing Tool, Skill, and Context seams. |
| Compaction | Context reports `needsCompaction`; the Agent Loop durably runs a model-backed summary call, records `history/compacted`, and retries assembly from the summary plus later messages without deleting source events. |
| Coding Host | The private `@nervus/coding-agent` workspace package exposes `nervus-code` and `runCodingCli`, imports Nervus only from its package root, stores Journals outside target repositories, and validates the existing Kernel through real coding workflows. |
| Capability Library | A side-effect-free CapabilityPlan validates explicit trusted Package selections, declared artifacts, configuration, dependencies, and contribution conflicts; verified instantiation then produces standard Cordis Plugins. Kernel registries and lifecycle remain authoritative after mounting. |
| Profile | A Host-side strict v2 YAML/data loader produces complete typed assembly inputs, expanded defaults, and redacted ProfileResolution; the Kernel does not parse or reload configuration files. |
| Host Assembly | `@nervus/host` composes Profile, CapabilityPlan, HostContributions, Journal, Kernel controls, and one complete AgentSpec; owns rollback/disposal; and persists immutable secret-redacted HostAssemblyResolution references without adding a Kernel module. |

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

These are not missing from M0–M15; the accepted blueprint explicitly defers them:

- Concrete Memory plugins.
- Capability installation, scaffolding, remote registries, and automatic scanning.
- Multi-Agent routing, workflows, and a durable Job abstraction.
- HMR, UI, and distributed execution.
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
