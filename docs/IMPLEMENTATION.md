# Nervus implementation plan

Nervus is an embeddable TypeScript Agent Kernel built on a frozen Cordis release. [ARCHITECTURE.md](./ARCHITECTURE.md) is the accepted design blueprint. Development proceeds through runnable vertical milestones; every milestone is verified through public module interfaces with deterministic model and tool adapters.

## M0: Foundation

Status: complete.

- Configure Node.js 22+, pnpm, TypeScript, Vitest, and ESM output.
- Pin Cordis exactly.
- Bootstrap the required Kernel modules through Cordis.
- Establish the public Kernel facade and lifecycle smoke tests.

## M1: First complete Turn

Status: complete.

- Add AgentSpec resolution and AgentSnapshot creation.
- Add an in-memory SessionJournal and deterministic Session projection.
- Run one Input through a ScriptedModel and one ToolCall to completion.

## M2: Bounded execution

Status: complete.

- Support multiple Steps and parallel same-Step ToolCalls.
- Add FIFO Session input queues, cancellation, timeouts, concurrency limits, and TurnLimits.
- Normalize every failure inside the ToolCall boundary into a ToolResult.

## M3: Durable Sessions

Status: complete.

- Add the JSONL SessionJournal adapter with atomic batches and expected revisions.
- Replay Session views and restore queued Inputs after restart.
- Mark active Turns as interrupted rather than resuming external work automatically.

## M4: Context and Skills

Status: complete.

- Collect layered ContextBlocks and compile ModelRequestSnapshots.
- Enforce model-aware context budgets with assembly reports.
- Register eager and available Skills; activate available Skills for the remainder of one Turn.

## M5: Real adapters

Status: complete.

- Add an OpenAI-compatible streaming Model adapter.
- Add `fs/read`, `fs/write`, and `shell/run` Tools.
- Exercise real adapters through opt-in smoke tests; deterministic tests remain the correctness gate.

## M6: Lifecycle hardening

Status: complete.

- Add centralized model retry and attempt records.
- Drain registration leases during plugin unload.
- Enforce global concurrency and immediate-cancel Kernel disposal.
- Complete cross-module behavior and recovery tests.

## M7: Live DeepSeek Tool use

Status: complete.

- Preserve DeepSeek V4 `reasoning_content` across thinking-mode ToolCall requests.
- Run a real read → shell → write → read-back Agent task in an isolated workspace.
- Persist the Session to JSONL and verify an equivalent SessionSnapshot after restart.
- Record a sanitized receipt and prove the API key is absent from runtime artifacts.

## M8: Interactive CLI host

Status: complete.

- Add `chat` with one-shot and interactive input, streamed updates, and Ctrl-C cancellation.
- Add durable Session create/resume plus `sessions list` and `sessions inspect`.
- Package a `nervus` executable while retaining an injectable `runNervusCli` test seam.
- Validate new chat, resumed context, Tool use, failure visibility, and inspect against live DeepSeek.

## M9: MCP Adapter

Status: complete.

- Build on the official MCP TypeScript SDK v2.
- Map remote Tools, Resources, and Prompts into existing Nervus registries.
- Support stdio, Streamable HTTP, and application-owned connected Clients.
- Forward cancellation and progress, and bind Client cleanup to Cordis lifecycle.
- Verify the protocol mapping against an in-memory official MCP server.

## M10: Automatic history Compaction

Status: complete.

- Report `needsCompaction` before Context would discard prior Session history.
- Use a model-backed core HistoryCompactor under existing execution controls.
- Record the covered event sequence, normalized summary, and source ModelCall atomically.
- Reassemble from the latest applicable summary plus subsequent messages.
- Preserve compacted history across Journal restart and fail explicitly on Compaction errors.

## M11: Reference Coding Host

Status: complete.

- Build an independent Host under `apps/coding-agent` that consumes Nervus through public exports.
- Complete the coding loop: inspect a repository, edit files, run verification, and report results without committing or publishing external changes.
- Default to the existing root-scoped file and Shell Tools. MCP remains an optional Plugin injection, not an M11 dependency or acceptance requirement.
- Assemble the Host in TypeScript with environment variables and CLI flags for runtime configuration; defer a declarative YAML format.
- Verify behavior with deterministic fixture repositories and repeatable live DeepSeek coding tasks.
- Require an explicit workspace and modify it in place while preserving the existing root-scoped Tool boundary.
- Map one coding task to one durable Session, with `run` for the initial Input and `resume` for explicit follow-up Inputs.
- Contribute the workspace root `AGENTS.md` automatically and require discovery of nearer scoped instructions before modifying nested files.
- Keep model configuration OpenAI-compatible and provider-neutral, with DeepSeek as the live acceptance baseline.
- Ship the independent `nervus-code` executable from `apps/coding-agent`.
- Store Journals in a user-level state directory partitioned by workspace, with an explicit `--state-dir` override.
- Stream human-readable model and Tool activity by default and offer `--json` for a machine-readable final Turn/Session summary.
- Preserve the Kernel's existing completion rule: a final model response without ToolCalls completes the Turn.
- Require the Agent to inspect repository status/diff and run appropriate verification through recorded Tools; fixture tests independently inspect the resulting workspace.
- Keep the Host on public Nervus interfaces. Any missing general capability requires a reproducible failing scenario before changing the Kernel.
- Partition the user-level state directory by a hash of the canonical workspace path; moving a workspace creates a new default partition, while `--state-dir` enables explicit recovery or migration.
- Generate and print a readable Session ID for `run`, with an optional explicit `--session`; `resume` always targets an existing ID.
- Capture the root `AGENTS.md` as required Context for a Turn. The Coding Skill requires reading nearer scoped instructions before nested edits; deterministic tests verify this behavior without adding policy to file Tools.
- Export an injectable `runCodingCli` seam for deterministic Host tests without creating a second general-purpose SDK.
- Run two live DeepSeek acceptances in disposable fixtures: a single-file defect repair and a scoped multi-file change.

## M12: Evidence-driven Coding Host stabilization

Status: complete.

Detailed blueprint: [plans/m12-coding-host-stabilization.md](./plans/m12-coding-host-stabilization.md).

- Stabilize the Reference Coding Host through repeatable real coding tasks.
- Establish behavior and efficiency baselines before expanding the Coding Tool set.
- Promote a new Tool or Kernel capability only when task evidence demonstrates a concrete recurring gap or correctness failure.
- Run six repeatable live DeepSeek tasks: four controlled realistic fixtures and two larger tasks against disposable copies of Nervus.
- Keep isolation in the acceptance harness through disposable repositories or worktrees; do not add automatic worktree behavior to the Host.
- Promote a capability after recurring evidence in at least two tasks, or immediately for one demonstrated safety, data-loss, or correctness failure.
- Record terminal verification, Steps, ToolCalls, Tool errors, Model retries, token usage, changed files, repeated reads, Shell purpose, and instruction compliance for every task.
- Add `fs/list` as the only pre-approved Tool improvement because directory discovery friction recurred in both M11 live tasks. `fs/search`, `fs/patch`, and Git-specific Tools remain evidence-gated.
- Implement `fs/list` before the six-task suite and treat the M11 live receipts as the pre-change baseline.
- Make `fs/list` enumerate one directory at a time as stable structured entries containing relative path, name, type, and file size; do not recurse or follow symbolic links.
- Keep `fs/list` in the existing root-scoped `localToolsPlugin` during M12; M13 may package the cohesive filesystem Tool set without changing Tool semantics.
- Cover directory/scoped-instruction discovery, a localized large-file edit, a cross-file symbol change, failed-verification recovery through resume, a seeded regression in a disposable Nervus copy, and a multi-Turn Nervus task that exercises history growth and Compaction.
- Run the six-task suite once for diagnosis, process evidence-qualified gaps one capability at a time, and rerun the complete suite as the final acceptance pass.
- Require all six final Turns and independent verifiers to pass with exact change scope, repository-instruction compliance, no directory-read mistakes, and no API-key leakage; record and allow recoverable provider retries or task-internal diagnostic failures.
- Classify every ShellCall as directory discovery, content search, verification, Git review, file mutation, or other so only recurring discovery, search, or mutation friction promotes a structured Tool candidate.
- For each promoted capability, preserve a red test, minimal implementation, affected-task rerun, and before/after metrics before proceeding to the next candidate.
- Commit sanitized aggregate JSON and a Markdown conclusion while leaving raw SessionJournals, fixture workspaces, and provider responses under ignored `.nervus`.

## M13: Capability Library

Status: complete.

Detailed blueprint: [plans/m13-capability-library.md](./plans/m13-capability-library.md).

- Build a shared filesystem Capability Library outside the Kernel after M12 stabilization is complete.
- Let Hosts explicitly select reusable capability packages for registration through existing Kernel interfaces.
- Keep filesystem discovery, manifests, and loading policy out of required Kernel modules and the Agent Loop.
- Treat one directory as one namespaced Capability Package with a manifest, executable entry when needed, and attached resources; allow a package to contribute an internally cohesive capability set.
- Index built-in roots plus additional roots supplied explicitly by a Host; do not auto-discover project or user directories.
- Treat executable packages as trusted local Host dependencies loaded only at startup; defer sandboxing, remote installation, Agent-controlled loading, and HMR.
- Prove cross-Host reuse by migrating both `nervus` CLI and `nervus-code` to a shared filesystem capability package while keeping Coding-specific Skills selected only by the Coding Host.
- Describe every Package with a JSON-Schema-validated `capability.json` containing a namespaced ID, recorded version, Package kind, declared contributions, and an entry path when executable.
- Load executable Package entries through one default `CapabilityFactory(config) -> Cordis Plugin` export so configurable Packages still enter the existing Kernel lifecycle through standard Plugins.
- Let a manifest reference an optional JSON Schema for Package configuration; validate the selected configuration before invoking the CapabilityFactory or producing Plugin side effects, and pass an empty object to configuration-free Packages.
- Reject duplicate Package IDs across all configured roots instead of applying root precedence or automatic version selection.
- Resolve declared Package-ID dependencies as one acyclic graph, failing on missing dependencies or cycles; record versions without adding multi-version or semver-range resolution in M13.
- Model a Bundle as a declaration-only Package whose recursive members expand the Host selection and receive no executable loading privileges.
- Expose one asynchronous `resolveCapabilityLibrary({ roots, select })` interface that returns load-ready Cordis Plugins plus a serializable CapabilityResolution.
- Record original selection, expanded Package IDs and versions, content digests, dependencies, and load order in the Host-owned CapabilityResolution without changing SessionEvents or AgentSnapshot in M13.
- Require executable entries to be directly importable ESM for the current Node process; the Library does not compile TypeScript.
- Canonicalize manifest, entry, and resource paths inside each Package Root; reject path escapes and duplicate declared contributions while leaving actual runtime registration conflicts to the Kernel.
- Fail Host startup with stable CapabilityLibraryError codes for invalid manifests, duplicate IDs, missing dependencies, cycles, invalid paths, entry loading failures, and invalid Plugin exports.
- End Library ownership after resolution: Hosts pass returned Plugins to `createKernel()`, and Cordis/Kernel exclusively own registration, leases, draining, and disposal.
- Keep installation separate from enablement: placing a trusted Package in a configured Root only makes it resolvable, while the Host must still select it explicitly. M13 provides no copy, download, or remote installer.
- Define CapabilitySelection as serializable data accepted through the M13 program interface and repeatable CLI flags; defer persistent Profile files and YAML to M14.

## M14: Profile and YAML assembly

Status: complete.

Detailed blueprint: [plans/m14-profile-yaml.md](./plans/m14-profile-yaml.md).

- Define a complete declarative Profile for one Host assembly, including Model configuration, AgentSpec, CapabilitySelection, Journal/state, execution controls, and Host options.
- Keep tasks, reasoning steps, Package installation, Session history, long-term Memory, and secret values outside the Profile.
- Treat YAML as a validated serialization of the typed Profile model rather than the source of runtime semantics.
- Implement Profile loading as a shared Host-side library outside the Kernel and Capability Library; resolve it into ordinary Host inputs rather than adding a required Kernel Module.
- Define exactly one primary Agent per M14 Profile and defer multi-Agent declarations, routing, and workflows until a real multi-Agent Host exists.
- Compose Profiles through one optional `extends` chain plus zero or more Host-supplied overlays applied in explicit order; reject multiple inheritance.
- Merge parent, child, and overlay data with deterministic JSON-Merge-Patch-like rules: recursively merge mappings, replace scalars and complete sequences, and use `null` only to clear optional fields; never concatenate arrays implicitly.
- Apply configuration precedence as Schema defaults, parent chain, current Profile, ordered Host overlays, and explicit CLI flags, then resolve value references after the final merge.
- Keep CapabilitySelection identities separate from a Package-ID-keyed `configure` map so Profiles can configure both directly selected Packages and members expanded from Bundles.
- Permit only structured value references such as `{ $env: NAME }` and `{ $runtime: NAME }`; prohibit arbitrary string interpolation and command substitution, and reject literal values in fields marked `x-secret`.
- Parse a strict versioned YAML 1.2 data subset, rejecting duplicate and unknown keys, custom tags, merge keys, anchors, and aliases before Profile Schema validation.
- Resolve a single parent path relative to its declaring Profile inside explicit Profile Roots, rejecting missing parents, path escape, remote sources, and inheritance cycles.
- Let each Host supply a HostProfileContract containing Host type, `host.options` Schema, and a typed runtime-binding whitelist.
- Mark secret fields through Host or Capability config Schema metadata, require `$env` references instead of literals, and keep resolved values only in memory while resolutions and errors remain redacted.
- Emit a serializable ProfileResolution containing Profile/source/overlay digests, inheritance and override provenance, redacted normalized configuration, CapabilityResolution, and a non-sensitive assembly summary.
- Parse and freeze one Profile per Host startup; require restart for changes and defer watchers, HMR, online switching, and per-Turn reload.
- Fail before Plugin effects with stable ProfileError codes for parsing, Schema, path, inheritance, Host contract, reference, secret, overlay, Capability configuration, and Resolution failures.

## M15: Profile-driven Host Assembly

Status: complete.

Detailed blueprint: [plans/m15-profile-driven-host-assembly.md](./plans/m15-profile-driven-host-assembly.md).

- Introduce strict Profile v2 whose complete AgentSpec, Capability configuration, state, Kernel controls, and Host options drive runtime assembly.
- Split Capability planning from executable instantiation and strengthen Package content identity with declared artifacts.
- Package the OpenAI-compatible Model Adapter as `nervus/openai-compatible` with static identity `openai-compatible/chat`.
- Add shared `@nervus/host` Host Assembly, attributable HostContributions, effective defaults, immutable redacted HostAssemblyResolution, and lifecycle ownership.
- Migrate both existing Hosts to the shared path while preserving the generic `chat` and Coding `run/resume` interaction models.
- Add ordered Overlay files, explicit Profile validation/explanation, optional generic workspace, attributable Profile changes on Session resume, and machine-readable one-shot output.
- Verify deterministic behavior plus disposable live DeepSeek generic and Coding scenarios with leak scans.

## M16: Minimal Tool authorization

Status: complete.

Specification: [GitHub Issue #16](https://github.com/yyydddkkk/Nervus/issues/16). Decision: [ADR-0013](./adr/0013-mediate-tool-calls-through-one-host-selected-authorizer.md).

- Mediate every model-issued ToolCall through exactly one Host-selected Tool Authorizer without expanding the AgentSnapshot Authority Ceiling.
- Default programmatic callers and both built-in Hosts to a synchronous YOLO Adapter that adds no model-visible work or Journal append.
- Provide explicit Host-side Supervised Mode with simple Tool-level approval, Turn-local Tool caching, independent same-Step authorization, and fail-closed error ToolResults.
- Record the Authorizer identity/revision in AgentSnapshot and HostAssemblyResolution while keeping Profile v2 and SessionEvent v1 compatible.
- Keep process/resource isolation, resource policy languages, multiple Authorizer priorities, durable approval resumption, and Web/network brokerage out of scope.
- Verify deterministic behavior in `tests/tool-authorization.test.ts`, Host behavior in CLI/Coding Host tests, and non-blocking performance evidence in `docs/evidence/m16-tool-authorization.md`.

## Deferred

- Memory plugins.
- HMR, UI, multi-process or distributed execution.
- Built-in sandboxing, general resource-permission policy, cross-model fallback, and npm publication.
