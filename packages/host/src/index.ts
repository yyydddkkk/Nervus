import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import {
  instantiateCapabilityPlan,
  planCapabilityLibrary,
  type CapabilityIdentity,
  type CapabilityPlan,
  type CapabilityResolution,
} from "@nervus/capability-library";
import {
  mergeProfilePatch,
  resolveProfile,
  validateProfile,
  type HostProfileContract,
  type ProfileOverlay,
  type ProfileResolution,
  type ProfileSource,
} from "@nervus/profile";
import type { Plugin } from "cordis";
import {
  JsonlSessionJournal,
  MemorySessionJournal,
  createKernel,
  type Agent,
  type AgentSpec,
  type ContentBlock,
  type Kernel,
  type SessionJournal,
  type ToolAuthorizer,
  type ToolAuthorizerRef,
  type ToolAuthorizationDecision,
  type ToolCall,
  type ToolInvocationContext,
  yoloToolAuthorizer,
} from "nervus/core";

export type HostAssemblyErrorCode =
  | "HOST_CONSTRAINT"
  | "CONTRIBUTION_CONFLICT"
  | "INVALID_ASSEMBLY"
  | "STATE_CONFIGURATION"
  | "SESSION_PROFILE_MISMATCH"
  | "ASSEMBLY_FAILED";

export class HostAssemblyError extends Error {
  constructor(
    readonly code: HostAssemblyErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HostAssemblyError";
  }
}

export interface HostContribution {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
  readonly provides: readonly CapabilityIdentity[];
  readonly plugin: Plugin<void>;
}

export interface HostContract {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
  readonly hostType: string;
  readonly hostOptionsSchema: Readonly<Record<string, unknown>>;
  readonly runtime: Readonly<Record<string, "string" | "number" | "boolean">>;
  readonly defaults?: Readonly<Record<string, unknown>>;
  readonly builtInCapabilityRoots?: readonly string[];
  readonly contributions?: readonly HostContribution[];
  readonly validate?: (effective: Readonly<Record<string, unknown>>) => void;
  readonly defaultStateDirectory?: (input: {
    readonly profile: ProfileResolution;
    readonly runtime: Readonly<Record<string, unknown>>;
    readonly effective: Readonly<Record<string, unknown>>;
  }) => string;
  readonly resolveToolAuthorizer?: (
    effective: Readonly<Record<string, unknown>>,
    options: { readonly requireRuntime: boolean },
  ) => ToolAuthorizer;
}

export interface HostAssemblyOptions {
  readonly source: ProfileSource;
  readonly overlays?: readonly ProfileOverlay[];
  readonly cli?: Readonly<Record<string, unknown>>;
  readonly additiveCapabilityRoots?: readonly string[];
  readonly additiveCapabilities?: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runtime: Readonly<Record<string, unknown>>;
  readonly contract: HostContract;
  readonly contributions?: readonly HostContribution[];
}

export interface HostAssemblyResolution {
  readonly schemaVersion: 1;
  readonly digest: string;
  readonly host: {
    readonly id: string;
    readonly type: string;
    readonly version: string;
    readonly digest: string;
    readonly contributions: readonly {
      readonly id: string;
      readonly version: string;
      readonly digest: string;
      readonly provides: readonly CapabilityIdentity[];
    }[];
  };
  readonly profile: ProfileResolution;
  readonly capabilities: CapabilityResolution;
  readonly agent: unknown;
  readonly state: {
    readonly journal: "memory" | "jsonl";
    readonly directory?: string;
  };
  readonly execution: unknown;
  readonly toolAuthorizer: ToolAuthorizerRef;
  readonly typedAdditions: {
    readonly capabilityRoots: readonly string[];
    readonly capabilities: readonly string[];
  };
}

export interface HostAssembly {
  readonly kernel: Kernel;
  readonly agent: Agent;
  readonly agentSpec: AgentSpec;
  readonly journal: SessionJournal;
  readonly stateDirectory?: string;
  readonly resolution: HostAssemblyResolution;
  dispose(): Promise<void>;
}

interface PlannedHost {
  readonly profile: Awaited<ReturnType<typeof resolveProfile>>;
  readonly capabilityPlan: CapabilityPlan;
  readonly contributions: readonly HostContribution[];
  readonly agentSpec: AgentSpec;
  readonly journal: SessionJournal;
  readonly stateDirectory?: string;
  readonly execution: Readonly<Record<string, any>>;
  readonly toolAuthorizer: ToolAuthorizer;
  readonly resolution: HostAssemblyResolution;
}

export async function validateHostProfile(
  options: HostAssemblyOptions,
): Promise<{ readonly profile: ProfileResolution; readonly capabilities?: CapabilityResolution }> {
  const contract = profileContract(options.contract);
  const profile = await validateProfile({
    source: options.source,
    ...(options.overlays ? { overlays: options.overlays } : {}),
    ...(options.cli ? { cli: options.cli } : {}),
    env: {},
    runtime: {},
    contract,
  });
  const effective = profile.assembly;
  const capabilities = record(effective.capabilities);
  const declaredRoots = Array.isArray(capabilities.roots) ? capabilities.roots : [];
  const rootStrings = stringArray(declaredRoots);
  const roots = rootStrings.map((root) => resolve(profile.resolution.baseDirectory, root));
  if (roots.length === declaredRoots.length) {
    const contributions = collectContributions(options);
    const plan = await planCapabilityLibrary({
      roots: deduplicate([...(options.contract.builtInCapabilityRoots ?? []), ...roots, ...(options.additiveCapabilityRoots ?? [])]),
      select: deduplicate([...stringArray(capabilities.select), ...(options.additiveCapabilities ?? [])]),
      referenceConfigure: record(capabilities.configure),
      hostProvides: contributions.flatMap((item) => item.provides),
      mode: "validate",
    });
    return { profile: profile.resolution, capabilities: plan.resolution };
  }
  return { profile: profile.resolution };
}

export async function explainHost(
  options: HostAssemblyOptions,
): Promise<HostAssemblyResolution> {
  return (await planHost(options, false)).resolution;
}

export async function assembleHost(options: HostAssemblyOptions): Promise<HostAssembly> {
  let kernel: Kernel | undefined;
  try {
    const planned = await planHost(options, true);
    const capabilityPlugins = await instantiateCapabilityPlan(planned.capabilityPlan);
    kernel = await createKernel({
      journal: planned.journal,
      plugins: [
        ...planned.contributions.map((item) => item.plugin),
        ...capabilityPlugins,
      ],
      ...kernelOptions(planned.execution),
      toolAuthorizer: planned.toolAuthorizer,
    });
    const agent = await kernel.createAgent(planned.agentSpec);
    let disposal: Promise<void> | undefined;
    return Object.freeze({
      kernel,
      agent,
      agentSpec: planned.agentSpec,
      journal: planned.journal,
      ...(planned.stateDirectory ? { stateDirectory: planned.stateDirectory } : {}),
      resolution: planned.resolution,
      dispose(): Promise<void> {
        disposal ??= kernel!.dispose();
        return disposal;
      },
    });
  } catch (error) {
    if (kernel) await kernel.dispose();
    if (error instanceof HostAssemblyError || (error instanceof Error && error.name.endsWith("Error"))) {
      throw error;
    }
    throw new HostAssemblyError("ASSEMBLY_FAILED", "Host Assembly failed", { cause: error });
  }
}

export async function recordSessionAssembly(input: {
  readonly stateDirectory?: string;
  readonly sessionId: string;
  readonly action: "create" | "open";
  readonly resolution: HostAssemblyResolution;
  readonly profileExplicit: boolean;
  readonly now?: () => string;
}): Promise<{ readonly changed: boolean; readonly previousDigest?: string }> {
  if (!input.stateDirectory) return { changed: false };
  const root = resolve(input.stateDirectory, ".host-assembly");
  const resolutions = resolve(root, "resolutions");
  const sessions = resolve(root, "sessions");
  await Promise.all([mkdir(resolutions, { recursive: true }), mkdir(sessions, { recursive: true })]);
  const referencePath = resolve(sessions, `${Buffer.from(input.sessionId).toString("base64url")}.jsonl`);
  let previous: SessionAssemblyReference | undefined;
  try {
    const lines = (await readFile(referencePath, "utf8")).trim().split("\n").filter(Boolean);
    if (lines.length > 0) previous = JSON.parse(lines.at(-1)!) as SessionAssemblyReference;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  if (previous && previous.agentId !== agentId(input.resolution)) {
    throw new HostAssemblyError(
      "SESSION_PROFILE_MISMATCH",
      `Session ${input.sessionId} belongs to Agent ${previous.agentId}, not ${agentId(input.resolution)}`,
    );
  }
  if (previous?.profileSourceKind === "file" && !input.profileExplicit) {
    throw new HostAssemblyError(
      "SESSION_PROFILE_MISMATCH",
      `Session ${input.sessionId} requires an explicit --profile`,
    );
  }
  const resolutionPath = resolve(resolutions, `${input.resolution.digest}.json`);
  try {
    await writeFile(resolutionPath, `${JSON.stringify(input.resolution, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
  }
  const reference: SessionAssemblyReference = {
    schemaVersion: 1,
    timestamp: input.now?.() ?? new Date().toISOString(),
    action: input.action,
    sessionId: input.sessionId,
    assemblyDigest: input.resolution.digest,
    profileId: input.resolution.profile.profileId,
    profileSourceKind: input.resolution.profile.sourceKind,
    agentId: agentId(input.resolution),
  };
  await appendFile(referencePath, `${JSON.stringify(reference)}\n`, "utf8");
  return {
    changed: !!previous && previous.assemblyDigest !== input.resolution.digest,
    ...(previous ? { previousDigest: previous.assemblyDigest } : {}),
  };
}

interface SessionAssemblyReference {
  readonly schemaVersion: 1;
  readonly timestamp: string;
  readonly action: "create" | "open";
  readonly sessionId: string;
  readonly assemblyDigest: string;
  readonly profileId: string;
  readonly profileSourceKind: "file" | "data";
  readonly agentId: string;
}

async function planHost(
  options: HostAssemblyOptions,
  requireRuntime: boolean,
): Promise<PlannedHost> {
  const contract = profileContract(options.contract);
  const contributions = collectContributions(options);
  const commonProfileOptions = {
    source: options.source,
    ...(options.overlays ? { overlays: options.overlays } : {}),
    ...(options.cli ? { cli: options.cli } : {}),
    contract,
  };
  const validated = await validateProfile({
    ...commonProfileOptions,
    env: {},
    runtime: {},
  });
  const validatedCapabilities = record(validated.references.capabilities);
  const declaredRoots = Array.isArray(validatedCapabilities.roots)
    ? validatedCapabilities.roots
    : [];
  if (!declaredRoots.every((root) => typeof root === "string")) {
    throw new HostAssemblyError(
      "INVALID_ASSEMBLY",
      "Capability Roots must be literal paths so Package Schemas can be checked before reference resolution",
    );
  }
  await planCapabilityLibrary({
    roots: deduplicate([
      ...(options.contract.builtInCapabilityRoots ?? []),
      ...declaredRoots.map((root) => relativePath(validated.resolution.baseDirectory, root as string)),
      ...(options.additiveCapabilityRoots ?? []).map((root) => resolve(root)),
    ]),
    select: deduplicate([
      ...stringArray(validatedCapabilities.select),
      ...(options.additiveCapabilities ?? []),
    ]),
    referenceConfigure: record(validatedCapabilities.configure),
    hostProvides: contributions.flatMap((item) => item.provides),
    mode: "validate",
  });
  const profile = await resolveProfile({
    ...commonProfileOptions,
    env: options.env,
    runtime: options.runtime,
  });
  if (
    stable(validated.resolution.sources) !== stable(profile.resolution.sources) ||
    stable(validated.resolution.overlays) !== stable(profile.resolution.overlays)
  ) {
    throw new HostAssemblyError("INVALID_ASSEMBLY", "Profile sources changed during Host planning");
  }
  const effective = profile.assembly;
  try {
    options.contract.validate?.(effective);
  } catch (error) {
    if (error instanceof HostAssemblyError) throw error;
    throw new HostAssemblyError("HOST_CONSTRAINT", "Host required constraint failed", { cause: error });
  }
  const capabilities = record(effective.capabilities);
  const referenceCapabilities = record(profile.references.capabilities);
  const roots = deduplicate([
    ...(options.contract.builtInCapabilityRoots ?? []),
    ...stringArray(capabilities.roots).map((root) => relativePath(profile.resolution.baseDirectory, root)),
    ...(options.additiveCapabilityRoots ?? []).map((root) => resolve(root)),
  ]);
  const select = deduplicate([
    ...stringArray(capabilities.select),
    ...(options.additiveCapabilities ?? []),
  ]);
  const capabilityPlan = await planCapabilityLibrary({
    roots,
    select,
    configure: record(capabilities.configure),
    referenceConfigure: record(referenceCapabilities.configure),
    hostProvides: contributions.flatMap((item) => item.provides),
  });
  const agentSpec = toAgentSpec(record(effective.agent));
  validateAgentCapabilities(agentSpec, capabilityPlan.resolution, contributions);
  const state = resolveState(effective, profile.resolution, options);
  const execution = record(effective.execution);
  const toolAuthorizer = options.contract.resolveToolAuthorizer?.(
    effective,
    { requireRuntime },
  ) ?? yoloToolAuthorizer;
  const journal = state.kind === "memory"
    ? new MemorySessionJournal()
    : new JsonlSessionJournal({ directory: state.directory! });
  const withoutDigest = {
    schemaVersion: 1 as const,
    host: {
      id: options.contract.id,
      type: options.contract.hostType,
      version: options.contract.version,
      digest: options.contract.digest,
      contributions: contributions.map(({ id, version, digest, provides }) => ({ id, version, digest, provides })),
    },
    profile: profile.resolution,
    capabilities: capabilityPlan.resolution,
    agent: record(profile.resolution.effective).agent,
    state: {
      journal: state.kind,
      ...(state.directory ? { directory: state.directory } : {}),
    },
    execution,
    toolAuthorizer: {
      id: toolAuthorizer.id,
      revision: toolAuthorizer.revision,
    },
    typedAdditions: {
      capabilityRoots: [...(options.additiveCapabilityRoots ?? [])],
      capabilities: [...(options.additiveCapabilities ?? [])],
    },
  };
  const resolution: HostAssemblyResolution = deepFreeze({
    ...withoutDigest,
    digest: digest(stable(withoutDigest)),
  });
  return {
    profile,
    capabilityPlan,
    contributions,
    agentSpec: deepFreeze(agentSpec),
    journal,
    ...(state.directory ? { stateDirectory: state.directory } : {}),
    execution,
    toolAuthorizer,
    resolution,
  };
}

export type ToolApprovalDecision = "deny" | "allow-once" | "allow-turn";
export type ToolAuthorizationMode = "yolo" | "supervised";

export const toolAuthorizationHostOptionsSchema = Object.freeze({
  type: "object",
  properties: {
    toolAuthorization: {
      type: "object",
      properties: {
        mode: { enum: ["yolo", "supervised"] },
      },
      required: ["mode"],
      additionalProperties: false,
    },
  },
  required: ["toolAuthorization"],
  additionalProperties: false,
});

export const toolAuthorizationHostDefaults = Object.freeze({
  toolAuthorization: Object.freeze({ mode: "yolo" as const }),
});

export interface ToolApprovalAdapter {
  request(
    input: {
      readonly call: ToolCall;
      readonly context: ToolInvocationContext;
    },
  ): Promise<ToolApprovalDecision>;
}

export function createSupervisedToolAuthorizer(options: {
  readonly id: string;
  readonly revision: number;
  readonly autoAllowTools: readonly string[];
  readonly approval: ToolApprovalAdapter;
}): ToolAuthorizer {
  const autoAllow = new Set(options.autoAllowTools);
  const turnApprovals = new WeakMap<AbortSignal, Set<string>>();
  let promptTail: Promise<void> = Promise.resolve();
  const allow = Object.freeze({ status: "allow" } as const);

  return Object.freeze({
    id: options.id,
    revision: options.revision,
    authorize(
      call: ToolCall,
      context: ToolInvocationContext,
    ): ToolAuthorizationDecision | Promise<ToolAuthorizationDecision> {
      if (autoAllow.has(call.toolId)) return allow;
      const remembered = turnApprovals.get(context.signal);
      if (remembered?.has(call.toolId)) return allow;

      const request = () => raceApproval(
        options.approval.request({ call, context }),
        context.signal,
      );
      const decision = promptTail.then(request, request);
      promptTail = decision.then(() => undefined, () => undefined);
      return decision.then((result) => {
        if (result === "allow-turn") {
          const approved = remembered ?? new Set<string>();
          approved.add(call.toolId);
          if (!remembered) turnApprovals.set(context.signal, approved);
          return allow;
        }
        if (result === "allow-once") return allow;
        return {
          status: "deny" as const,
          reason: `Operator denied ${call.toolId}`,
        };
      });
    },
  });
}

export function resolveHostToolAuthorizer(
  effective: Readonly<Record<string, unknown>>,
  options: {
    readonly id: string;
    readonly revision: number;
    readonly autoAllowTools: readonly string[];
    readonly approval?: ToolApprovalAdapter;
    readonly requireRuntime: boolean;
  },
): ToolAuthorizer {
  const host = record(effective.host);
  const hostOptions = record(host.options);
  const authorization = record(hostOptions.toolAuthorization);
  if (authorization.mode !== "supervised") return yoloToolAuthorizer;
  if (options.requireRuntime && !options.approval) {
    throw new HostAssemblyError(
      "HOST_CONSTRAINT",
      "Supervised Mode requires an interactive Approval Adapter",
    );
  }
  return createSupervisedToolAuthorizer({
    id: options.id,
    revision: options.revision,
    autoAllowTools: options.autoAllowTools,
    approval: options.approval ?? unavailableApprovalAdapter,
  });
}

const unavailableApprovalAdapter: ToolApprovalAdapter = Object.freeze({
  async request() {
    throw new Error("Supervised Mode requires an interactive Approval Adapter");
  },
});

async function raceApproval<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function profileContract(contract: HostContract): HostProfileContract {
  return {
    hostType: contract.hostType,
    runtime: contract.runtime,
    schema: profileSchema(contract),
    defaults: mergeProfilePatch(commonDefaults(contract.hostType), contract.defaults ?? {}),
  };
}

function profileSchema(contract: HostContract): Readonly<Record<string, unknown>> {
  const positiveInteger = { type: "integer", minimum: 1 };
  const nonNegativeInteger = { type: "integer", minimum: 0 };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      profileVersion: { const: 2 },
      id: { type: "string", minLength: 1 },
      extends: { type: "string", minLength: 1 },
      host: {
        type: "object",
        properties: { type: { const: contract.hostType }, options: contract.hostOptionsSchema },
        required: ["type", "options"],
        additionalProperties: false,
      },
      capabilities: {
        type: "object",
        properties: {
          roots: { type: "array", items: { type: "string" }, uniqueItems: true, default: [] },
          select: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true, default: [] },
          configure: { type: "object", additionalProperties: true, default: {} },
        },
        required: ["roots", "select", "configure"],
        additionalProperties: false,
      },
      agent: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
          model: {
            type: "object",
            properties: {
              adapter: { type: "string", minLength: 1 },
              name: { type: "string", minLength: 1 },
              maxOutputTokens: positiveInteger,
            },
            required: ["adapter", "name"],
            additionalProperties: false,
          },
          instructions: {
            oneOf: [
              { type: "string" },
              { type: "array", items: contentBlockSchema() },
            ],
            default: [],
          },
          tools: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true, default: [] },
          skills: {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "string", minLength: 1 }, mode: { enum: ["eager", "available"] } },
              required: ["id", "mode"],
              additionalProperties: false,
            },
            default: [],
          },
          limits: {
            type: "object",
            properties: {
              maxSteps: positiveInteger,
              maxToolCalls: nonNegativeInteger,
              maxToolCallsPerStep: nonNegativeInteger,
              maxModelAttempts: positiveInteger,
            },
            additionalProperties: false,
          },
          timeouts: {
            type: "object",
            properties: { modelMs: positiveInteger, toolMs: positiveInteger },
            additionalProperties: false,
          },
        },
        required: ["id", "model", "instructions", "tools", "skills", "limits", "timeouts"],
        additionalProperties: false,
      },
      state: {
        type: "object",
        properties: {
          journal: {
            oneOf: [
              { type: "object", properties: { kind: { const: "memory" } }, required: ["kind"], additionalProperties: false },
              {
                type: "object",
                properties: { kind: { const: "jsonl" }, directory: { type: "string", minLength: 1 } },
                required: ["kind"],
                additionalProperties: false,
              },
            ],
          },
        },
        required: ["journal"],
        additionalProperties: false,
      },
      execution: {
        type: "object",
        properties: {
          concurrency: {
            type: "object",
            properties: {
              maxActiveTurns: positiveInteger,
              maxModelCalls: positiveInteger,
              maxToolCalls: positiveInteger,
            },
            required: ["maxActiveTurns", "maxModelCalls", "maxToolCalls"],
            additionalProperties: false,
          },
          retry: {
            type: "object",
            properties: { baseDelayMs: nonNegativeInteger, maxDelayMs: nonNegativeInteger },
            required: ["baseDelayMs", "maxDelayMs"],
            additionalProperties: false,
          },
        },
        required: ["concurrency", "retry"],
        additionalProperties: false,
      },
    },
    required: ["profileVersion", "id", "host", "capabilities", "agent", "state", "execution"],
    additionalProperties: false,
  };
}

function commonDefaults(hostType: string): Record<string, unknown> {
  return {
    profileVersion: 2,
    host: { type: hostType, options: {} },
    capabilities: { roots: [], select: [], configure: {} },
    agent: {
      instructions: [],
      tools: [],
      skills: [],
      limits: { maxSteps: 16, maxToolCalls: 64, maxToolCallsPerStep: 16, maxModelAttempts: 3 },
      timeouts: { modelMs: 60_000, toolMs: 60_000 },
    },
    state: { journal: { kind: "memory" } },
    execution: {
      concurrency: { maxActiveTurns: 8, maxModelCalls: 4, maxToolCalls: 16 },
      retry: { baseDelayMs: 100, maxDelayMs: 1_000 },
    },
  };
}

function contentBlockSchema(): Record<string, unknown> {
  return {
    oneOf: [
      { type: "object", properties: { type: { const: "text" }, text: { type: "string" } }, required: ["type", "text"], additionalProperties: false },
      { type: "object", properties: { type: { const: "json" }, value: {} }, required: ["type", "value"], additionalProperties: false },
      {
        type: "object",
        properties: { type: { enum: ["image", "resource"] }, uri: { type: "string" }, mediaType: { type: "string" } },
        required: ["type", "uri"],
        additionalProperties: false,
      },
    ],
  };
}

function toAgentSpec(agent: Readonly<Record<string, any>>): AgentSpec {
  const instructions: readonly ContentBlock[] = typeof agent.instructions === "string"
    ? [{ type: "text", text: agent.instructions }]
    : agent.instructions as readonly ContentBlock[];
  return {
    id: String(agent.id),
    model: {
      adapter: String(agent.model.adapter),
      model: String(agent.model.name),
      ...(typeof agent.model.maxOutputTokens === "number" ? { maxOutputTokens: agent.model.maxOutputTokens } : {}),
    },
    instructions,
    tools: [...agent.tools],
    skills: agent.skills.map((skill: any) => ({ id: skill.id, mode: skill.mode })),
    limits: { ...agent.limits },
    timeouts: { ...agent.timeouts },
  };
}

function validateAgentCapabilities(
  spec: AgentSpec,
  resolution: CapabilityResolution,
  contributions: readonly HostContribution[],
): void {
  const provided = new Set([
    ...resolution.packages.flatMap((item) => item.provides.map(identityKey)),
    ...contributions.flatMap((item) => item.provides.map(identityKey)),
    "tool:skills/activate",
  ]);
  const required = [
    `model:${spec.model.adapter}`,
    ...(spec.tools ?? []).map((id) => `tool:${id}`),
    ...(spec.skills ?? []).map((skill) => `skill:${skill.id}`),
  ];
  for (const identity of required) {
    if (!provided.has(identity)) {
      throw new HostAssemblyError("INVALID_ASSEMBLY", `Agent references an unavailable capability: ${identity}`);
    }
  }
}

function collectContributions(options: HostAssemblyOptions): readonly HostContribution[] {
  const contributions = [...(options.contract.contributions ?? []), ...(options.contributions ?? [])];
  const identities = new Map<string, string>();
  for (const contribution of contributions) {
    for (const provided of contribution.provides) {
      const key = identityKey(provided);
      const previous = identities.get(key);
      if (previous) {
        throw new HostAssemblyError("CONTRIBUTION_CONFLICT", `Host contributions conflict on ${key}: ${previous}, ${contribution.id}`);
      }
      identities.set(key, contribution.id);
    }
  }
  return Object.freeze(contributions);
}

function resolveState(
  effective: Readonly<Record<string, any>>,
  profile: ProfileResolution,
  options: HostAssemblyOptions,
): { kind: "memory" | "jsonl"; directory?: string } {
  const journal = record(record(effective.state).journal);
  if (journal.kind === "memory") return { kind: "memory" };
  if (journal.kind !== "jsonl") throw new HostAssemblyError("STATE_CONFIGURATION", "Unknown SessionJournal kind");
  let directory = typeof journal.directory === "string" ? relativePath(profile.baseDirectory, journal.directory) : undefined;
  directory ??= options.contract.defaultStateDirectory?.({ profile, runtime: options.runtime, effective });
  if (!directory) throw new HostAssemblyError("STATE_CONFIGURATION", "JSONL SessionJournal requires a directory");
  return { kind: "jsonl", directory: resolve(directory) };
}

function kernelOptions(execution: Readonly<Record<string, any>>) {
  return {
    concurrency: { ...record(execution.concurrency) },
    retry: { ...record(execution.retry) },
  };
}

function relativePath(base: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(base, path);
}

function agentId(resolution: HostAssemblyResolution): string {
  return String(record(resolution.agent).id);
}

function identityKey(identity: CapabilityIdentity): string {
  return `${identity.kind}:${identity.id}`;
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function deduplicate(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${stable(item[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
