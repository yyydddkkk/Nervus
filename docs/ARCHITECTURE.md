# Nervus architecture blueprint

Status: accepted on 2026-08-30.

This document is the implementation blueprint agreed before Nervus development began. It defines the Kernel's responsibilities, domain semantics, module seams, execution rules, extension model, and staged scope. [CONTEXT.md](../CONTEXT.md) owns canonical vocabulary, [docs/adr](./adr) records hard-to-reverse decisions, and [IMPLEMENTATION.md](./IMPLEMENTATION.md) tracks delivery order.

## 1. Product boundary

Nervus is an embeddable TypeScript semantic kernel for general tool-using Agents, validated first through coding-agent scenarios. It is a library with a reference host, not an end-user Agent product.

Nervus prioritizes, in order:

1. Correct and deterministic semantics.
2. An implementation that can be understood locally.
3. Replayability and explainability.
4. Extension freedom through stable seams.
5. API stability, performance, and breadth of features.

The first release targets Node.js 22+, ESM, TypeScript, one process, and one machine. Cross-language, multi-process, and distributed execution are deferred.

### Engineering and host conventions

- The repository remains one private npm package during initial development. Source directories are modules, not independently versioned packages; a package is split only after it has a real independent release or dependency lifecycle.
- Hosts mount Cordis Plugins explicitly from TypeScript during `createKernel()` bootstrap. The Kernel does not scan directories or let AgentSpec load packages. YAML loading and HMR remain optional future host features.
- Library Adapters never choose hidden filesystem locations. In particular, a JSONL SessionJournal requires an explicit directory; a reference CLI may define its own documented default.
- The initial users are the project maintainers, so rapid experiments and breaking changes are allowed while the package remains private. Correct semantics and readable interfaces still take precedence over short-lived convenience.

## 2. Layering

```text
Skills / Tools / Model Adapters / MCP / Memory / Hosts
                         |
                         v
+------------------------------------------------------+
| Nervus Agent semantic kernel                         |
|                                                      |
| Agent Loop       Context Assembly     SessionJournal |
| Models           Tools                Skills         |
| Limits           Cancellation         Recovery       |
+------------------------------------------------------+
                         |
                         v
+------------------------------------------------------+
| Cordis plugin microkernel                            |
| Context / Service / Fiber / Effect / Events          |
+------------------------------------------------------+
```

Cordis supplies generic plugin composition and lifecycle. Nervus supplies Agent-specific semantics. The Cordis release is pinned exactly at project initialization and is not upgraded as part of routine maintenance; see ADR-0001.

Public Agent callers use the Nervus Kernel facade. Cordis types are allowed in Nervus implementations and Cordis Plugin authoring interfaces, but ordinary callers do not need to understand Cordis.

## 3. Required Kernel modules

Every ready Kernel contains these modules even when their registries are empty:

```text
Agents
Sessions
Models
Tools
Context
Skills
```

Their responsibilities are:

| Module | Responsibility |
| --- | --- |
| Agents | Resolve AgentSpecs against registered capabilities and create immutable AgentSnapshots for Turns. |
| Sessions | Accept Inputs, serialize Turns per Session, append SessionEvents, and expose projected state. |
| Models | Register Model Adapters, normalize streams and errors, apply retry/timeout/concurrency rules, and record usage. |
| Tools | Register Tools, validate inputs, execute ToolCalls, normalize ToolResults, and manage execution leases. |
| Context | Collect ContextBlocks, arbitrate the model input budget, and compile ModelRequestSnapshots. |
| Skills | Register declarative Skills and resolve eager or Turn-scoped activation. |

SessionJournal is a required Adapter used by Sessions. HistoryCompactor, MCP, Memory, Model Adapters, Tool sets, and hosts are optional.

## 4. Registration and plugin lifecycle

The Kernel has one root Cordis Context. Cordis Plugins mount during Kernel bootstrap and register named capabilities into global registries. AgentSpec selects from those registries; it never installs packages or mutates the Cordis plugin tree.

Stable capability identities should be readable and namespaced, for example:

```text
openai/chat
fs/read
shell/run
skills/research
```

Duplicate identities are registration errors. Replacement requires an explicit alias or override configuration; load order never silently chooses a winner.

Registration is lifecycle-owned:

```text
active -> draining -> disposed
```

Unregistration immediately hides a capability from new AgentSnapshots. Existing calls retain execution leases, and Cordis Plugin disposal waits for those leases before releasing resources.

## 5. Agent identity

AgentSpec is serializable data. It declares an Agent identity, a ModelRef, instructions, selected Tools and Skills, TurnLimits, timeouts, and other options.

Agent is the live resolved actor stored by the Agents module. Session refers to an Agent identity rather than copying its declaration.

At the start of every Turn, Agents resolves the current AgentSpec once and freezes an AgentSnapshot. A running Turn is unaffected by later AgentSpec or registry changes. Later Turns in the same Session may use a newer AgentSnapshot.

An AgentSnapshot records at least:

- Agent identity and declaration revision.
- ModelRef and resolved Model Adapter identity.
- Selected Tool and Skill identities and revisions.
- ContextContributor identities.
- Effective limits and timeout configuration.

It records identity and configuration, not plugin source code.

## 6. Execution hierarchy

```text
Session
└── Turn
    └── Step
        ├── ModelCall
        └── ToolCall[] -> ToolResult[]
```

Nervus deliberately does not introduce `Run`; it overlaps with Turn. A future durable background abstraction should use a distinct term such as Job.

### Session

A Session owns durable history and a FIFO Input queue. Exactly one Turn may be active in a Session. Different Sessions may execute concurrently.

### Turn

A Turn consumes one accepted Input and reaches exactly one terminal status:

```text
completed
exhausted
cancelled
interrupted
failed
```

A Turn completes normally when a ModelCall produces no ToolCalls. It continues when ToolCalls are present, even if that model response also contains text. It becomes exhausted when a TurnLimit is reached, cancelled when explicitly aborted, interrupted when a process disappears during execution, and failed on an unrecoverable model or Kernel failure.

### Step

A Step contains one ModelCall and every ToolCall produced by that model response. ToolResults are incorporated before the next Step starts.

## 7. Agent Loop

The default loop is:

```text
accept Input
  -> append input/accepted
  -> wait for the Session lane
  -> freeze AgentSnapshot
  -> append turn/started and user/message

repeat:
  -> assemble ModelRequestSnapshot
  -> execute one ModelCall
  -> record assistant content and ToolCalls

  if no ToolCalls:
    -> append turn/completed
    -> return final output

  otherwise:
    -> execute same-Step ToolCalls
    -> append every ToolResult in original call order
    -> start the next Step
```

Every external side effect is bracketed by durable lifecycle events. If the SessionJournal cannot record the prerequisite fact, the side effect does not begin.

## 8. SessionJournal and projections

SessionEvents are the sole source of truth; see ADR-0002. Mutable Session views are deterministic projections:

```text
SessionEvent[] -> project() -> SessionView
```

Every event has a versioned envelope:

```ts
interface EventEnvelope<T> {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  sequence: number;
  timestamp: string;
  type: T["type"];
  payload: T;
}
```

The SessionJournal appends a non-empty event batch atomically with an expected revision. Sessions uses an in-process per-Session lane for normal serialization, while the Journal's revision check enforces the final consistency invariant.

Initial durable event families include:

```text
input/accepted
turn/started | completed | exhausted | cancelled | interrupted | failed
user/message
step/started | completed
model/call-started | attempt-started | attempt-failed | call-completed | call-failed | call-interrupted
assistant/message
tool/call-started | call-completed | call-cancelled | call-failed | call-interrupted
skill/activated
compaction/completed
```

Model token deltas and Tool progress are transient Cordis events, not SessionEvents. A completed normalized model result is durable; a partial stream never masquerades as a complete assistant message.

## 9. Input queue and recovery

An Input arriving during an active Turn is immediately persisted as `input/accepted` and waits in FIFO order. It does not become a user message and cannot enter the active Turn's context.

When processing begins, `turn/started(inputId)` consumes that Input and a corresponding `user/message` fact is appended.

After process restart, Nervus reconstructs Session history and queued Inputs. A Turn that was active without a terminal event becomes interrupted. The Kernel does not automatically repeat its ModelCall or ToolCall; the caller may issue a new Input, and a future explicit resume feature may define stricter behavior.

## 10. Models

Agent Loop speaks only the normalized Models interface:

```ts
generate(request, context): AsyncIterable<ModelEvent>
```

The event vocabulary supports at least:

```text
output/text-delta
output/reasoning-delta
tool-call/start
tool-call/arguments-delta
tool-call/end
usage
response/completed
response/failed
```

A non-streaming Adapter converts its response into the same event stream.

Model Adapter performs one provider attempt and classifies failure as retryable, non-retryable, or aborted. Models owns retry timing, attempt records, timeout, cancellation, and concurrency. Retries stay on the same ModelRef; cross-model fallback is a separate future policy because it can change behavior.

Model capabilities include context-window size, maximum output size, Tool and image support, and an optional token counter. Context uses exact counting when available and a conservative estimate otherwise.

Every ModelCall records the normalized ModelRequestSnapshot used before provider-specific request conversion.

## 11. Tools

A Tool declares a stable identity, description, JSON Schema input, and execution interface. Tools validates generated arguments before calling the Tool implementation.

Tool execution receives only the arguments and minimum execution context:

```text
callId
sessionId
turnId
stepId
AbortSignal
progress reporter
```

It does not receive mutable Session state or write SessionEvents directly. Tools brackets execution with facts and returns normalized content blocks.

ToolResult content supports text, JSON, image references, and resource references. Initial implementations may only emit text and JSON.

All failures inside the ToolCall boundary become an error ToolResult, including timeout, thrown exceptions, and process failure. A missing model response, SessionJournal failure, or Kernel invariant violation cannot be represented as a ToolResult because no valid ToolCall owns that failure.

### Same-Step concurrency

ToolCalls from one model response execute concurrently with collect-all behavior; see ADR-0004. One Tool failure does not cancel siblings. The next ModelCall receives one ToolResult for every ToolCall, ordered exactly as the model emitted the calls.

If the model requires dependency ordering, it emits the dependent ToolCall in a later Step after seeing the first ToolResult. Nervus does not infer dependencies or invent a `dependsOn` extension.

## 12. Model context assembly

ContextContributor returns only its own ContextBlocks. It cannot inspect and mutate a shared draft or replace blocks from another source; see ADR-0003.

Context uses stable named layers:

```text
kernel
agent
skill
memory
runtime
history
```

A ContextBlock includes identity, source, layer, content type, layer-local order, retention, token estimate, and optional truncation behavior.

Retention is one of:

```text
required
preferred
optional
```

Assembly follows these rules:

1. Collect blocks from active contributors.
2. Reject duplicate identities and structurally invalid blocks.
3. Sort by named layer and stable layer-local order.
4. Reserve model output tokens and a safety margin.
5. Drop optional blocks before preferred blocks.
6. Use a block's declared truncation behavior when necessary.
7. Fail explicitly if required blocks alone exceed the input budget.
8. Compile the normalized request and record an assembly report.

The Kernel handles structural precedence, not natural-language contradiction detection. Conflicting prose remains attributable and ordered; plugins cannot secretly erase each other.

## 13. Skills

Skill is declarative data containing:

- Stable identity.
- Discovery name and description.
- Instruction content.
- Optional resources.

Skill is not a second executable plugin system. A Cordis Plugin may register Skills, and executable behavior belongs in Tools.

AgentSpec selects Skills in one of two modes:

- `eager`: full instructions enter every Turn.
- `available`: only discovery metadata is initially visible.

The model activates an available Skill through the built-in `skills/activate` Tool. Its complete instructions enter Context beginning with the next Step and remain active only for the rest of the current Turn. Persistent behavior should be configured as eager rather than requiring deactivation state.

## 14. MCP, Memory, and Prompt

MCP is an Adapter concern, not an Agent Loop primitive. An MCP Cordis Plugin owns connection lifecycle and maps remote capabilities into Tools, Skills, and ContextContributor registrations.

Memory is initially an ordinary Cordis Plugin. It may listen to SessionEvents, write its own storage, contribute retrieved ContextBlocks, and register explicit memory Tools. A required Memories module will be introduced only after multiple implementations demonstrate a stable common seam.

Prompt has no independent registry in the first architecture. Prompt content enters through AgentSpec, Skill, and ContextContributor, while the final prompt/request is an output of Context assembly.

## 15. Compaction

Compaction is explicit and durable, never silent deletion. A successful Compaction records:

- The Session event range it represents.
- Normalized summary content.
- The ModelCall that generated it.

Original SessionEvents remain unchanged. History assembly uses the latest applicable Compaction plus later context-relevant events.

When Context reports `NeedsCompaction`, Agent Loop coordinates HistoryCompactor and retries pure assembly. HistoryCompactor may use a dedicated ModelRef and defaults to the Agent's ModelRef. If compaction retries fail, the Turn fails instead of silently dropping history.

Automatic Compaction remains the next implementation milestone.

## 16. Cancellation, timeouts, and shutdown

Cancellation propagates hierarchically:

```text
Kernel
└── Session runtime
    └── Turn
        └── Step
            ├── ModelCall
            └── ToolCall
```

Cancelling a Turn preserves the Session and queued Inputs. Each ModelCall and ToolCall also has a timeout implemented by its owning module.

Kernel disposal is immediate cancellation rather than graceful draining:

```text
ready -> disposing -> disposed
```

`dispose()` rejects new work, aborts active Turns, waits for cancellation facts and execution leases to settle, then disposes the root Cordis Fiber. Queued Inputs remain durable for a later Kernel start.

## 17. Concurrency and execution limits

One Session has one active Turn. Across Sessions, configurable semaphores limit:

- Active Turns.
- ModelCalls.
- ToolCalls.

Waiting for a semaphore remains abortable.

TurnLimits bound total work:

```ts
interface TurnLimits {
  maxSteps: number;
  maxToolCalls: number;
  maxToolCallsPerStep: number;
  maxModelAttempts: number;
}
```

Per-call timeouts and maximum output tokens are separate controls. Token usage is recorded but not cumulatively budgeted in the first release. Monetary cost enforcement is deferred.

## 18. Public interface direction

The facade should remain small and Agent-oriented:

```ts
const kernel = await createKernel(options);

const agent = await kernel.createAgent(spec);
const session = await kernel.createSession({
  id: "session-1",
  agentId: agent.id,
});

const result = await session.send({
  content: [{ type: "text", text: "Inspect this project" }],
});

await kernel.dispose();
```

`kernel.context` remains an advanced Cordis escape hatch for plugin experiments. It is not the ordinary execution interface.

Nervus is private and versioned `0.0.0` during development. This section expresses interface direction, not a compatibility promise.

## 19. Errors

Call-interface and invariant failures use a typed KernelError with a stable code, initially including:

```text
INVALID_AGENT_SPEC
REGISTRATION_CONFLICT
SESSION_CONFLICT
CONTEXT_OVERFLOW
KERNEL_DISPOSING
INVARIANT_VIOLATION
```

Tool operation failures remain ToolResults. Turn outcomes remain SessionEvents and projected statuses. Raw provider errors do not leak as the public error model.

## 20. Testing seams

Behavior tests cross only confirmed public seams:

- Kernel facade lifecycle.
- Agent and Session interfaces.
- Model, Tool, and SessionJournal Adapter interfaces at external-system seams.

Tests do not mock Nervus internal modules or inspect private state. Scripted Model Adapters, deterministic Tools, memory Journal Adapters, injected time, and injected identities make behavior repeatable.

Required behavior includes:

- Event replay produces the same Session view.
- Same-Step Tools execute concurrently while results remain ordered.
- Revision conflicts fail rather than reorder history.
- Cancellation reaches active ModelCalls and ToolCalls.
- Model stream interruption never creates a completed assistant message.
- Queued Inputs never enter the active Turn.
- Plugin disposal waits for active execution leases.
- Context assembly and its budget report are deterministic.

## 21. Initial delivery scope

The first usable release includes:

- Kernel facade and required modules.
- AgentSpec resolution and AgentSnapshot.
- Session, Turn, Step, ModelCall, ToolCall, and ToolResult.
- Memory and JSONL SessionJournal Adapters.
- Scripted and OpenAI-compatible Model Adapters.
- Context assembly and ModelRequestSnapshot.
- Tool validation, same-Step concurrency, cancellation, retry, and limits.
- eager and available Skills.
- `fs/read`, `fs/write`, and `shell/run` reference Tools.
- Replay and interrupted recovery.

Explicitly deferred:

- Memory plugins.
- Automatic Compaction.
- YAML loader, overlays, and HMR.
- UI and distributed execution.
- Permissions, approvals, and sandboxing.
- Cross-model fallback.
- Public npm release and API stability guarantees.

Delivery order and milestone acceptance are maintained in [IMPLEMENTATION.md](./IMPLEMENTATION.md).

## 22. Kernel invariants

These statements should remain true across implementations:

1. No Agent side effect begins before its prerequisite SessionEvent is durable.
2. SessionEvent order is monotonic and guarded by expected revision.
3. One Session never has two active Turns.
4. One Turn uses exactly one frozen AgentSnapshot.
5. Every ModelCall and ToolCall has one terminal outcome or becomes interrupted after recovery.
6. Every model-issued ToolCall receives exactly one ordered ToolResult before the next Step.
7. Context contributors cannot mutate or remove another source's blocks.
8. A model never receives context that lacks a recorded ModelRequestSnapshot.
9. A partial model stream never becomes a completed assistant message.
10. Kernel disposal leaves no active execution lease.
