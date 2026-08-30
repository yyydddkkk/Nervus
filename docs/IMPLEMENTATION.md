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

## Deferred

- Memory plugins.
- YAML loading, HMR, UI, multi-process or distributed execution.
- Permissions, approvals, sandboxing, cross-model fallback, and npm publication.
