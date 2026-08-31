import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assembleHost,
  explainHost,
  recordSessionAssembly,
  resolveHostToolAuthorizer,
  toolAuthorizationHostDefaults,
  toolAuthorizationHostOptionsSchema,
  validateHostProfile,
  type HostAssembly,
  type HostAssemblyOptions,
  type HostContract,
  type HostContribution,
  type ToolApprovalAdapter,
} from "@nervus/host";
import type { ProfileOverlay, ProfileSource } from "@nervus/profile";
import type { Plugin } from "cordis";

import type { ModelAdapter } from "../models/model.js";
import { JsonlSessionJournal } from "../sessions/jsonl-journal.js";
import { projectSession } from "../sessions/projection.js";
import type { Session, TurnResult } from "../sessions/session.js";

export interface CliIO {
  write(text: string): void;
  writeError(text: string): void;
  readLines(): AsyncIterable<string>;
  onInterrupt(handler: () => void): () => void;
  closeInput?(): void;
}

export interface RunNervusCliOptions {
  readonly io: CliIO;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly modelAdapter?: ModelAdapter;
  readonly approvalAdapter?: ToolApprovalAdapter;
}

interface ParsedOptions {
  readonly workspace?: string;
  readonly stateDirectory?: string;
  readonly sessionId?: string;
  readonly createNew: boolean;
  readonly prompt: string;
  readonly capabilityRoots: readonly string[];
  readonly capabilities: readonly string[];
  readonly profile?: string;
  readonly overlays: readonly string[];
  readonly model?: string;
  readonly json: boolean;
  readonly toolAuthorizationMode?: "yolo" | "supervised";
}

export async function runNervusCli(
  argv: readonly string[],
  options: RunNervusCliOptions,
): Promise<number> {
  try {
    const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
    const [command, subcommand] = normalizedArgv;
    if (command === "chat") {
      return await runChat(parseOptions(normalizedArgv.slice(1)), options, "chat");
    }
    if (command === "sessions" && subcommand === "resume") {
      const sessionId = normalizedArgv[2];
      if (!sessionId) throw new Error("sessions resume requires a Session ID");
      return await runChat(parseOptions(normalizedArgv.slice(3), { sessionId }), options, "resume");
    }
    if (command === "sessions" && subcommand === "list") {
      return await runSessionQuery("list", undefined, parseOptions(normalizedArgv.slice(2)), options);
    }
    if (command === "sessions" && subcommand === "inspect") {
      const sessionId = normalizedArgv[2];
      if (!sessionId) throw new Error("sessions inspect requires a Session ID");
      return await runSessionQuery("inspect", sessionId, parseOptions(normalizedArgv.slice(3), { sessionId }), options);
    }
    if (command === "profiles" && (subcommand === "validate" || subcommand === "explain")) {
      const file = normalizedArgv[2];
      if (!file) throw new Error(`profiles ${subcommand} requires a Profile file`);
      return await runProfileCommand(subcommand, resolve(file), parseOptions(normalizedArgv.slice(3)), options);
    }
    writeUsage(options.io);
    return command ? 1 : 0;
  } catch (error) {
    options.io.writeError(`${formatError(error)}\n`);
    return 1;
  }
}

async function runProfileCommand(
  command: "validate" | "explain",
  profile: string,
  parsed: ParsedOptions,
  options: RunNervusCliOptions,
): Promise<number> {
  const invocation = assemblyOptions({ ...parsed, profile }, options);
  const result = command === "validate"
    ? await validateHostProfile(invocation)
    : await explainHost(invocation);
  options.io.write(`${JSON.stringify(result, null, parsed.json ? 0 : 2)}\n`);
  return 0;
}

async function runSessionQuery(
  command: "list" | "inspect",
  sessionId: string | undefined,
  parsed: ParsedOptions,
  options: RunNervusCliOptions,
): Promise<number> {
  let assembly: HostAssembly | undefined;
  const journal = parsed.profile
    ? (assembly = await assembleHost(assemblyOptions(parsed, options))).journal
    : new JsonlSessionJournal({ directory: legacyStateDirectory(parsed) });
  try {
    if (command === "list") {
      for (const id of await journal.list()) options.io.write(`${id}\n`);
      return 0;
    }
    const events = await journal.read(sessionId!);
    if (events.length === 0) throw new Error(`Session does not exist: ${sessionId}`);
    options.io.write(`${JSON.stringify({
      snapshot: projectSession(sessionId!, events),
      eventCounts: countValues(events.map((event) => event.type)),
      usage: collectUsage(events),
    }, null, 2)}\n`);
    return 0;
  } finally {
    await assembly?.dispose();
  }
}

async function runChat(
  parsed: ParsedOptions,
  options: RunNervusCliOptions,
  action: "chat" | "resume",
): Promise<number> {
  if (parsed.workspace) await mkdir(parsed.workspace, { recursive: true });
  const assembly = await assembleHost(assemblyOptions(parsed, options));
  const { kernel, journal } = assembly;
  let session: Session | undefined;
  let active = false;
  let exitRequested = false;
  let reasoningCharacters = 0;
  const announcedCompactions = new Set<string>();
  const removeTextListener = kernel.context.on("model/text-delta", (update) => {
    if (update.purpose === "compaction") {
      if (!announcedCompactions.has(update.modelCallId)) {
        announcedCompactions.add(update.modelCallId);
        options.io.writeError("[compacting history]\n");
      }
      return;
    }
    if (parsed.json) options.io.writeError(update.delta);
    else options.io.write(update.delta);
  });
  const removeReasoningListener = kernel.context.on("model/reasoning-delta", (update) => {
    if (update.purpose !== "compaction") reasoningCharacters += update.delta.length;
  });
  const removeProgressListener = kernel.context.on("tool/progress", (update) => {
    options.io.writeError(`[progress ${update.toolId}] ${contentText(update.content)}\n`);
  });
  const removeInterrupt = options.io.onInterrupt(() => {
    if (active && session?.cancelActiveTurn("CLI interrupt")) {
      options.io.writeError("\n[cancelled active Turn]\n");
      return;
    }
    exitRequested = true;
    options.io.closeInput?.();
  });

  try {
    const sessionId = parsed.sessionId ?? `session-${randomUUID()}`;
    const exists = (await journal.list()).includes(sessionId);
    if (parsed.createNew && exists) throw new Error(`Session already exists: ${sessionId}`);
    if (action === "resume" && !exists) throw new Error(`Session does not exist: ${sessionId}`);
    const attribution = await recordSessionAssembly({
      ...(assembly.stateDirectory ? { stateDirectory: assembly.stateDirectory } : {}),
      sessionId,
      action: exists ? "open" : "create",
      resolution: assembly.resolution,
      profileExplicit: !!parsed.profile,
    });
    if (attribution.changed) {
      options.io.writeError(`[assembly changed ${attribution.previousDigest} -> ${assembly.resolution.digest}]\n`);
    }
    session = exists
      ? await kernel.openSession({ id: sessionId })
      : await kernel.createSession({ id: sessionId, agentId: assembly.agent.id });
    options.io.writeError(`[session ${sessionId}]\n`);

    if (parsed.prompt) {
      const result = await executeInput(session, parsed.prompt);
      if (parsed.json) {
        options.io.write(`${JSON.stringify({ sessionId, turn: result, assemblyDigest: assembly.resolution.digest })}\n`);
      }
      return result.status === "completed" ? 0 : 1;
    }

    if (parsed.json) throw new Error("--json requires a one-shot prompt");
    options.io.write("nervus> ");
    for await (const line of options.io.readLines()) {
      if (exitRequested) break;
      const input = line.trim();
      if (!input) {
        options.io.write("nervus> ");
        continue;
      }
      if (input === "/exit" || input === "exit") break;
      await executeInput(session, input);
      if (!exitRequested) options.io.write("nervus> ");
    }
    return 0;
  } finally {
    removeInterrupt();
    removeProgressListener();
    removeReasoningListener();
    removeTextListener();
    await assembly.dispose();
  }

  async function executeInput(target: Session, input: string): Promise<TurnResult> {
    active = true;
    reasoningCharacters = 0;
    const before = (await target.events()).length;
    try {
      const result = await target.send({ content: [{ type: "text", text: input }] });
      if (!parsed.json) options.io.write("\n");
      const events = (await target.events()).slice(before);
      const toolCalls = events.filter((event) => event.type === "tool/call-started").length;
      const toolErrors = events.filter((event) => event.payload.type === "tool/call-completed" && event.payload.result.status === "error").length;
      const failure = [...events].reverse().find((event) =>
        event.payload.type === "turn/failed" ||
        event.payload.type === "turn/cancelled" ||
        event.payload.type === "turn/exhausted");
      if (failure?.payload.type === "turn/failed") options.io.writeError(`[error] ${failure.payload.error}\n`);
      else if (failure?.payload.type === "turn/cancelled") options.io.writeError(`[cancelled] ${failure.payload.reason}\n`);
      else if (failure?.payload.type === "turn/exhausted") options.io.writeError("[exhausted] TurnLimits reached\n");
      options.io.writeError(`[turn ${result.status}; tools=${toolCalls}; errors=${toolErrors}; reasoningChars=${reasoningCharacters}]\n`);
      return result;
    } finally {
      active = false;
    }
  }
}

function assemblyOptions(parsed: ParsedOptions, options: RunNervusCliOptions): HostAssemblyOptions {
  const env = options.env ?? process.env;
  const contribution = options.modelAdapter ? modelContribution(options.modelAdapter) : undefined;
  const source = parsed.profile
    ? ({ kind: "file", file: parsed.profile, roots: [dirname(parsed.profile)] } satisfies ProfileSource)
    : generatedProfile(parsed, env, options.modelAdapter);
  const runtime: Record<string, unknown> = {};
  if (parsed.workspace) runtime.workspace = parsed.workspace;
  const cli: Record<string, unknown> = {};
  if (parsed.model) cli.agent = { model: { name: parsed.model } };
  if (parsed.stateDirectory) cli.state = { journal: { kind: "jsonl", directory: parsed.stateDirectory } };
  if (parsed.toolAuthorizationMode) {
    cli.host = {
      options: {
        toolAuthorization: { mode: parsed.toolAuthorizationMode },
      },
    };
  }
  const overlays: ProfileOverlay[] = parsed.overlays.map((file) => ({ kind: "file", file }));
  return {
    source,
    ...(overlays.length > 0 ? { overlays } : {}),
    ...(Object.keys(cli).length > 0 ? { cli } : {}),
    additiveCapabilityRoots: parsed.capabilityRoots,
    additiveCapabilities: parsed.capabilities,
    env,
    runtime,
    contract: genericContract(env, options.approvalAdapter),
    ...(contribution ? { contributions: [contribution] } : {}),
  };
}

function generatedProfile(
  parsed: ParsedOptions,
  env: Readonly<Record<string, string | undefined>>,
  injected?: ModelAdapter,
): ProfileSource {
  if (!parsed.workspace) throw new Error("--workspace is required without --profile");
  const modelName = parsed.model ?? (injected ? env.OPENAI_MODEL ?? "scripted" : requiredValue(env, "OPENAI_MODEL"));
  const select = ["nervus/filesystem"];
  const configure: Record<string, unknown> = {
    "nervus/filesystem": { root: { $runtime: "workspace" } },
  };
  if (!injected) {
    select.unshift("nervus/openai-compatible");
    const compatibility = optionalEnum(env.OPENAI_COMPATIBILITY, ["openai", "deepseek"] as const, "OPENAI_COMPATIBILITY");
    const instructionRole = optionalEnum(env.OPENAI_INSTRUCTION_ROLE, ["developer", "system"] as const, "OPENAI_INSTRUCTION_ROLE");
    configure["nervus/openai-compatible"] = {
      baseUrl: requiredValue(env, "OPENAI_BASE_URL"),
      apiKey: { $env: "OPENAI_API_KEY" },
      ...(compatibility ? { compatibility } : {}),
      ...(instructionRole ? { instructionRole } : {}),
      ...(compatibility === "deepseek"
        ? { extraBody: { thinking: { type: "enabled" }, reasoning_effort: env.DEEPSEEK_REASONING_EFFORT ?? "high" } }
        : {}),
    };
  }
  return {
    kind: "data",
    label: "nervus-cli-default",
    baseDirectory: parsed.workspace,
    value: {
      profileVersion: 2,
      id: "nervus-cli-default",
      host: { type: "nervus-cli", options: {} },
      capabilities: { roots: [], select, configure },
      agent: {
        id: "nervus-cli-agent",
        model: { adapter: injected?.id ?? "openai-compatible/chat", name: modelName, maxOutputTokens: 8_192 },
        instructions: "You are a Tool-using Agent operating in an explicit workspace. Use relative paths, inspect evidence before making claims, and report Tool failures honestly.",
        tools: ["fs/read", "fs/list", "fs/write", "shell/run"],
        skills: [],
        limits: { maxSteps: 24, maxToolCalls: 64, maxToolCallsPerStep: 8, maxModelAttempts: 32 },
        timeouts: { modelMs: 300_000, toolMs: 60_000 },
      },
      state: { journal: { kind: "jsonl", directory: parsed.stateDirectory ?? resolve(parsed.workspace, ".nervus/sessions") } },
      execution: {
        concurrency: { maxActiveTurns: 8, maxModelCalls: 4, maxToolCalls: 16 },
        retry: { baseDelayMs: 100, maxDelayMs: 1_000 },
      },
    },
  };
}

function genericContract(
  env: Readonly<Record<string, string | undefined>>,
  approval?: ToolApprovalAdapter,
): HostContract {
  return {
    id: "nervus/generic-host",
    version: "1.0.0",
    digest: digest("nervus/generic-host@1"),
    hostType: "nervus-cli",
    hostOptionsSchema: toolAuthorizationHostOptionsSchema,
    runtime: { workspace: "string" },
    defaults: {
      host: {
        options: toolAuthorizationHostDefaults,
      },
    },
    builtInCapabilityRoots: [fileURLToPath(new URL("../../capabilities", import.meta.url))],
    defaultStateDirectory({ profile }) {
      const identity = profile.sources.at(-1)?.path ?? `${profile.baseDirectory}:${profile.profileId}`;
      const root = env.XDG_STATE_HOME ?? resolve(homedir(), ".local/state");
      return resolve(root, "nervus", "profiles", digest(identity).slice(0, 20), "sessions");
    },
    resolveToolAuthorizer(effective, { requireRuntime }) {
      return resolveHostToolAuthorizer(effective, {
        id: "nervus-cli/supervised",
        revision: 1,
        autoAllowTools: ["fs/read", "fs/list", "skills/activate"],
        ...(approval ? { approval } : {}),
        requireRuntime,
      });
    },
  };
}

function modelContribution(model: ModelAdapter): HostContribution {
  const plugin: Plugin.Object<void> = {
    name: `nervus/injected-model/${model.id}`,
    inject: ["models"],
    apply(ctx) {
      ctx.models.register(model);
    },
  };
  return {
    id: `nervus/injected-model/${model.id}`,
    version: String(model.revision ?? 1),
    digest: digest(JSON.stringify({ id: model.id, revision: model.revision ?? 1, capabilities: model.capabilities ?? {} })),
    provides: [{ kind: "model", id: model.id }],
    plugin,
  };
}

function parseOptions(argv: readonly string[], defaults: { readonly sessionId?: string } = {}): ParsedOptions {
  let workspace: string | undefined;
  let stateDirectory: string | undefined;
  let sessionId = defaults.sessionId;
  let createNew = false;
  let profile: string | undefined;
  let model: string | undefined;
  let json = false;
  let toolAuthorizationMode: "yolo" | "supervised" | undefined;
  const prompt: string[] = [];
  const capabilityRoots: string[] = [];
  const capabilities: string[] = [];
  const overlays: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--workspace") workspace = requiredArgument(argv[++index], "--workspace");
    else if (argument === "--sessions-dir" || argument === "--state-dir") stateDirectory = requiredArgument(argv[++index], argument);
    else if (argument === "--session") sessionId = requiredArgument(argv[++index], "--session");
    else if (argument === "--new") createNew = true;
    else if (argument === "--capability-root") capabilityRoots.push(resolve(requiredArgument(argv[++index], "--capability-root")));
    else if (argument === "--capability") capabilities.push(requiredArgument(argv[++index], "--capability"));
    else if (argument === "--profile") profile = resolve(requiredArgument(argv[++index], "--profile"));
    else if (argument === "--overlay") overlays.push(resolve(requiredArgument(argv[++index], "--overlay")));
    else if (argument === "--model") model = requiredArgument(argv[++index], "--model");
    else if (argument === "--mode") {
      toolAuthorizationMode = optionalEnum(
        requiredArgument(argv[++index], "--mode"),
        ["yolo", "supervised"] as const,
        "--mode",
      );
    }
    else if (argument === "--json") json = true;
    else if (argument?.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
    else if (argument !== undefined) prompt.push(argument);
  }
  return {
    ...(workspace ? { workspace: resolve(workspace) } : {}),
    ...(stateDirectory ? { stateDirectory: resolve(stateDirectory) } : {}),
    ...(sessionId ? { sessionId } : {}),
    createNew,
    prompt: prompt.join(" "),
    capabilityRoots,
    capabilities,
    ...(profile ? { profile } : {}),
    overlays,
    ...(model ? { model } : {}),
    json,
    ...(toolAuthorizationMode ? { toolAuthorizationMode } : {}),
  };
}

function legacyStateDirectory(parsed: ParsedOptions): string {
  if (parsed.stateDirectory) return parsed.stateDirectory;
  if (!parsed.workspace) throw new Error("--workspace or --state-dir is required");
  return resolve(parsed.workspace, ".nervus/sessions");
}

function requiredArgument(value: string | undefined, option: string): string {
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}

function requiredValue(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Set ${name} before starting chat`);
  return value;
}

function optionalEnum<T extends string>(value: string | undefined, values: readonly T[], name: string): T | undefined {
  if (value === undefined) return undefined;
  if (!values.includes(value as T)) throw new Error(`${name} must be ${values.join(" or ")}`);
  return value as T;
}

function countValues(values: readonly string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function collectUsage(events: readonly { readonly payload: any }[]) {
  return events.reduce((usage, event) => {
    if (event.payload.type === "model/call-completed" && event.payload.usage) {
      usage.inputTokens += event.payload.usage.inputTokens;
      usage.outputTokens += event.payload.usage.outputTokens;
      usage.totalTokens += event.payload.usage.totalTokens;
    }
    return usage;
  }, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
}

function contentText(content: readonly { readonly type: string; readonly text?: string }[]) {
  return content.map((block) => block.text ?? `[${block.type}]`).join(" ");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeUsage(io: CliIO): void {
  io.write([
    "Usage:",
    "  nervus chat [--profile <file>] [--overlay <file>] [--workspace <path>] [--mode yolo|supervised] [--session <id>] [--new] [prompt]",
    "  nervus sessions list [--profile <file>] [--workspace <path>]",
    "  nervus sessions inspect <id> [--profile <file>] [--workspace <path>]",
    "  nervus sessions resume <id> [--profile <file>] [--workspace <path>] [prompt]",
    "  nervus profiles validate <file>",
    "  nervus profiles explain <file> [--workspace <path>] [--json]",
    "",
  ].join("\n"));
}
