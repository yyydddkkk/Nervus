# Isolate reference Hosts as private workspace packages

Nervus uses a pnpm workspace with the Kernel package at the repository root and each substantial reference Host as a private package under `apps/`. This replaces the original single-package convention: a separate Host package makes package-root imports enforceable and lets real applications expose missing public seams, while remaining private avoids premature release and compatibility commitments.
