# M15 Profile-driven Host Assembly evidence

Acceptance date: 2026-08-31.

Command:

```sh
pnpm smoke:deepseek:assembly
```

The harness rebuilt all workspace packages, created disposable v2 Profiles and workspaces under ignored `.nervus/m15-live`, and used the configured DeepSeek OpenAI-compatible endpoint through the packaged `nervus/openai-compatible` Model Adapter.

## Generic Profile Host

- Session: `m15-generic`.
- Two completed Turns under one durable Session.
- First assembly digest: `40ec8885c1cad57085a433cad456214d9e79e8d5fc1a395c281ad45e2ea2222f`.
- Changed-Profile assembly digest: `50e74465717d377a6433dc35d878a1dd89e998c6acca9fea90a5c805ac2a24fd`.
- The resume invocation visibly reported the assembly change.
- Immutable Session assembly history contained both digest references.
- Real ToolCalls: `fs/list`, `fs/read`, `fs/read`.
- Both Turns completed and the model reported values independently read from `project.json`.
- One-shot `--json` produced a single final stdout record while streamed activity remained on stderr.

## Coding Profile Host

- Session: `m15-coding`.
- One completed coding Turn assembled entirely from Profile v2 plus the Coding HostContribution.
- Real ToolCalls: `fs/list`, `shell/run`, `fs/list`, `fs/list`, `fs/read`, `fs/read`, `fs/read`, `fs/read`, `fs/write`, `shell/run`, `shell/run`.
- The seeded multiplication defect was repaired.
- Independent `npm test` passed after the Turn.
- Independent Git inspection found exactly one changed file: `src/math.js`.

## Secret and durability checks

- The Profile used `{ "$env": "OPENAI_API_KEY" }`; the resolved API key reached the CapabilityFactory in memory and real provider calls succeeded.
- A recursive byte scan covered Profiles, HostAssemblyResolutions, CapabilityResolutions, Session assembly references, SessionJournals, workspaces, captured CLI records, and the raw receipt.
- API-key matches: zero.
- The committed evidence contains no raw provider response or secret value.

## Deterministic gate

Before the live run:

- 17 test files passed.
- 75 deterministic tests passed.
- Coverage thresholds passed at 85.54% statements, 73.41% branches, 90.61% functions, and 89.20% lines.
- TypeScript checks passed for the Kernel, Capability Library, Profile Loader, Host Assembly, and Coding Host.
- The ordered workspace build passed through Capability Library → Profile → core → Host Assembly → full Kernel → Coding Host.
