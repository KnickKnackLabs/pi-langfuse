const connectionCodes = [
  "ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT", "EAI_AGAIN",
  "ENOTFOUND", "ENETUNREACH", "EHOSTUNREACH",
] as const;
type ConnectionCode = typeof connectionCodes[number];

export type ExportFailure = Readonly<
  | { reason: "http"; httpStatus: number }
  | { reason: "connection"; connectionCode: ConnectionCode }
  | { reason: "timeout" }
  | { reason: "unknown" }
>;

/** Never forward messages, bodies, headers, URLs or arbitrary error properties. */
export function describeExportFailure(error: unknown, deadlineExpired: boolean): ExportFailure {
  if (deadlineExpired) return Object.freeze({ reason: "timeout" });
  if (error && typeof error === "object" && "code" in error) {
    const code = error.code;
    if (typeof code === "number" && Number.isInteger(code) && code >= 300 && code <= 599) {
      return Object.freeze({ reason: "http", httpStatus: code });
    }
    if (typeof code === "string" && connectionCodes.includes(code as ConnectionCode)) {
      return Object.freeze({ reason: "connection", connectionCode: code as ConnectionCode });
    }
  }
  return Object.freeze({ reason: "unknown" });
}
