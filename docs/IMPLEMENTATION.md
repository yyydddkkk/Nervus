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

- Collect layered ContextBlocks and compile ModelRequestSnapshots.
- Enforce model-aware context budgets with assembly reports.
- Register eager and available Skills; activate available Skills for the remainder of one Turn.

## M5: Real adapters

- Add an OpenAI-compatible streaming Model adapter.
- Add `fs/read`, `fs/write`, and `shell/run` Tools.
- Exercise real adapters through opt-in smoke tests; deterministic tests remain the correctness gate.

## M6: Lifecycle hardening

- Add centralized model retry and attempt records.
- Drain registration leases during plugin unload.
- Enforce global concurrency and immediate-cancel Kernel disposal.
- Complete cross-module behavior and recovery tests.

## Deferred

- MCP adapter and Memory plugins.
- Automatic history Compaction.
- YAML loading, HMR, UI, multi-process or distributed execution.
- Permissions, approvals, sandboxing, cross-model fallback, and npm publication.
