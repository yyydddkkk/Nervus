# Nervus

Nervus is an embeddable semantic kernel for model-driven agents. This glossary defines the language used across its runtime, events, tests, and documentation.

## Agent identity

**Kernel**:
The runtime that resolves Agents, accepts Inputs, and coordinates their recorded execution.
_Avoid_: Harness, platform, application

**Host**:
An application that embeds a Kernel, registers its Adapters and Plugins, accepts external input, and presents execution results. A Host may configure and select a Model Adapter for an Agent, but it does not perform model reasoning or participate in the Agent Loop.
_Avoid_: Kernel, Agent

**Host Assembly**:
A frozen in-memory composition of one Host's Kernel, primary Agent, selected capabilities, state Adapter, and attributable configuration resolutions. It is produced before the Host accepts external input.
_Avoid_: Launcher, runtime, Agent

**HostAssemblyResolution**:
An immutable, serializable, and secret-redacted account of the effective inputs, defaults, provenance, and component resolutions that produced one Host Assembly.
_Avoid_: ProfileResolution, Session snapshot, runtime config

**HostContribution**:
A named and attributable capability or constraint supplied by a Host because it is required for that Host to uphold its external contract. It is not an Agent-selected Capability Package and may not be hidden from the HostAssemblyResolution.
_Avoid_: Hidden Plugin, Profile default, Tool

**Capability Library**:
A filesystem catalog from which Hosts explicitly select reusable capability packages for registration into a Kernel. It is not a runtime registry and does not make Tools, Skills, or Plugins the same domain concept.
_Avoid_: Runtime registry, plugin scanner, Resource library

**Capability Package**:
A named, versioned unit selected from a Capability Library that contributes one cohesive set of capabilities to a Host assembly. Availability in a Library does not enable the Package.
_Avoid_: Plugin, installed capability, resource

**CapabilitySelection**:
A serializable declaration of the Capability Package and Bundle identities that a Host explicitly enables for one Library resolution.
_Avoid_: Installed packages, runtime registry

**CapabilityPlan**:
A validated, ordered, and serializable plan for selected Capability Packages that is produced without importing executable Package entries or invoking their factories.
_Avoid_: CapabilityResolution, dry run, Plugin list

**Profile**:
A named serializable declaration of how a Host assembles one complete AgentSpec, CapabilitySelection and Package configuration, state, execution controls, and Host options. A Profile does not describe Agent reasoning steps or persist Session history.
_Avoid_: AgentSpec, workflow, Session snapshot

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

**Model Adapter**:
A named capability that connects normalized ModelCalls to one provider-facing inference protocol. An AgentSpec references a registered Model Adapter but does not contain its credentials or connection configuration.
_Avoid_: Model, provider

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

**Memory**:
Durable knowledge retrieved across Sessions and contributed to a Turn as relevant Context. Memory does not include a Session's event history, a SessionJournal implementation, or Compaction.
_Avoid_: Session history, Journal, Compaction

## Facts

**SessionEvent**:
An immutable versioned fact appended to a Session's ordered history.
_Avoid_: Log message, notification

**SessionJournal**:
The authoritative ordered record of SessionEvents for all Sessions.
_Avoid_: Session repository, event log
