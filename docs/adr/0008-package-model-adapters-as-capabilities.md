---
status: accepted
---

# Package Model Adapters as capabilities

Nervus configures and registers Model Adapters through explicitly selected Capability Packages instead of giving Profiles or Hosts a provider-specific model-connection path. A Profile's AgentSpec references the registered Adapter identity and model name, while credentials and connection settings belong to that Package's validated configuration; this keeps model implementations on the same pluggable lifecycle as other optional capabilities without pushing package loading into the Kernel.
