---
status: accepted
---

# Resolve Capability Packages outside the Kernel

Nervus places filesystem discovery, manifest validation, dependency resolution, and trusted Package loading in a shared Host-side Capability Library that returns standard Cordis Plugins. This keeps install and assembly policy out of required Kernel modules while preserving one registration and lifecycle system after resolution.
