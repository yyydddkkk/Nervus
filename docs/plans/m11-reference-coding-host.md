# M11 reference Coding Host

Status: implemented and verified on 2026-08-30.

## Outcome

M11 builds a Coding Host that a single developer can use for real repository work while forcing Nervus to prove its existing public interfaces. One coding task maps to one durable Session. The Host accepts an initial Input, lets the Agent inspect and modify an explicit workspace, records all model and Tool activity, and supports follow-up Inputs through explicit Session resume.

The Host is a consumer of Nervus, not a Coding-specific extension of the Agent Loop.

## Host boundary

- Source lives under `apps/coding-agent` in this repository.
- The executable is `nervus-code`.
- The programmatic test seam is `runCodingCli(argv, { io, env, modelAdapter? })`.
- Host code imports Nervus only through package-root public exports.
- A missing capability becomes a Kernel change only after a reproducible Host scenario demonstrates that the capability is general rather than Coding-specific.

No ADR is required for this milestone: the Host placement and command interface are local, reversible decisions recorded by this plan.

## Commands

```text
nervus-code run --workspace <path> [--session <id>] [--state-dir <path>] [--json] <task>
nervus-code resume <session-id> --workspace <path> [--state-dir <path>] [--json] <follow-up>
```

`run` generates and immediately reports a readable Session ID unless one is supplied. `resume` requires an existing Session in the selected workspace state partition.

Default output streams model response text and concise Tool progress for a human. With `--json`, stdout contains one final machine-readable record derived from Journal facts, including workspace, Session ID, Turn ID, terminal status, normalized output, and Tool counts. Internal reasoning and Compaction summaries are not exposed as response text.

## Workspace and durable state

- `--workspace` is required and resolved to a canonical real path.
- The Agent edits that workspace in place.
- Root-scoped file and Shell Tools prevent paths from escaping the workspace.
- The default Journal directory is under the platform user-state directory at `nervus/coding/<workspace-hash>/sessions`.
- The workspace hash is derived from the canonical real path. Moving the repository intentionally creates a new default state partition.
- `--state-dir` overrides the default for deterministic tests, migration, and explicit recovery.
- No Nervus state file is written into the target repository by default.

## Agent assembly

The Host assembles Nervus in TypeScript from:

- the OpenAI-compatible Model Adapter, configured by environment variables;
- DeepSeek as the live acceptance provider, without DeepSeek-specific Host behavior;
- the existing root-scoped `fs/read`, `fs/write`, and `shell/run` Tools;
- one eager Coding Skill describing the inspect → edit → verify → review workflow;
- one Host ContextContributor containing the root `AGENTS.md` captured for the Turn when present;
- a JSONL SessionJournal in the selected user-state partition.

The Coding Skill requires the Agent to:

1. inspect repository evidence before editing;
2. read any nearer `AGENTS.md` governing a nested target before modifying it;
3. keep changes within the requested scope;
4. run appropriate verification selected from repository evidence and instructions;
5. inspect final Git status and diff;
6. report changed behavior, verification, and failures honestly.

Nested instruction compliance is behavioral and tested; M11 does not add Coding policy to generic file Tools. MCP may be injected through the ordinary Plugin list later, but it is neither enabled by default nor required for M11.

## Execution and completion

- One `run` command creates one Session and sends its initial Input.
- `resume` opens that Session and sends one follow-up Input.
- The existing Agent Loop decides completion: a model response with no ToolCalls completes the Turn.
- Model, Tool, retry, cancellation, Compaction, and usage facts remain authoritative in the SessionJournal.
- The Agent performs verification through recorded ToolCalls. Deterministic fixture tests independently inspect the resulting files and execute their own assertions, so a false model claim cannot satisfy acceptance.
- M11 does not commit, push, open pull requests, or mutate remote systems.

## Acceptance evidence

Deterministic tests use injected IO, a Scripted Model Adapter, explicit state directories, and disposable Git fixture repositories. They prove:

- `run` creates a durable Session, edits only the explicit workspace, executes verification, and reports the final Turn;
- `resume` reuses recorded history for a follow-up correction;
- root instructions enter required Context and a nested edit reads the nearer `AGENTS.md` first;
- distinct canonical workspaces receive distinct default state partitions;
- `--state-dir` makes persistence deterministic and recoverable;
- human streaming and single-record `--json` output remain separate;
- Host imports and behavior cross public Nervus seams.

Live DeepSeek acceptance runs in disposable fixtures and records sanitized receipts for:

1. a single-file defect repair with a failing test that passes after the change;
2. a scoped multi-file change governed by a nested `AGENTS.md`, including final diff review and verification.

API keys must remain absent from Journals, fixtures, receipts, build output, and Git history.

## Implementation slices

1. Scaffold `apps/coding-agent`, its `nervus-code` executable, and injectable `runCodingCli` interface.
2. Implement canonical workspace resolution, user-state partitioning, Session ID creation, `run`, `resume`, human streaming, and `--json` output.
3. Register the Coding Skill, root-instructions ContextContributor, existing local Tools, Model Adapter, and JSONL Journal exclusively through public Nervus interfaces.
4. Add deterministic fixture tests, then run and document the two opt-in DeepSeek acceptance tasks.
5. Update the completion audit and README only after all acceptance gates pass.

## Explicit non-goals

- Long-term Memory.
- YAML Agent configuration, Profiles, or HMR.
- UI, daemon, task queue, or distributed execution.
- Automatic Git worktrees, commits, pushes, Issues, or pull requests.
- Permissions, approval prompts, or a new sandbox model.
- MCP-specific Host behavior.
- New Agent Loop termination semantics or a `task/complete` Tool.
- Public npm release or compatibility guarantees for the Coding Host.
