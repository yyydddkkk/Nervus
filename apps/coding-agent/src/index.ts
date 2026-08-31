import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assembleHost,
  explainHost,
  recordSessionAssembly,
  resolveHostToolAuthorizer,
  toolAuthorizationHostDefaults,
  toolAuthorizationHostOptionsSchema,
  type HostAssemblyOptions,
  type HostContract,
  type HostContribution,
  type ToolApprovalAdapter,
} from "@nervus/host";
import type { ProfileOverlay, ProfileSource } from "@nervus/profile";
import type { Plugin } from "cordis";
import {
  type ContentBlock,
  type ContextContributor,
  type ModelAdapter,
  type Session,
  type SessionEventEnvelope,
} from "nervus";

export {
  classifyShellCommand,
  collectCodingMetrics,
  type CodingMetrics,
  type ShellPurpose,
} from "./metrics.js";

export interface CodingCliIO {
  write(value: string): void;
  writeError(value: string): void;
  onInterrupt(handler: () => void): () => void;
}

export interface RunCodingCliOptions {
  readonly io: CodingCliIO;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly modelAdapter?: ModelAdapter;
  readonly approvalAdapter?: ToolApprovalAdapter;
}

export interface CodingRunRecord {
  readonly schemaVersion: 1;
  readonly workspace: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly status: "completed" | "exhausted" | "cancelled" | "failed";
  readonly output: readonly ContentBlock[];
  readonly eventCount: number;
  readonly toolCallCount: number;
  readonly toolErrorCount: number;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  };
}

interface ParsedInvocation {
  readonly mode: "run" | "resume";
  readonly workspace: string;
  readonly stateDirectory?: string;
  readonly sessionId: string;
  readonly input: string;
  readonly json: boolean;
  readonly capabilityRoots: readonly string[];
  readonly capabilities: readonly string[];
  readonly profile?: string;
  readonly overlays: readonly string[];
  readonly model?: string;
  readonly toolAuthorizationMode?: "yolo" | "supervised";
}

const CODING_SKILL_ID = "nervus/coding";

export async function runCodingCli(
  argv: readonly string[],
  options: RunCodingCliOptions,
): Promise<number> {
  try {
    const [command, ...arguments_] = argv[0] === "--" ? argv.slice(1) : argv;
    if (command === "run") return await runInput(await parseInvocation("run", arguments_), options);
    if (command === "resume") {
      const sessionId = arguments_[0];
      if (!sessionId) throw new Error("resume requires a Session ID");
      return await runInput(await parseInvocation("resume", arguments_.slice(1), sessionId), options);
    }
    writeUsage(options.io);
    return command ? 1 : 0;
  } catch (error) {
    options.io.writeError(`${formatError(error)}\n`);
    return 1;
  }
}

async function runInput(
  parsed: ParsedInvocation,
  options: RunCodingCliOptions,
): Promise<number> {
  const env = options.env ?? process.env;
  const rootInstructions = await readOptionalFile(resolve(parsed.workspace, "AGENTS.md"));
  const contributions = [
    codingContribution(rootInstructions),
    ...(options.modelAdapter ? [modelContribution(options.modelAdapter)] : []),
  ];
  const assemblyInput = codingAssemblyOptions(
    parsed,
    env,
    contributions,
    options.modelAdapter,
    options.approvalAdapter,
  );
  const planned = await explainHost(assemblyInput);
  if (!planned.state.directory) {
    throw new Error("nervus-code requires durable JSONL state");
  }
  await ensureStateWorkspace(planned.state.directory, parsed.workspace);
  const assembly = await assembleHost(assemblyInput);
  const stateDirectory = assembly.stateDirectory;
  if (!stateDirectory) {
    await assembly.dispose();
    throw new Error("nervus-code requires durable JSONL state");
  }
  const { kernel, journal } = assembly;
  let session: Session | undefined;
  let active = false;
  const removeText = kernel.context.on("model/text-delta", (update) => {
    if (!parsed.json && update.purpose === "response") options.io.write(update.delta);
  });
  const removeProgress = kernel.context.on("tool/progress", (update) => {
    options.io.writeError(`[progress ${update.toolId}] ${contentText(update.content)}\n`);
  });
  const removeInterrupt = options.io.onInterrupt(() => {
    if (active) session?.cancelActiveTurn("Coding Host interrupt");
  });

  try {
    const exists = (await journal.list()).includes(parsed.sessionId);
    if (parsed.mode === "run" && exists) throw new Error(`Session already exists: ${parsed.sessionId}`);
    if (parsed.mode === "resume" && !exists) throw new Error(`Session does not exist: ${parsed.sessionId}`);
    const attribution = await recordSessionAssembly({
      stateDirectory,
      sessionId: parsed.sessionId,
      action: parsed.mode === "run" ? "create" : "open",
      resolution: assembly.resolution,
      profileExplicit: !!parsed.profile,
    });
    if (attribution.changed) {
      options.io.writeError(`[assembly changed ${attribution.previousDigest} -> ${assembly.resolution.digest}]\n`);
    }
    session = parsed.mode === "resume"
      ? await kernel.openSession({ id: parsed.sessionId })
      : await kernel.createSession({ id: parsed.sessionId, agentId: assembly.agent.id });
    options.io.writeError(`[session ${parsed.sessionId}]\n`);
    active = true;
    const before = (await session.events()).length;
    await session.send({ content: [{ type: "text", text: parsed.input }] });
    active = false;
    const record = createRunRecord(parsed, (await session.events()).slice(before));
    if (parsed.json) options.io.write(`${JSON.stringify(record)}\n`);
    else options.io.write("\n");
    options.io.writeError(`[turn ${record.status}]\n`);
    return record.status === "completed" ? 0 : 1;
  } finally {
    active = false;
    removeInterrupt();
    removeProgress();
    removeText();
    await assembly.dispose();
  }
}

function codingAssemblyOptions(
  parsed: ParsedInvocation,
  env: Readonly<Record<string, string | undefined>>,
  contributions: readonly HostContribution[],
  injected?: ModelAdapter,
  approval?: ToolApprovalAdapter,
): HostAssemblyOptions {
  const source = parsed.profile
    ? ({ kind: "file", file: parsed.profile, roots: [dirname(parsed.profile)] } satisfies ProfileSource)
    : generatedProfile(parsed, env, injected);
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
    runtime: { workspace: parsed.workspace },
    contract: codingContract(env, approval),
    contributions,
  };
}

function generatedProfile(
  parsed: ParsedInvocation,
  env: Readonly<Record<string, string | undefined>>,
  injected?: ModelAdapter,
): ProfileSource {
  const stateDirectory = parsed.stateDirectory ?? defaultStateDirectory(parsed.workspace, env);
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
    label: "nervus-code-default",
    baseDirectory: parsed.workspace,
    value: {
      profileVersion: 2,
      id: "nervus-code-default",
      host: { type: "nervus-code", options: {} },
      capabilities: { roots: [], select, configure },
      agent: {
        id: "nervus-coding-agent",
        model: {
          adapter: injected?.id ?? "openai-compatible/chat",
          name: parsed.model ?? (injected ? env.OPENAI_MODEL ?? "scripted" : requiredValue(env, "OPENAI_MODEL")),
          maxOutputTokens: 8_192,
        },
        instructions: "You are a Coding Agent operating only inside the explicit workspace.",
        tools: ["fs/read", "fs/list", "fs/write", "shell/run"],
        skills: [{ id: CODING_SKILL_ID, mode: "eager" }],
        limits: { maxSteps: 32, maxToolCalls: 128, maxToolCallsPerStep: 16, maxModelAttempts: 48 },
        timeouts: { modelMs: 300_000, toolMs: 120_000 },
      },
      state: { journal: { kind: "jsonl", directory: stateDirectory } },
      execution: {
        concurrency: { maxActiveTurns: 8, maxModelCalls: 4, maxToolCalls: 16 },
        retry: { baseDelayMs: 100, maxDelayMs: 1_000 },
      },
    },
  };
}

function codingContract(
  env: Readonly<Record<string, string | undefined>>,
  approval?: ToolApprovalAdapter,
): HostContract {
  return {
    id: "nervus/coding-host",
    version: "1.0.0",
    digest: digest("nervus/coding-host@1"),
    hostType: "nervus-code",
    hostOptionsSchema: toolAuthorizationHostOptionsSchema,
    runtime: { workspace: "string" },
    defaults: {
      host: {
        options: toolAuthorizationHostDefaults,
      },
      state: { journal: { kind: "jsonl" } },
    },
    builtInCapabilityRoots: [fileURLToPath(new URL("../../../capabilities", import.meta.url))],
    validate(effective) {
      const host = asRecord(effective.host);
      if (!host || asRecord(host.options) === undefined) throw new Error("Invalid Coding Host options");
    },
    defaultStateDirectory({ runtime }) {
      return defaultStateDirectory(String(runtime.workspace), env);
    },
    resolveToolAuthorizer(effective, { requireRuntime }) {
      return resolveHostToolAuthorizer(effective, {
        id: "nervus-code/supervised",
        revision: 1,
        autoAllowTools: ["fs/read", "fs/list", "skills/activate"],
        ...(approval ? { approval } : {}),
        requireRuntime,
      });
    },
  };
}

function codingContribution(rootInstructions: string | undefined): HostContribution {
  const contributor: ContextContributor = {
    id: "nervus/coding-host/root-agents",
    contribute() {
      return rootInstructions === undefined ? [] : [{
        id: "host/root-agents",
        source: "nervus/coding-host/root-agents",
        layer: "agent",
        order: 10,
        retention: "required",
        content: { type: "instructions", blocks: [{ type: "text", text: rootInstructions }] },
      }];
    },
  };
  const plugin: Plugin.Object<void> = {
    name: "nervus/coding-host/behavior",
    inject: ["skills", "context"],
    apply(ctx) {
      ctx.skills.register({
        id: CODING_SKILL_ID,
        name: "Repository coding",
        description: "Inspect, edit, verify, and review repository changes.",
        instructions: [{
          type: "text",
          text: [
            "For every coding task, inspect repository evidence before editing.",
            "Use fs/list for directory discovery and fs/read only for regular files; never pass a directory to fs/read.",
            "Before modifying a nested file, read every nearer AGENTS.md that governs it.",
            "Keep changes within the requested scope.",
            "Run appropriate verification based on repository evidence and instructions.",
            "Before finishing, inspect git status and the final diff.",
            "Report changed behavior, verification, and failures honestly.",
          ].join(" "),
        }],
      });
      ctx.context.register(contributor);
    },
  };
  return {
    id: "nervus/coding-host/behavior",
    version: "1.0.0",
    digest: digest(`coding-behavior\0${rootInstructions ?? ""}`),
    provides: [
      { kind: "skill", id: CODING_SKILL_ID },
      { kind: "context", id: contributor.id },
    ],
    plugin,
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

async function parseInvocation(
  mode: "run" | "resume",
  argv: readonly string[],
  resumedSessionId?: string,
): Promise<ParsedInvocation> {
  let workspace: string | undefined;
  let stateDirectory: string | undefined;
  let sessionId: string | undefined = resumedSessionId;
  let json = false;
  let profile: string | undefined;
  let model: string | undefined;
  let toolAuthorizationMode: "yolo" | "supervised" | undefined;
  const capabilityRoots: string[] = [];
  const capabilities: string[] = [];
  const overlays: string[] = [];
  const input: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--workspace") workspace = requiredArgument(argv[++index], "--workspace");
    else if (argument === "--state-dir") stateDirectory = requiredArgument(argv[++index], "--state-dir");
    else if (argument === "--session") sessionId = requiredArgument(argv[++index], "--session");
    else if (argument === "--json") json = true;
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
    else if (argument?.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
    else if (argument !== undefined) input.push(argument);
  }
  if (!workspace) throw new Error("--workspace is required");
  if (input.length === 0) throw new Error(`${mode} requires a coding task`);
  return {
    mode,
    workspace: await realpath(resolve(workspace)),
    ...(stateDirectory ? { stateDirectory: resolve(stateDirectory) } : {}),
    sessionId: sessionId ?? createSessionId(),
    input: input.join(" "),
    json,
    capabilityRoots,
    capabilities,
    ...(profile ? { profile } : {}),
    overlays,
    ...(model ? { model } : {}),
    ...(toolAuthorizationMode ? { toolAuthorizationMode } : {}),
  };
}

function createRunRecord(parsed: ParsedInvocation, events: readonly SessionEventEnvelope[]): CodingRunRecord {
  const started = events.find((event) => event.payload.type === "turn/started");
  if (!started || started.payload.type !== "turn/started") throw new Error("SessionJournal is missing turn/started");
  const turnId = started.payload.turnId;
  const terminal = [...events].reverse().find((event) => {
    const payload = event.payload;
    return "turnId" in payload && payload.turnId === turnId &&
      (payload.type === "turn/completed" || payload.type === "turn/exhausted" || payload.type === "turn/cancelled" || payload.type === "turn/failed");
  });
  if (!terminal) throw new Error("SessionJournal is missing a terminal Turn fact");
  const status = terminalStatus(terminal);
  const output = terminal.payload.type === "turn/completed" ? terminal.payload.output : [];
  const usage = events.reduce((total, event) => {
    if (event.payload.type === "model/call-completed" && event.payload.usage) {
      total.inputTokens += event.payload.usage.inputTokens;
      total.outputTokens += event.payload.usage.outputTokens;
      total.totalTokens += event.payload.usage.totalTokens;
    }
    return total;
  }, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  return {
    schemaVersion: 1,
    workspace: parsed.workspace,
    sessionId: parsed.sessionId,
    turnId,
    status,
    output,
    eventCount: events.length,
    toolCallCount: events.filter((event) => event.payload.type === "tool/call-started").length,
    toolErrorCount: events.filter((event) =>
      (event.payload.type === "tool/call-completed" && event.payload.result.status === "error") ||
      event.payload.type === "tool/call-failed").length,
    usage,
  };
}

function terminalStatus(terminal: SessionEventEnvelope): CodingRunRecord["status"] {
  switch (terminal.payload.type) {
    case "turn/completed": return "completed";
    case "turn/exhausted": return "exhausted";
    case "turn/cancelled": return "cancelled";
    case "turn/failed": return "failed";
    default: throw new Error(`Not a terminal Turn fact: ${terminal.payload.type}`);
  }
}

function defaultStateDirectory(workspace: string, env: Readonly<Record<string, string | undefined>>): string {
  const stateRoot = env.XDG_STATE_HOME ? resolve(env.XDG_STATE_HOME) : join(homedir(), ".local", "state");
  const workspaceHash = createHash("sha256").update(workspace).digest("hex").slice(0, 24);
  return join(stateRoot, "nervus", "coding", workspaceHash, "sessions");
}

async function ensureStateWorkspace(stateDirectory: string, workspace: string): Promise<void> {
  await mkdir(stateDirectory, { recursive: true });
  const metadataPath = join(stateDirectory, "workspace.json");
  let stored: unknown;
  try {
    stored = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    try {
      await writeFile(metadataPath, `${JSON.stringify({ schemaVersion: 1, workspace }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      return;
    } catch (writeError) {
      if (!isNodeError(writeError) || writeError.code !== "EEXIST") throw writeError;
      stored = JSON.parse(await readFile(metadataPath, "utf8"));
    }
  }
  if (!stored || typeof stored !== "object" || !("schemaVersion" in stored) || stored.schemaVersion !== 1 || !("workspace" in stored) || stored.workspace !== workspace) {
    throw new Error(`state partition belongs to a different workspace: ${stateDirectory}`);
  }
}

function createSessionId(): string {
  const timestamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14);
  return `code-${timestamp}-${randomBytes(3).toString("hex")}`;
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function requiredArgument(value: string | undefined, option: string): string {
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}

function requiredValue(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Set ${name} before running nervus-code`);
  return value;
}

function optionalEnum<T extends string>(value: string | undefined, values: readonly T[], name: string): T | undefined {
  if (value === undefined) return undefined;
  if (!values.includes(value as T)) throw new Error(`${name} must be ${values.join(" or ")}`);
  return value as T;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function contentText(content: readonly ContentBlock[]): string {
  return content.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "json") return JSON.stringify(block.value);
    return block.uri;
  }).join(" ");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeUsage(io: CodingCliIO): void {
  io.write([
    "Usage:",
    "  nervus-code run --workspace <path> [--profile <file>] [--overlay <file>] [--mode yolo|supervised] [--session <id>] [--state-dir <path>] <task>",
    "  nervus-code resume <session-id> --workspace <path> [--profile <file>] [--overlay <file>] [--mode yolo|supervised] [--state-dir <path>] <follow-up>",
    "",
  ].join("\n"));
}
