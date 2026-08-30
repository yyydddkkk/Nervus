# Centralize model context assembly

Extensions contribute attributable ContextBlocks and cannot mutate blocks produced by other sources. The Context module owns stable layering, identity checks, token-budget arbitration, compilation, and the ModelRequestSnapshot so that the exact context seen by a model remains deterministic and explainable.
