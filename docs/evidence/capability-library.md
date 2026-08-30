# Capability Library acceptance receipt

Date: 2026-08-31.

`tests/capability-library.test.ts` constructs disposable Library Roots and proves strict Ajv 2020-12 manifest/config validation, explicit Bundle expansion, dependency ordering, configured CapabilityFactories, stable SHA-256 Resolution records, duplicate rejection, missing dependencies, cycles, path confinement, invalid configuration, and invalid Factory exports.

The built-in `nervus/filesystem` Package supplies `fs/read`, `fs/list`, `fs/write`, and `shell/run`. Both `nervus` and `nervus-code` resolve it through `@nervus/capability-library`, accept repeatable extra root/selection flags, and persist sanitized `capability-resolution.json` before Kernel startup.
