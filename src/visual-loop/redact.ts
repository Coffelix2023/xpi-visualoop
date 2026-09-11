const MAX_DIAGNOSTIC_MESSAGE = 500;

/**
 * Redacts credential-shaped text and bounds the length of a diagnostics message.
 * Shared by the CDP client paths and the legacy harness error reporting so both
 * surfaces stay identical while the external backend is being removed.
 */
export function sanitizeDiagnosticMessage(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /\b(authorization|cookie|token|password|secret|api[-_]?key)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
      "$1=[redacted]",
    )
    .slice(0, MAX_DIAGNOSTIC_MESSAGE);
}

/** Keeps only the scheme and host of an untrusted URL reported by the browser. */
export function safeDiagnosticUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}`;
  } catch {
    return "unknown";
  }
}
