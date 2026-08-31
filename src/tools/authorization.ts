import { Service, type Context } from "cordis";

import { KernelError } from "../kernel/error.js";
import type { ToolCall } from "../models/model.js";
import type { ToolInvocationContext } from "./tool.js";

export interface ToolAuthorizerRef {
  readonly id: string;
  readonly revision: number;
}

export type ToolAuthorizationDecision =
  | { readonly status: "allow" }
  | { readonly status: "deny"; readonly reason: string };

export interface ToolAuthorizer extends ToolAuthorizerRef {
  authorize(
    call: ToolCall,
    context: ToolInvocationContext,
  ): ToolAuthorizationDecision | PromiseLike<ToolAuthorizationDecision>;
}

const YOLO_DECISION = Object.freeze({ status: "allow" } as const);

export const yoloToolAuthorizer: ToolAuthorizer = Object.freeze({
  id: "nervus/yolo",
  revision: 1,
  authorize() {
    return YOLO_DECISION;
  },
});

export class ToolAuthorizationModule extends Service {
  private readonly authorizer: ToolAuthorizer;

  constructor(ctx: Context, authorizer: ToolAuthorizer) {
    super(ctx, "toolAuthorization");
    this.authorizer = authorizer;
  }

  ref(): ToolAuthorizerRef {
    return Object.freeze({
      id: this.authorizer.id,
      revision: this.authorizer.revision,
    });
  }

  authorize(
    call: ToolCall,
    context: ToolInvocationContext,
  ): ToolAuthorizationDecision | Promise<ToolAuthorizationDecision> {
    const pending = this.authorizer.authorize(call, context);
    if (!isPromiseLike(pending)) return validateDecision(pending);
    return raceWithAbort(Promise.resolve(pending), context.signal).then(
      validateDecision,
    );
  }
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function validateDecision(
  decision: ToolAuthorizationDecision,
): ToolAuthorizationDecision {
  if (decision.status === "allow") return decision;
  if (decision.status === "deny" && typeof decision.reason === "string") {
    return decision;
  }
  throw new KernelError(
    "INVARIANT_VIOLATION",
    "Tool Authorizer returned an invalid decision",
  );
}

async function raceWithAbort<T>(
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

declare module "cordis" {
  interface Context {
    toolAuthorization: ToolAuthorizationModule;
  }
}
