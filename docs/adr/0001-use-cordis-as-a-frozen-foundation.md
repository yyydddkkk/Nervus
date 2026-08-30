# Use Cordis as a frozen foundation

Nervus uses the current Cordis release as its plugin microkernel and pins that version exactly. Agent semantics live in Nervus modules, while Cordis supplies context, services, fibers, effects, events, and plugin lifecycle; Nervus does not track future Cordis releases or maintain a speculative compatibility layer.
