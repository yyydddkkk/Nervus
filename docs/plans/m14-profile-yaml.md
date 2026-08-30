# M14 Profile and YAML assembly

Status: accepted on 2026-08-30; implementation not started.

## Outcome

M14 defines a typed Profile model and a strict YAML serialization for one complete Host assembly. A Profile selects and configures one primary Agent, Capability Packages, Model behavior, state, execution controls, and Host options. Profile loading remains outside the Kernel and finishes before Plugin side effects.

## Profile boundary

A Profile is a named assembly declaration, not an AgentSpec alias. It contains one AgentSpec as a subset alongside Host, CapabilitySelection, Package configuration, Model, Journal/state, and runtime controls.

A Profile never contains task Inputs, reasoning steps, Package installation, Session history, long-term Memory, or literal secret values. Multi-Agent topology and workflows remain deferred until a real Host requires them.

The shared Profile Loader accepts a HostProfileContract containing the expected Host type, a strict Schema for `host.options`, and a typed whitelist of available runtime bindings. It returns ordinary data used by the Host to resolve the Capability Library, construct KernelOptions, create one Agent, and open or create Sessions. The Kernel has no Profile Module and does not parse YAML.

## Source and composition

Every document requires `profileVersion: 1` and a stable Profile ID. M14 accepts a strict YAML 1.2 data subset and rejects duplicate keys, unknown fields, custom tags, merge keys, anchors, and aliases before strict Profile Schema validation.

A Profile may have one `extends` parent. Parent paths resolve relative to the declaring file, must remain inside Host-supplied Profile Roots after realpath canonicalization, and may not form a cycle. Multiple inheritance and remote sources are invalid.

Composition order is:

1. Schema defaults;
2. the resolved parent chain;
3. the current Profile;
4. Host-supplied overlays from left to right;
5. explicit CLI flags;
6. structured value-reference resolution.

Parent, child, and overlays use deterministic JSON-Merge-Patch-like rules: mappings merge recursively, scalars replace, complete sequences replace, and `null` clears only optional fields. Arrays never concatenate implicitly.

## Capability and value configuration

Capability Package and Bundle IDs live in `capabilities.select`. Package configuration lives separately in `capabilities.configure`, keyed by Package ID, so a Profile can configure members selected indirectly through a Bundle.

Values may use only explicit structured references:

```yaml
root:
  $runtime: workspace
apiKey:
  $env: OPENAI_API_KEY
```

The HostProfileContract defines allowed runtime names and types. Unknown or type-incompatible references fail. Environment values do not act as implicit overrides and arbitrary string interpolation or command substitution is forbidden.

Host and Capability config Schemas mark sensitive fields with `x-secret: true`. Secret fields accept only `$env` references, never literals. Resolved values exist only in the in-memory assembly; logs, errors, ProfileResolution, receipts, and Journals retain only the environment variable name plus a redacted marker.

## Resolution and lifecycle

ProfileResolution records Profile identity/version, source and content digests, the extends chain, ordered overlay digests, explicit CLI override fields, normalized effective configuration with unresolved/redacted secret references, CapabilityResolution, and a non-sensitive final assembly summary.

The Loader parses, composes, resolves references, and validates the complete Profile before CapabilityFactory invocation or any Plugin effect. A Profile is read once and frozen for the Host lifetime. File changes require an explicit restart; M14 has no watcher, HMR, online Agent mutation, or per-Turn reload.

`ProfileError` exposes stable codes for YAML syntax, unsupported YAML constructs, Schema failure, unknown fields, path escape, missing parent, inheritance cycle, Host type mismatch, runtime reference failure, secret literal, overlay failure, Capability configuration failure, and Resolution failure. All failures prevent partial Host startup.

## Acceptance

Deterministic tests cover strict parsing, unknown and duplicate keys, forbidden YAML constructs, parent resolution and cycles, Profile Root confinement, merge order, array replacement, optional-field clearing, Host contracts, Capability configuration, runtime references, secret rejection/redaction, stable ProfileResolution, and failure before Plugin side effects.

Both existing Hosts load equivalent Profiles while retaining their different Host options and Agent behavior. Existing TypeScript assembly remains the programmatic escape hatch and correctness oracle for the YAML path.

## Explicit non-goals

- Multiple Agents, Agent routing, or workflow graphs.
- Package installation, remote Profile sources, or automatic directory scanning.
- Runtime Profile edits, watchers, HMR, or per-Turn reload.
- Arbitrary interpolation, executable YAML, or command substitution.
- Literal credentials, secret persistence, or Session history.
