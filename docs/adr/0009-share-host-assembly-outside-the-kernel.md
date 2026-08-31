---
status: accepted
---

# Share Host Assembly outside the Kernel

Nervus provides a shared Host-side assembly package that resolves a Profile, CapabilitySelection, state Adapter, Kernel options, and one complete AgentSpec into a frozen Host Assembly. The generic and Coding Hosts reuse this package while retaining their own input, workspace, and presentation behavior; keeping assembly outside the Kernel prevents file formats and Host policy from entering Agent Loop semantics while giving third-party Hosts one supported composition seam. Host-required behavior enters through named HostContributions recorded in the HostAssemblyResolution rather than hidden registration effects. The Host Assembly owns Kernel disposal and every resource acquired during assembly, including reverse-order cleanup after partial startup failure.
