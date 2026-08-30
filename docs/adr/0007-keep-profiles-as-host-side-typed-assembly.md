---
status: accepted
---

# Keep Profiles as Host-side typed assembly

Nervus defines Profile as a typed Host assembly model with strict YAML as one serialization, resolved and frozen before Plugin effects. The shared Profile Loader remains outside the Kernel so configuration files, overlays, environment references, and Host-specific options do not become Agent Loop semantics.
