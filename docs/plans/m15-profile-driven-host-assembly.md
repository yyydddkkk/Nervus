# M15 Profile-driven Host Assembly

Status: implemented and verified on 2026-08-31.

## Outcome

M15 turns Profile loading into one complete, reusable Host Assembly path. A strict Profile v2, or an equivalent in-memory declaration, determines one complete AgentSpec, CapabilitySelection and Package configuration, Journal state, Kernel execution controls, and Host options. The shared `@nervus/host` package resolves those inputs into a frozen HostAssembly used by both `nervus` and `nervus-code`.

The Kernel remains unchanged in responsibility. It does not parse YAML, discover Packages, choose filesystem locations, or understand HostAssemblyResolution. A Profile contains no task Input, Session history, reasoning plan, Memory, multi-Agent graph, or executable code.

## Corrected M14 boundary

M14 delivered the strict YAML v1 Loader, inheritance and merge semantics, structured environment/runtime references, redacted ProfileResolution, and partial adoption by both Hosts. It did not wire the complete declared assembly into runtime behavior: Agent identity, instructions, limits, timeouts, Kernel controls, Journal selection, Host options, and provider connection configuration remained partly or wholly Host-owned. M15 closes that integration gap instead of treating Profile as a partial patch over hard-coded Hosts.

M15 introduces `profileVersion: 2`. A v1 document fails with a stable migration error and a pointer to the v2 shape; it is never silently reinterpreted. Repository examples and tests migrate directly because Nervus remains private and has no compatibility promise.

## Profile v2

The canonical shape is:

```yaml
profileVersion: 2
id: deepseek-coder

host:
  type: nervus-cli
  options: {}

capabilities:
  roots: [./capabilities]
  select:
    - nervus/openai-compatible
    - nervus/filesystem
  configure:
    nervus/openai-compatible:
      baseUrl: https://api.deepseek.com
      apiKey:
        $env: DEEPSEEK_API_KEY
      compatibility: deepseek
      capabilities:
        contextWindow: 128000
        maxOutputTokens: 8192
        supportsTools: true
      extraBody:
        thinking:
          type: enabled
    nervus/filesystem:
      root:
        $runtime: workspace

agent:
  id: coding-agent
  model:
    adapter: openai-compatible/chat
    name: deepseek-v4-flash
    maxOutputTokens: 8192
  instructions: |
    Inspect evidence before making claims and report Tool failures honestly.
  tools: [fs/read, fs/list, fs/write, shell/run]
  skills: []
  limits:
    maxSteps: 24
    maxToolCalls: 64
    maxToolCallsPerStep: 8
    maxModelAttempts: 32
  timeouts:
    modelMs: 300000
    toolMs: 60000

state:
  journal:
    kind: jsonl

execution:
  concurrency:
    maxActiveTurns: 8
    maxModelCalls: 4
    maxToolCalls: 16
  retry:
    baseDelayMs: 100
    maxDelayMs: 1000
```

Profile ID identifies the assembly declaration. `agent.id` independently identifies the Agent and is required. Multiple Profiles may assemble different revisions of the same Agent.

`agent.instructions` accepts either a text string shorthand or the strict ContentBlock array accepted by AgentSpec. M15 does not add file interpolation; larger instruction sets and attached resources belong to Skills or Capability Packages.

Model connection configuration belongs to the selected Model Adapter Package. `agent.model` contains only ModelRef data: Adapter identity, provider model name, and optional output limit. Literal secrets remain forbidden wherever a Package Schema marks `x-secret: true`.

## Sources, paths, and composition

`assembleHost()` accepts either a file-backed Profile or serializable in-memory Profile data with an explicit base directory. Hosts without `--profile` generate a named in-memory v2 Profile and use exactly the same assembly path.

Composition order is:

1. universal Schema defaults;
2. Host defaults;
3. one `extends` parent chain;
4. the entry Profile;
5. repeatable ordered `--overlay` files or programmatic overlays;
6. predefined typed CLI overrides;
7. Host required-constraint validation;
8. structured `$env` and `$runtime` reference resolution;
9. effective-default expansion and freezing.

Mapping values merge recursively, scalars replace, arrays replace, and `null` deletes only optional fields. Typed `--capability` and `--capability-root` are explicit additive operations applied after merge and recorded separately; they do not change general array semantics.

`extends` resolves relative to the file that declares it. Every other relative Profile path resolves against the entry Profile directory, or the explicit base directory for in-memory data. Profiles remain explicit: Hosts do not scan workspaces or user directories for default filenames.

`profiles validate` parses sources, validates structural Schemas and secret-reference shapes, and does not require environment values. `profiles explain` requires all referenced runtime/environment values and produces the complete redacted plan without importing Package entries, invoking factories, mounting Plugins, or creating a Kernel.

## Capability planning and instantiation

The Capability Library separates declarative planning from executable instantiation:

```ts
planCapabilityLibrary(options): Promise<CapabilityPlan>
instantiateCapabilityPlan(plan): Promise<readonly CordisPlugin[]>
```

Planning canonicalizes explicit Roots; validates manifests, configuration Schemas, Package paths, declared artifacts, dependencies, Bundles, duplicate identities, HostContribution conflicts, and stable load order; and resolves structured config values without importing executable entries. Instantiation re-verifies planned content digests, imports entries, invokes factories, and returns standard Cordis Plugins.

`resolveCapabilityLibrary()` remains as a compatibility convenience that calls both phases. A CapabilityPlan and its redacted CapabilityResolution contain no live Plugin or secret value.

Executable manifests gain an optional `artifacts` array. Package content identity hashes the manifest, entry, optional config Schema, and every explicitly declared artifact in stable path order. All paths are confined to the Package directory and symbolic-link escapes fail. Nervus/Host build versions are recorded separately; M15 does not hash transitive npm dependencies.

## OpenAI-compatible Model Adapter Package

The built-in `nervus/openai-compatible` Capability Package provides the static Model Adapter identity `openai-compatible/chat`. One Host Assembly configures one endpoint. DeepSeek is a compatibility configuration, not a separate Package.

Its strict Package Schema supports:

- `baseUrl` and secret `apiKey`;
- `compatibility: openai | deepseek`;
- optional `instructionRole: developer | system`;
- Model capabilities including context/output limits and Tool/image support;
- additional headers whose `$env` values remain redacted;
- `extraBody` provider extensions.

`extraBody` may not override `model`, `messages`, `tools`, `stream`, or `stream_options`, which remain Adapter-owned protocol fields. Multiple named endpoints and dynamic Adapter identities remain deferred.

## Shared Host Assembly

`@nervus/host` exports one high-level operation:

```ts
assembleHost(options): Promise<HostAssembly>
```

A HostContract supplies its stable Host type, strict `host.options` Schema, runtime-binding types, effective defaults, required constraints, built-in Capability Roots, state defaults, and named HostContributions. A HostContribution declares ID, version, content digest, provided identities, and one Cordis Plugin. Raw unattributed Plugin arrays are not accepted.

The planner rejects any duplicate identity between HostContributions or Capability Packages. Neither source silently wins. Host defaults are overrideable; Host required constraints are explicit and fail when violated. Host-specific workspace behavior, AGENTS Context, and presentation remain Host responsibilities and are recorded as contributions rather than hidden effects.

HostAssembly exposes the ready Kernel, primary Agent, effective AgentSpec, state information, HostAssemblyResolution, and an idempotent `dispose()`. It owns every resource acquired during assembly. Failure after any acquisition triggers reverse-order cleanup and never returns a partial assembly.

The HostAssemblyResolution is immutable, serializable, and secret-redacted. It records effective defaults and typed overrides, source and overlay digests, Host identity and contributions, CapabilityPlan/Resolution, Agent identity and effective semantic configuration, Journal and Kernel control summaries, and a final assembly digest.

## State and attributable resume

Profile v2 selects `memory` or `jsonl` Journal state. JSONL may specify a directory; otherwise the generic Profile Host uses a user-level state directory partitioned by a hash of the canonical entry Profile path. Moving a Profile creates a new default partition, while an explicit directory enables recovery or migration. `nervus-code` retains its canonical-workspace partition. The legacy generated generic Profile retains workspace-local state for compatibility.

HostAssemblyResolutions are written immutably by content digest. Every Session create/open invocation appends a secret-redacted reference to the assembly digest. A Profile-backed Session must be resumed with an explicit `--profile`; the Host never reloads a remembered path automatically.

A Session may resume under a changed Profile only when `agent.id` matches the Session's durable Agent identity. The Host visibly reports an assembly change and appends the new Resolution reference. Every Turn continues to freeze and durably record its exact AgentSnapshot. A changed Agent identity fails before accepting a new Input.

## Host and CLI adoption

Both `nervus` and `nervus-code` use `@nervus/host`; neither retains a second manual Profile wiring path. Programmatic deterministic tests inject ScriptedModel through an attributable HostContribution.

The generic CLI remains:

```text
nervus chat [--profile FILE] [--overlay FILE] [--workspace PATH] [prompt]
nervus sessions list|inspect|resume ...
nervus profiles validate FILE
nervus profiles explain FILE [--workspace PATH] [--json]
```

No generic `nervus run` command is added. With a prompt, `chat` executes one Input/Turn and exits; without a prompt, it remains interactive. `run` remains only the established Coding Host command for creating a new coding Session and is not a Kernel domain entity.

The generic workspace is optional unless a runtime reference or selected capability requires it. The Coding Host always requires one. CLI `--capability` and `--capability-root` add and deduplicate values. Human output remains streamed; one-shot `--json` keeps stdout to one final machine record while activity goes to stderr.

## Errors and safety of assembly

Profile, Capability, and Host Assembly failures keep stable namespaced error codes. M15 adds explicit codes for unsupported Profile version, invalid instruction blocks, missing workspace/runtime, Host constraint failure, Host/Package contribution conflict, changed planned content, state configuration, Session/Profile mismatch, and partial assembly failure.

Secret values may exist only in the private in-memory path between reference resolution and CapabilityFactory invocation. They are absent from errors, resolutions, state metadata, SessionJournals, CLI JSON, receipts, and test snapshots. Capability config `x-secret` enforcement occurs against the Package Schema before resolving `$env`, closing the permissive nested-config gap in v1.

## Delivery sequence

1. Correct M14 documentation and implement strict Profile v2, defaults, sources, overlays, reference phases, and migration errors.
2. Split Capability planning/instantiation, add artifact digests, and package the OpenAI-compatible Adapter.
3. Add `@nervus/host`, HostContract/Contribution, state resolution, HostAssemblyResolution, and lifecycle ownership.
4. Migrate both Hosts and add Profile validation/explanation, Overlay, optional generic workspace, resume attribution, and JSON one-shot output.
5. Complete deterministic and live acceptance, leak scans, evidence, documentation, and completion audit.

Independent tests and documentation may proceed in parallel, but the integration chain follows these dependencies.

## Acceptance

Deterministic acceptance proves:

- v1 rejection and complete strict v2 parsing;
- Profile/Agent identity separation, instruction shorthand, effective defaults, merge precedence, typed additions, base-directory paths, overlays, and source kinds;
- static validation without env values and full explanation with required values but no executable import;
- Package secret enforcement, reserved-body rejection, artifact digest changes, plan/instantiate digest verification, and conflict errors;
- HostContribution attribution, shared assembly, complete AgentSpec/Kernel/Journal wiring, idempotent disposal, and partial-failure cleanup;
- generated no-Profile compatibility in both Hosts;
- optional generic workspace and required Coding workspace;
- immutable Resolution storage, explicit Profile resume, same-Agent Profile changes, changed-Agent rejection, and visible warnings;
- no generic `run` command and stable `chat` one-shot/interactive semantics;
- a third-party fixture Host assembles only through public `@nervus/host` exports.

Live DeepSeek acceptance runs disposable generic and Coding scenarios through v2 Profiles, verifies real Tool use and repository modification, resumes one Session after a Profile change, compares durable AgentSnapshots and Resolution references, and scans all artifacts for the API key. Raw provider responses and state remain ignored; sanitized evidence is committed.

The repository completion gate remains:

```sh
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
```

## Explicit non-goals

- Capability installation, update, removal, scaffolding, remote registries, or automatic scanning.
- Concrete Memory, multi-Agent routing, workflow graphs, or a durable Job abstraction.
- Multiple configured endpoints per Model Adapter Package or cross-model fallback.
- Permissions, approvals, sandboxing, signatures, or supply-chain verification.
- HMR, Profile watchers, UI, distributed execution, npm publication, or API compatibility guarantees.
