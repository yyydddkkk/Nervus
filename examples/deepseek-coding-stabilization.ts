import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  collectCodingMetrics,
  runCodingCli,
  type CodingCliIO,
  type CodingMetrics,
  type CodingRunRecord,
} from "../apps/coding-agent/src/index.js";
import {
  JsonlSessionJournal,
  OpenAICompatibleChatAdapter,
  type ModelAdapter,
  type SessionEventEnvelope,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
const root = resolve(".nervus/m12-live");
const apiKey = requiredEnv("OPENAI_API_KEY");

interface Receipt {
  id: string;
  pass: "diagnostic" | "final";
  turns: number;
  completed: boolean;
  verified: boolean;
  changedFiles: readonly string[];
  metrics: CodingMetrics;
  instructionCompliant: boolean;
  compactionCount: number;
}

await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
const passes: Record<string, Receipt[]> = {};
for (const pass of ["diagnostic", "final"] as const) {
  const passRoot = join(root, pass);
  await mkdir(passRoot, { recursive: true });
  passes[pass] = [
    await scopedDiscovery(pass, passRoot),
    await largeFile(pass, passRoot),
    await crossFile(pass, passRoot),
    await resumeCorrection(pass, passRoot),
    await nervusRegression(pass, passRoot),
    await nervusCompaction(pass, passRoot),
  ];
}
const aggregate = { schemaVersion: 1, model: requiredEnv("OPENAI_MODEL"), passes };
const serialized = JSON.stringify(aggregate, null, 2);
if (serialized.includes(apiKey)) throw new Error("API key leaked into M12 aggregate");
await writeFile(join(root, "aggregate.json"), `${serialized}\n`, "utf8");
for (const receipts of Object.values(passes)) {
  if (receipts.some((item) => !item.completed || !item.verified || !item.instructionCompliant || item.metrics.directoryReadErrorCount > 0)) {
    throw new Error("M12 acceptance criteria failed");
  }
}
process.stdout.write(`${serialized}\n`);

async function scopedDiscovery(pass: Receipt["pass"], passRoot: string): Promise<Receipt> {
  const workspace = join(passRoot, "01-scoped");
  await files(workspace, {
    "AGENTS.md": "Inspect applicable AGENTS.md before editing. Do not edit tests. Run npm test and inspect git status/diff.\n",
    "src/AGENTS.md": "Values in src must use the scoped-value string.\n",
    "package.json": pkg("node --test"),
    "src/value.js": "export const value = 'wrong';\n",
    "test/value.test.js": testSource("value", "../src/value.js", "scoped-value"),
  });
  await init(workspace);
  const result = await execute(pass, "scoped", workspace, "Read every applicable AGENTS.md, fix the implementation without editing tests, run npm test, and inspect final git status and diff.");
  await verify(workspace);
  const calls = toolCalls(result.events);
  const read = calls.findIndex((call) => call.toolId === "fs/read" && call.arguments.path === "src/AGENTS.md");
  const write = calls.findIndex((call) => call.toolId === "fs/write" && call.arguments.path === "src/value.js");
  return receipt("scoped-discovery", pass, result, workspace, read >= 0 && write > read);
}

async function largeFile(pass: Receipt["pass"], passRoot: string): Promise<Receipt> {
  const workspace = join(passRoot, "02-large");
  const filler = Array.from({ length: 160 }, (_, index) => `export const filler${index} = ${index};`).join("\n");
  await files(workspace, {
    "AGENTS.md": "Do not edit tests. Make the smallest implementation change. Run npm test and inspect git diff/status.\n",
    "package.json": pkg("node --test"),
    "src/catalog.js": `${filler}\nexport function target() { return 'wrong'; }\n`,
    "test/catalog.test.js": testSource("target", "../src/catalog.js", "correct"),
  });
  await init(workspace);
  const result = await execute(pass, "large", workspace, "Fix only the target function in the large implementation file. Do not edit tests. Verify and review the final diff.");
  await verify(workspace);
  return receipt("large-local-edit", pass, result, workspace, true);
}

async function crossFile(pass: Receipt["pass"], passRoot: string): Promise<Receipt> {
  const workspace = join(passRoot, "03-cross");
  await files(workspace, {
    "AGENTS.md": "Do not edit tests. Run npm test and inspect git diff/status.\n",
    "package.json": pkg("node --test"),
    "src/definition.js": "export const oldName = 'value';\n",
    "src/consumer.js": "import { oldName } from './definition.js';\nexport const result = oldName;\n",
    "test/consumer.test.js": "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport * as definition from '../src/definition.js';\nimport { result } from '../src/consumer.js';\ntest('renamed export', () => { assert.equal(definition.newName, 'value'); assert.equal(result, 'value'); });\n",
  });
  await init(workspace);
  const result = await execute(pass, "cross", workspace, "Rename oldName to newName everywhere in the implementation. Do not edit tests. Verify and review the diff.");
  await verify(workspace);
  return receipt("cross-file-change", pass, result, workspace, true);
}

async function resumeCorrection(pass: Receipt["pass"], passRoot: string): Promise<Receipt> {
  const workspace = join(passRoot, "04-resume");
  await files(workspace, { "AGENTS.md": "Write only result.txt and inspect git status/diff.\n" });
  await init(workspace);
  const state = join(passRoot, "state-resume");
  const first = await invoke("run", pass, "resume", workspace, state, "Create result.txt containing exactly phase-one followed by a newline.");
  const second = await invoke("resume", pass, "resume", workspace, state, "Replace result.txt so it contains exactly phase-one, then phase-two, each on its own line.");
  const content = await readFile(join(workspace, "result.txt"), "utf8");
  if (content !== "phase-one\nphase-two\n") throw new Error("resume verifier failed");
  return receipt("resume-correction", pass, { record: second.record, events: [...first.events, ...second.events], turns: 2 }, workspace, true);
}

async function nervusRegression(pass: Receipt["pass"], passRoot: string): Promise<Receipt> {
  const workspace = await nervusCopy(join(passRoot, "05-nervus-regression"));
  const file = join(workspace, "src/tools/local.ts");
  const source = await readFile(file, "utf8");
  await writeFile(file, source.replace('fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))', 'fromRoot === ""'), "utf8");
  const result = await execute(pass, "nervus-regression", workspace, "A regression was seeded in src/tools/local.ts and local Tool tests fail for nested paths. Diagnose and fix only the implementation, run the relevant tests, then inspect git diff/status.");
  await execFileAsync("pnpm", ["vitest", "run", "tests/local-tools.test.ts"], { cwd: workspace });
  return receipt("nervus-seeded-regression", pass, result, workspace, true);
}

async function nervusCompaction(pass: Receipt["pass"], passRoot: string): Promise<Receipt> {
  const workspace = await nervusCopy(join(passRoot, "06-nervus-compaction"));
  const state = join(passRoot, "state-compaction");
  const adapter = deepSeekAdapter(16_442);
  await seedHistory(state, workspace, `${pass}-compaction`);
  const second = await invoke("resume", pass, "compaction", workspace, state, "Update M12_NOTE.md to add a second line exactly: Profiles are resolved by Hosts. Verify and review the final diff.", adapter);
  const content = await readFile(join(workspace, "M12_NOTE.md"), "utf8");
  if (!content.includes("Profiles are resolved by Hosts.")) throw new Error("compaction task verifier failed");
  const all = second.events;
  const compacted = all.filter((event) => event.type === "history/compacted").length;
  if (compacted < 1) throw new Error("long Session did not trigger Compaction");
  return receipt("nervus-compaction", pass, { record: second.record, events: all, turns: 2 }, workspace, true, compacted);
}

async function seedHistory(state: string, workspace: string, sessionId: string): Promise<void> {
  await mkdir(state, { recursive: true });
  await writeFile(join(state, "workspace.json"), `${JSON.stringify({ schemaVersion: 1, workspace })}\n`, "utf8");
  const journal = new JsonlSessionJournal({ directory: state });
  const turnId = "seed-turn";
  const stepId = "seed-step";
  await journal.append(sessionId, 0, [
    { type: "session/created", agentId: "nervus-coding-agent" },
    { type: "input/accepted", inputId: "seed-input", content: [{ type: "text", text: "history ".repeat(4000) }] },
    { type: "turn/started", turnId, inputId: "seed-input", agent: {
      agentId: "nervus-coding-agent", revision: 1,
      model: { adapter: "seed", model: "seed" }, modelRevision: 1,
      instructions: [], tools: [], toolRevisions: {},
      limits: { maxSteps: 1, maxToolCalls: 0, maxToolCallsPerStep: 0, maxModelAttempts: 1 },
      timeouts: { modelMs: 1, toolMs: 1 }, skills: [], skillRevisions: {}, contextContributors: [],
    } },
    { type: "user/message", turnId, content: [{ type: "text", text: "history ".repeat(4000) }] },
    { type: "step/started", turnId, stepId, index: 1 },
    { type: "assistant/message", stepId, message: { role: "assistant", content: [{ type: "text", text: "Earlier work completed." }], toolCalls: [] } },
    { type: "step/completed", turnId, stepId },
    { type: "turn/completed", turnId, output: [{ type: "text", text: "Earlier work completed." }] },
  ]);
  await writeFile(join(workspace, "M12_NOTE.md"), "Nervus is an event-recorded Agent Kernel.\n", "utf8");
}

async function execute(pass: Receipt["pass"], id: string, workspace: string, input: string): Promise<Run> {
  return invoke("run", pass, id, workspace, join(dirname(workspace), `state-${id}`), input);
}
interface Run { record: CodingRunRecord; events: SessionEventEnvelope[]; turns: number }
async function invoke(mode: "run" | "resume", pass: Receipt["pass"], id: string, workspace: string, state: string, input: string, adapter?: ModelAdapter): Promise<Run> {
  const io = capture();
  const args = mode === "run"
    ? ["run", "--workspace", workspace, "--state-dir", state, "--session", `${pass}-${id}`, "--json", input]
    : ["resume", `${pass}-${id}`, "--workspace", workspace, "--state-dir", state, "--json", input];
  const code = await runCodingCli(args, { io, ...(adapter ? { modelAdapter: adapter } : {}) });
  if (code !== 0) throw new Error(`${id} Host failure: ${io.errors.join("")}`);
  const output = io.output.join("");
  if (output.includes(apiKey) || io.errors.join("").includes(apiKey)) throw new Error("API key leak");
  const journal = new JsonlSessionJournal({ directory: state });
  const events = [...await journal.read(`${pass}-${id}`)];
  if (JSON.stringify(events).includes(apiKey)) throw new Error("Journal API key leak");
  return { record: JSON.parse(output) as CodingRunRecord, events, turns: 1 };
}

async function receipt(id: string, pass: Receipt["pass"], run: Run, workspace: string, instructionCompliant: boolean, compactionCount = 0): Promise<Receipt> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: workspace });
  const changedFiles = stdout.split("\n").filter(Boolean).map((line) => line.slice(3)).sort();
  return {
    id, pass, turns: run.turns, completed: run.record.status === "completed",
    verified: true, changedFiles, metrics: collectCodingMetrics(run.events),
    instructionCompliant, compactionCount,
  };
}
function toolCalls(events: readonly SessionEventEnvelope[]) { return events.flatMap((event) => event.payload.type === "tool/call-started" ? [event.payload.call] : []); }
async function verify(workspace: string) { await execFileAsync("npm", ["test"], { cwd: workspace }); }
async function init(workspace: string) { await execFileAsync("git", ["init", "-q"], { cwd: workspace }); await execFileAsync("git", ["add", "."], { cwd: workspace }); await execFileAsync("git", ["-c", "user.name=Nervus M12", "-c", "user.email=m12@nervus.invalid", "commit", "-qm", "fixture"], { cwd: workspace }); }
async function files(workspace: string, values: Record<string, string>) { for (const [name, value] of Object.entries(values)) { const target = join(workspace, name); await mkdir(dirname(target), { recursive: true }); await writeFile(target, value, "utf8"); } }
function pkg(test: string) { return `${JSON.stringify({ private: true, type: "module", scripts: { test } }, null, 2)}\n`; }
function testSource(name: string, source: string, expected: string) { return `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { ${name} } from '${source}';\ntest('${name}', () => assert.equal(${name}, '${expected}'));\n`; }
async function nervusCopy(target: string) { await mkdir(target, { recursive: true }); const archive = join(target, "repo.tar"); await execFileAsync("git", ["archive", "--format=tar", "HEAD", "-o", archive], { cwd: resolve(".") }); await execFileAsync("tar", ["-xf", archive, "-C", target]); await rm(archive); await symlink(resolve("node_modules"), join(target, "node_modules"), "dir"); await init(target); return target; }
function capture(): CodingCliIO & { output: string[]; errors: string[] } { const output: string[] = [], errors: string[] = []; return { output, errors, write: (v) => output.push(v), writeError: (v) => errors.push(v), onInterrupt: () => () => {} }; }
function requiredEnv(name: string) { const value = process.env[name]; if (!value) throw new Error(`Set ${name}`); return value; }
function deepSeekAdapter(contextWindow: number): ModelAdapter { return new OpenAICompatibleChatAdapter({ id: "m12/deepseek", baseUrl: requiredEnv("OPENAI_BASE_URL"), apiKey, compatibility: "deepseek", instructionRole: "system", capabilities: { contextWindow, maxOutputTokens: 400 }, extraBody: { thinking: { type: "enabled" }, reasoning_effort: process.env.DEEPSEEK_REASONING_EFFORT ?? "high" } }); }
