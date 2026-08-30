# M13 Capability Library

Status: accepted on 2026-08-30; implementation not started.

## Outcome

M13 adds a shared filesystem Capability Library outside the Kernel. Hosts explicitly resolve trusted local Capability Packages and Bundles into standard Cordis Plugins plus a serializable CapabilityResolution. The runtime registries and Agent Loop remain unchanged.

## Domain boundary

- A Library Root is a Host-supplied directory containing Capability Package directories.
- One Package directory has one stable namespaced ID and one `capability.json` manifest.
- A Package may contribute an internally cohesive set of Tools, Skills, ContextContributors, Model Adapters, or other Plugin registrations without collapsing those concepts into one type.
- Installation only makes a Package resolvable. Enablement occurs through an explicit CapabilitySelection.
- M13 has built-in Roots plus additional Roots passed explicitly by a Host. It does not scan project or user directories automatically.

## Package contract

An executable Package contains a directly importable ESM entry and conceptually declares:

```json
{
  "schemaVersion": 1,
  "id": "nervus/filesystem",
  "version": "1.0.0",
  "kind": "plugin",
  "entry": "./index.js",
  "configSchema": "./config.schema.json",
  "provides": [
    { "kind": "tool", "id": "fs/read" },
    { "kind": "tool", "id": "fs/list" }
  ],
  "dependencies": []
}
```

The entry default-exports one synchronous `CapabilityFactory(config) -> Cordis Plugin`. The Loader validates selected configuration against the optional JSON Schema before invoking the Factory; configuration-free Packages receive an empty object. The Loader does not compile TypeScript, install npm dependencies, or run Package side effects during indexing.

A `kind: "bundle"` Package has no executable entry. It expands to declared member Package IDs and cannot bypass dependency, conflict, configuration, or audit rules.

## Resolution

The deep Host-side interface is:

```ts
resolveCapabilityLibrary({ roots, select, configure })
  -> Promise<{ plugins, resolution }>
```

Resolution:

1. canonicalizes explicit Roots and indexes manifests without importing entries;
2. validates each manifest and all declared paths inside its Package Root;
3. rejects duplicate Package IDs and duplicate declared contributions across Roots;
4. expands selected Bundles and Package-ID dependencies;
5. rejects missing dependencies and dependency cycles;
6. computes deterministic Package metadata and load order;
7. validates selected Package configuration;
8. imports only the resolved executable entries and invokes their CapabilityFactories.

M13 records Package versions but supports one Package per ID, no automatic precedence, no multi-version graph, and no semver-range solver.

CapabilityResolution serializes the original selection, expanded Package IDs and versions, content digests, dependencies, Bundle expansion, and load order. It contains no live Plugin object or secret value. Hosts store it with their startup evidence; M13 does not change SessionEvent or AgentSnapshot.

## Errors and lifecycle

`CapabilityLibraryError` uses stable codes for invalid manifests, duplicate IDs or contributions, missing dependencies, cycles, path escape, missing entry/resource, configuration failure, import failure, and invalid Factory or Plugin output. Any error prevents Host startup.

The Library owns only resolution. Hosts pass returned Plugins to `createKernel()`, after which Cordis and the Kernel exclusively own registration, leases, draining, and disposal. Removing a Package or changing selection affects the next Host startup; M13 has no watcher, HMR, runtime install, or Agent-controlled loading.

## Host adoption

Both existing Hosts become real consumers:

- `nervus` CLI resolves a shared filesystem Package;
- `nervus-code` resolves the same Package plus its Coding-specific capability selection.

M13 exposes serializable CapabilitySelection through a program interface and repeatable CLI flags such as `--capability-root` and `--capability`. Persistent Profile files remain M14 scope.

## Acceptance

Deterministic tests prove manifest validation, explicit selection, Bundle expansion, dependency ordering, missing/cyclic failure, duplicate rejection, path confinement, configuration validation before side effects, entry import, stable Resolution, and single Kernel lifecycle ownership. Cross-Host tests prove the same Package supplies capabilities to both existing Hosts without internal Kernel imports.

## Explicit non-goals

- Remote registries, download, copy, update, or uninstall commands.
- Automatic project/user directory scanning or root precedence.
- Sandboxing, signatures, permissions, or supply-chain policy.
- TypeScript compilation, HMR, runtime loading, or Agent installation.
- Multi-version dependency solving.
- Persistent Profile or YAML files.
