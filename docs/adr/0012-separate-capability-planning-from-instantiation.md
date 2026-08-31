---
status: accepted
---

# Separate Capability planning from instantiation

The Capability Library first produces a side-effect-free CapabilityPlan by reading and validating declarative Package data, then instantiates that frozen plan by importing entries and invoking factories. This split lets Hosts validate and explain a complete assembly without executing trusted Package code, while startup uses the exact same plan before handing instantiated Plugins to the Kernel lifecycle.
