export type KernelErrorCode =
  | "INVALID_AGENT_SPEC"
  | "REGISTRATION_CONFLICT"
  | "SESSION_CONFLICT"
  | "CONTEXT_OVERFLOW"
  | "COMPACTION_FAILED"
  | "KERNEL_DISPOSING"
  | "INVARIANT_VIOLATION";

export class KernelError extends Error {
  readonly code: KernelErrorCode;

  constructor(code: KernelErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KernelError";
    this.code = code;
  }
}
