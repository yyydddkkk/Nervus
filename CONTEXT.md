# Nervus

Nervus is an embeddable semantic kernel for model-driven agents. This glossary defines the language used across its runtime, events, tests, and documentation.

## Agent identity

**Kernel**:
The runtime that resolves Agents, accepts Inputs, and coordinates their recorded execution.
_Avoid_: Harness, platform, application

**AgentSpec**:
A serializable declaration of an Agent's model, instructions, Tools, Skills, limits, and options.
_Avoid_: Agent config, agent definition

**Agent**:
A live executable actor resolved from an AgentSpec and the capabilities registered in a Kernel.
_Avoid_: Bot, assistant

**AgentSnapshot**:
An immutable record of the exact Agent capabilities selected for one Turn.
_Avoid_: Agent copy, runtime config

## Execution

**Session**:
The durable ordered history and input queue shared by a sequence of Turns.
_Avoid_: Thread, conversation, chat

**Input**:
An external request accepted into a Session and waiting to be consumed by a Turn.
_Avoid_: Prompt, query

**Turn**:
The bounded processing of one accepted Input until completion, exhaustion, cancellation, interruption, or failure.
_Avoid_: Run, request

**Step**:
One model decision within a Turn together with the ToolCalls it produces and their ToolResults.
_Avoid_: Iteration, cycle

**ModelCall**:
A recorded exchange in which a normalized model request produces a stream of model events and one terminal outcome.
_Avoid_: Completion, inference

**ToolCall**:
A model-requested invocation of one registered Tool within a Step.
_Avoid_: Action, function call

**ToolResult**:
The normalized success or error content corresponding to exactly one ToolCall.
_Avoid_: Tool response, output

## Context

**ContextBlock**:
An attributable unit of candidate model context with a layer and retention policy.
_Avoid_: Prompt fragment, context chunk

**ContextContributor**:
A named source that produces its own ContextBlocks without modifying blocks from other sources.
_Avoid_: Prompt hook, context middleware

**ModelRequestSnapshot**:
The immutable normalized request and assembly report recorded for one ModelCall.
_Avoid_: Prompt snapshot, request log

**Skill**:
A named declarative capability containing discovery metadata, instructions, and optional resources.
_Avoid_: Workflow plugin, executable skill

**Compaction**:
A recorded summary that represents a specified range of older Session history without deleting its original events.
_Avoid_: Truncation, deletion

## Facts

**SessionEvent**:
An immutable versioned fact appended to a Session's ordered history.
_Avoid_: Log message, notification

**SessionJournal**:
The authoritative ordered record of SessionEvents for all Sessions.
_Avoid_: Session repository, event log
