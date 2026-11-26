const PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /AIza[0-9A-Za-z_-]{30,}/g, replacement: "[REDACTED_GOOGLE_KEY]" },
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, replacement: "[REDACTED_ANTHROPIC_KEY]" },
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replacement: "[REDACTED_API_KEY]" },
  { pattern: /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}\b/g, replacement: "[REDACTED_GITHUB_TOKEN]" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement: "[REDACTED_GITHUB_TOKEN]" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED_AWS_KEY]" },
  {
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  { pattern: /((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/-]{12,}=*/gi, replacement: "$1[REDACTED]" },
  { pattern: /([?&](?:key|api_key|token|secret|password)=)[^&\s"'`}]+/gi, replacement: "$1[REDACTED]" },
  {
    pattern: /((?:x-goog-api-key|api[_-]?key|bridge[_-]?token|resumption[_-]?handle|token|secret|password)\s*[=:]\s*)["']?[^\s"',}]{8,}/gi,
    replacement: "$1[REDACTED]",
  },
];

/** Remove credential-shaped substrings from anything that may be logged. */
export function redactText(input: string): string {
  let output = input;
  for (const { pattern, replacement } of PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

const SENSITIVE_KEYS =
  /^(x-goog-api-key|api_?key|apikey|authorization|password|secret|token|credential|private_?key|newHandle|resumptionHandle|resumption_handle|bridgeToken|bridge_token)$/i;

/** Deep-redact a structured value before it reaches logs, audit or the bridge. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[DEPTH_LIMIT]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEYS.test(key) ? "[REDACTED]" : redactValue(entry, depth + 1);
    }
    return result;
  }
  return value;
}
