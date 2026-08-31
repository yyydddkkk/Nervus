---
status: accepted
---

# Mediate ToolCalls through one Host-selected Tool Authorizer

Nervus mediates every model-issued ToolCall through exactly one Host-selected Tool Authorizer, defaulting to a synchronous allow-all Adapter for YOLO Mode; the Authorizer may narrow but never expand the Authority Ceiling frozen by the AgentSnapshot's Tool selection and trusted Tool Adapters. The Kernel owns the single pre-execution seam and records the Authorizer identity without interpreting Host modes, while Hosts own YOLO and Supervised policy and the deployment environment owns process and resource isolation. This deliberately rejects a Kernel resource-policy language, multiple ordered Authorizers, and built-in sandboxing so authorization adds no model-visible work, no extra Journal append, and negligible YOLO hot-path cost.
