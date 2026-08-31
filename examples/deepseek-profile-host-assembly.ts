import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  runCodingCli,
  type CodingCliIO,
  type CodingRunRecord,
} from "../apps/coding-agent/src/index.js";
import {
  JsonlSessionJournal,
  runNervusCli,
  type CliIO,
  type SessionEventEnvelope,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
const root = resolve(".nervus/m15-live");
const apiKey = requiredEnv("OPENAI_API_KEY");
const baseUrl = requiredEnv("OPENAI_BASE_URL");
const model = requiredEnv("OPENAI_MODEL");

await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

const generic = await runGenericProfile();
const coding = await runCodingProfile();
await assertNoSecret(root, apiKey);

const receipt = {
  schemaVersion: 1,
  provider: "DeepSeek through nervus/openai-compatible",
  model,
  generic,
  coding,
  secretLeakHits: 0,
};
const serialized = JSON.stringify(receipt, null, 2);
if (serialized.includes(apiKey)) throw new Error("API key leaked into receipt");
await writeFile(join(root, "receipt.json"), `${serialized}\n`, "utf8");
process.stdout.write(`${serialized}\n`);

async function runGenericProfile() {
  const workspace = join(root, "generic-workspace");
  const state = join(root, "generic-state");
  const profile = join(root, "generic.yaml");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "project.json"), JSON.stringify({ name: "m15-profile-fixture", purpose: "live assembly" }, null, 2), "utf8");
  await writeProfile(profile, genericProfile(workspace, state, "first assembly"));
  const firstIO = captureCliIO();
  const firstExit = await runNervusCli([
    "chat", "--profile", profile, "--workspace", workspace,
    "--session", "m15-generic", "--json",
    "Use fs/list and fs/read to inspect project.json, then report its name. You must call both Tools.",
  ], { io: firstIO });
  if (firstExit !== 0) throw new Error(`generic Profile first Turn failed: ${firstIO.errors.join("")}`);

  await writeProfile(profile, genericProfile(workspace, state, "second assembly with changed instructions"));
  const secondIO = captureCliIO();
  const secondExit = await runNervusCli([
    "sessions", "resume", "m15-generic", "--profile", profile,
    "--workspace", workspace, "--json",
    "Read project.json again and state its purpose. Use fs/read before answering.",
  ], { io: secondIO });
  if (secondExit !== 0) throw new Error(`generic Profile resume failed: ${secondIO.errors.join("")}`);
  if (!secondIO.errors.join("").includes("[assembly changed")) {
    throw new Error("generic Profile change was not reported");
  }

  const events = await new JsonlSessionJournal({ directory: state }).read("m15-generic");
  const toolIds = toolCalls(events);
  if (!toolIds.includes("fs/list") || toolIds.filter((id) => id === "fs/read").length < 2) {
    throw new Error(`generic Profile did not exercise required Tools: ${toolIds.join(", ")}`);
  }
  const references = await readFile(
    join(state, ".host-assembly", "sessions", `${Buffer.from("m15-generic").toString("base64url")}.jsonl`),
    "utf8",
  );
  const referenceRecords = references.trim().split("\n").map((line) => JSON.parse(line) as { assemblyDigest: string });
  if (referenceRecords.length !== 2 || referenceRecords[0]?.assemblyDigest === referenceRecords[1]?.assemblyDigest) {
    throw new Error("generic Session assembly history is incomplete");
  }
  return {
    sessionId: "m15-generic",
    turns: countTurns(events),
    toolIds,
    assemblyDigests: referenceRecords.map((item) => item.assemblyDigest),
    profileChangeReported: true,
    firstOutput: JSON.parse(firstIO.output.join("")),
    secondOutput: JSON.parse(secondIO.output.join("")),
  };
}

async function runCodingProfile() {
  const workspace = join(root, "coding-workspace");
  const state = join(root, "coding-state");
  const profile = join(root, "coding.yaml");
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(join(workspace, "test"), { recursive: true });
  await writeFile(join(workspace, "AGENTS.md"), "Inspect before editing. Do not modify tests. Run npm test and inspect git diff before finishing.\n", "utf8");
  await writeFile(join(workspace, "package.json"), JSON.stringify({
    name: "m15-coding-fixture",
    private: true,
    type: "module",
    scripts: { test: "node --test" },
  }, null, 2), "utf8");
  await writeFile(join(workspace, "src", "math.js"), "export const multiply = (left, right) => left + right;\n", "utf8");
  await writeFile(join(workspace, "test", "math.test.js"), [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'import { multiply } from "../src/math.js";',
    'test("multiplies", () => assert.equal(multiply(3, 4), 12));',
    "",
  ].join("\n"), "utf8");
  await execFileAsync("git", ["init", "-q"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "nervus@example.invalid"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.name", "Nervus"], { cwd: workspace });
  await execFileAsync("git", ["add", "."], { cwd: workspace });
  await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: workspace });
  await writeProfile(profile, codingProfile(workspace, state));
  const io = captureCodingIO();
  const exit = await runCodingCli([
    "run", "--profile", profile, "--workspace", workspace,
    "--session", "m15-coding", "--json",
    "Fix the implementation so existing tests pass. Do not edit tests. Inspect evidence, run npm test, and inspect git diff and status before reporting.",
  ], { io });
  if (exit !== 0) throw new Error(`coding Profile failed: ${io.errors.join("")}`);
  await execFileAsync("npm", ["test"], { cwd: workspace });
  const changed = (await execFileAsync("git", ["status", "--short"], { cwd: workspace })).stdout.trim().split("\n").filter(Boolean);
  if (changed.length !== 1 || !changed[0]?.endsWith("src/math.js")) {
    throw new Error(`coding Profile changed unexpected files: ${changed.join(", ")}`);
  }
  const source = await readFile(join(workspace, "src", "math.js"), "utf8");
  if (!source.includes("left * right")) throw new Error("coding Profile did not repair multiply");
  const record = JSON.parse(io.output.join("")) as CodingRunRecord;
  const events = await new JsonlSessionJournal({ directory: state }).read("m15-coding");
  return {
    sessionId: record.sessionId,
    status: record.status,
    toolIds: toolCalls(events),
    changedFiles: ["src/math.js"],
    verificationPassed: true,
  };
}

function genericProfile(workspace: string, state: string, instructions: string) {
  return {
    profileVersion: 2,
    id: "m15-generic-profile",
    host: { type: "nervus-cli", options: {} },
    capabilities: {
      roots: [],
      select: ["nervus/openai-compatible", "nervus/filesystem"],
      configure: {
        "nervus/openai-compatible": modelConfig(),
        "nervus/filesystem": { root: { $runtime: "workspace" } },
      },
    },
    agent: {
      id: "m15-generic-agent",
      model: { adapter: "openai-compatible/chat", name: model, maxOutputTokens: 4096 },
      instructions: `You are a precise Tool-using Agent. ${instructions}`,
      tools: ["fs/read", "fs/list"],
      skills: [],
      limits: { maxSteps: 12, maxToolCalls: 20, maxToolCallsPerStep: 4, maxModelAttempts: 16 },
      timeouts: { modelMs: 300000, toolMs: 60000 },
    },
    state: { journal: { kind: "jsonl", directory: state } },
    execution: {
      concurrency: { maxActiveTurns: 4, maxModelCalls: 2, maxToolCalls: 8 },
      retry: { baseDelayMs: 500, maxDelayMs: 4000 },
    },
  };
}

function codingProfile(workspace: string, state: string) {
  return {
    profileVersion: 2,
    id: "m15-coding-profile",
    host: { type: "nervus-code", options: {} },
    capabilities: {
      roots: [],
      select: ["nervus/openai-compatible", "nervus/filesystem"],
      configure: {
        "nervus/openai-compatible": modelConfig(),
        "nervus/filesystem": { root: { $runtime: "workspace" } },
      },
    },
    agent: {
      id: "m15-coding-agent",
      model: { adapter: "openai-compatible/chat", name: model, maxOutputTokens: 8192 },
      instructions: "You are a Coding Agent operating only inside the explicit workspace.",
      tools: ["fs/read", "fs/list", "fs/write", "shell/run"],
      skills: [{ id: "nervus/coding", mode: "eager" }],
      limits: { maxSteps: 32, maxToolCalls: 128, maxToolCallsPerStep: 16, maxModelAttempts: 48 },
      timeouts: { modelMs: 300000, toolMs: 120000 },
    },
    state: { journal: { kind: "jsonl", directory: state } },
    execution: {
      concurrency: { maxActiveTurns: 4, maxModelCalls: 2, maxToolCalls: 8 },
      retry: { baseDelayMs: 500, maxDelayMs: 4000 },
    },
  };
}

function modelConfig() {
  return {
    baseUrl,
    apiKey: { $env: "OPENAI_API_KEY" },
    compatibility: "deepseek",
    instructionRole: "system",
    capabilities: {
      contextWindow: 1000000,
      maxOutputTokens: 8192,
      safetyMarginTokens: 1024,
      supportsTools: true,
      supportsImages: false,
    },
    extraBody: {
      thinking: { type: "enabled" },
      reasoning_effort: process.env.DEEPSEEK_REASONING_EFFORT ?? "high",
    },
  };
}

async function writeProfile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function toolCalls(events: readonly SessionEventEnvelope[]): string[] {
  return events.flatMap((event) => event.payload.type === "tool/call-started" ? [event.payload.call.toolId] : []);
}

function countTurns(events: readonly SessionEventEnvelope[]): number {
  return events.filter((event) => event.payload.type === "turn/started").length;
}

function captureCliIO(): CliIO & { output: string[]; errors: string[] } {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    write: (value) => output.push(value),
    writeError: (value) => errors.push(value),
    async *readLines() {},
    onInterrupt: () => () => undefined,
  };
}

function captureCodingIO(): CodingCliIO & { output: string[]; errors: string[] } {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    write: (value) => output.push(value),
    writeError: (value) => errors.push(value),
    onInterrupt: () => () => undefined,
  };
}

async function assertNoSecret(directory: string, secret: string): Promise<void> {
  for (const file of await files(directory)) {
    const content = await readFile(file);
    if (content.includes(Buffer.from(secret))) throw new Error(`API key leaked into ${file}`);
  }
}

async function files(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await files(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} in .env`);
  return value;
}
