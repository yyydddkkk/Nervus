import {
  createKernel,
  yoloToolAuthorizer,
  type ToolAuthorizationDecision,
} from "../src/index.js";

const iterations = Number.parseInt(
  process.env.NERVUS_AUTHORIZATION_BENCH_ITERATIONS ?? "1000000",
  10,
);
if (!Number.isSafeInteger(iterations) || iterations <= 0) {
  throw new Error("NERVUS_AUTHORIZATION_BENCH_ITERATIONS must be a positive integer");
}

const call = { id: "bench", toolId: "bench/tool", arguments: {} } as const;
const context = {
  sessionId: "bench-session",
  turnId: "bench-turn",
  stepId: "bench-step",
  callId: call.id,
  signal: new AbortController().signal,
};
const allow = Object.freeze({ status: "allow" } as const);
const kernel = await createKernel();

try {
  const results = [
    benchmark("inline-allow", () => allow),
    benchmark("yolo-adapter", () => yoloToolAuthorizer.authorize(call, context)),
    benchmark("existing-tools-module", () =>
      kernel.context.tools.has("bench/missing") ? allow : allow),
    benchmark("authorization-module", () =>
      kernel.context.toolAuthorization.authorize(call, context)),
  ];
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    iterations,
    results,
  }, null, 2)}\n`);
} finally {
  await kernel.dispose();
}

function benchmark(
  name: string,
  operation: () => ToolAuthorizationDecision | PromiseLike<ToolAuthorizationDecision>,
): { readonly name: string; readonly nanosecondsPerCall: number } {
  let checksum = 0;
  for (let index = 0; index < 100_000; index += 1) {
    const decision = operation();
    if (isPromiseLike(decision)) throw new Error(`${name} allocated a Promise`);
    checksum += decision.status === "allow" ? 1 : 0;
  }

  const started = process.hrtime.bigint();
  for (let index = 0; index < iterations; index += 1) {
    const decision = operation();
    if (isPromiseLike(decision)) throw new Error(`${name} allocated a Promise`);
    checksum += decision.status === "allow" ? 1 : 0;
  }
  const elapsed = process.hrtime.bigint() - started;
  if (checksum !== iterations + 100_000) throw new Error(`${name} produced an invalid decision`);
  return {
    name,
    nanosecondsPerCall: Number(elapsed) / iterations,
  };
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}
