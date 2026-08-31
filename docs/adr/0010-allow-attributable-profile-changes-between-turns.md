---
status: accepted
---

# Allow attributable Profile changes between Turns

A Host may resume an existing Session with a changed Profile only when the Agent identity is unchanged. The Host must persist each secret-redacted HostAssemblyResolution immutably by content digest, append the Resolution reference for every Session start or resume, and visibly report an assembly change, while the Kernel continues to freeze the effective AgentSnapshot for each Turn; this preserves intentional Agent evolution without silently changing the actor attached to a Session.
