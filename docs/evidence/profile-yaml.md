# Profile/YAML acceptance receipt

Date: 2026-08-31.

`tests/profile-loader.test.ts` proves strict YAML parsing, forbidden YAML features, single-parent inheritance, ordered merge-patch overlays and CLI overrides, Root confinement, inheritance-cycle detection, Host contracts, `$env`/`$runtime` resolution, secret-literal rejection, missing-env failure, and redacted ProfileResolution.

The generic CLI and Reference Coding Host integration tests prove `--profile` can select Model names, Capability Packages/configuration, and Agent Tools/Skills. Each Host persists a ProfileResolution composed with CapabilityResolution; resolved secret values remain in memory and are absent from persisted evidence.
