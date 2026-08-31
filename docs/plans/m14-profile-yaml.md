# M14 Profile and YAML assembly

Status: implemented and verified on 2026-08-31.

## Outcome

M14 delivered the first typed Profile Loader and strict YAML v1 serialization, including inheritance, ordered merge patches, structured references, secret redaction, and partial adoption by both Hosts. It proved the Host-side configuration boundary but did not complete runtime assembly: Agent identity/instructions/limits/timeouts, Kernel controls, Journal selection, Host options, and provider connection settings remained partly or wholly hard-coded. Complete Profile-driven runtime assembly is M15 scope.

## Profile boundary

A v1 Profile is a named assembly declaration, not an AgentSpec alias. Its broad `agent`, `state`, and Host sections reserved the intended assembly shape while M14 Hosts consumed only model name, CapabilitySelection, Tools, and Skills. M15 replaces this incomplete shape with strict Profile v2 rather than silently changing v1.

A Profile never contains task Inputs, reasoning steps, Package installation, Session history, long-term Memory, or literal secret values. Multi-Agent topology and workflows remain deferred until a real Host requires them.

The shared Profile Loader accepts a HostProfileContract containing the expected Host type, a strict Schema for `host.options`, and a typed whitelist of available runtime bindings. It returns ordinary data used by the Host to resolve the Capability Library, construct KernelOptions, create one Agent, and open or create Sessions. The Kernel has no Profile Module and does not parse YAML.

## Source and composition

Every document requires `profileVersion: 1` and a stable Profile ID. M14 accepts a strict YAML 1.2 data subset and rejects duplicate keys, unknown fields, custom tags, merge keys, anchors, and aliases before strict Profile Schema validation.

A Profile may have one `extends` parent. Parent paths resolve relative to the declaring file, must remain inside Host-supplied Profile Roots after realpath canonicalization, and may not form a cycle. Multiple inheritance and remote sources are invalid.

Composition order implemented by M14 is the resolved parent chain, current Profile, Host-supplied overlays from left to right, explicit CLI patch, Schema validation, and structured value-reference resolution. Effective Schema-default expansion is added by M15.

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

The v1 Host contract can mark sensitive fields with `x-secret: true`; those fields accept only `$env` references and ProfileResolution remains redacted. Because v1 Host Schemas treated nested Capability configuration permissively, enforcing Package-owned `x-secret` metadata before reference resolution is completed in M15.

## Resolution and lifecycle

ProfileResolution records Profile identity, source and content digests, extends chain, overlay/CLI digests, secret reference sources, redacted normalized configuration, and an optional composed CapabilityResolution. M15 introduces the complete HostAssemblyResolution and effective-default summary.

The Loader parses, composes, resolves references, and validates the complete Profile before CapabilityFactory invocation or any Plugin effect. A Profile is read once and frozen for the Host lifetime. File changes require an explicit restart; M14 has no watcher, HMR, online Agent mutation, or per-Turn reload.

`ProfileError` exposes stable codes for YAML syntax, unsupported constructs, Schema failure, path escape, missing parent, inheritance cycle, Host type mismatch, runtime reference failure, environment reference failure, and secret literals. All Loader failures precede Plugin mounting.

## Acceptance

Deterministic tests cover strict parsing, unknown and duplicate keys, forbidden YAML constructs, parent resolution and cycles, Profile Root confinement, merge order, array replacement, optional-field clearing, Host contracts, Capability configuration, runtime references, secret rejection/redaction, stable ProfileResolution, and failure before Plugin side effects.

Both existing Hosts load equivalent Profiles while retaining their different Host options and Agent behavior. Existing TypeScript assembly remains the programmatic escape hatch and correctness oracle for the YAML path.

## Explicit non-goals

- Multiple Agents, Agent routing, or workflow graphs.
- Package installation, remote Profile sources, or automatic directory scanning.
- Runtime Profile edits, watchers, HMR, or per-Turn reload.
- Arbitrary interpolation, executable YAML, or command substitution.
- Literal credentials, secret persistence, or Session history.
