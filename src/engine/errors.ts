/** A request struna refuses, with the reason mapped to an RPC/HTTP status. */
export class ProcessError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "invalid_argument" | "failed_precondition",
  ) {
    super(message);
    this.name = "ProcessError";
  }
}
