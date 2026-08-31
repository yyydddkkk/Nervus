---
status: accepted
---

# Version complete Profile assembly as v2

Nervus assigns `profileVersion: 2` to the first Profile schema whose fields fully drive Host Assembly, including the complete AgentSpec, Package-owned Model Adapter configuration, state, and Kernel execution controls. M14's incomplete v1 shape receives an explicit migration error instead of being silently reinterpreted or permanently supported alongside v2; this preserves the meaning of the version discriminator while the project is still private and inexpensive to migrate.
