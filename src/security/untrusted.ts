export type UntrustedSourceKind = "file" | "web" | "mcp" | "tool_output" | "model_args" | "external";

export interface UntrustedProvenance {
  trustLevel: "untrusted";
  source: UntrustedSourceKind;
  origin: string;
  flaggedSignals: string[];
}

const INJECTION_SIGNALS: Array<{ name: string; pattern: RegExp }> = [
  { name: "system_role_spoof", pattern: /<\s*\/?\s*system\s*>|^\s*system\s*:/im },
  {
    name: "instruction_override",
    pattern: /\bignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts|directives|policies)\b/i,
  },
  {
    name: "policy_bypass_attempt",
    pattern: /\b(disable\s+emergency\s+stop|grant\s+(?:yourself|all)\s+permissions|bypass\s+approval)\b/i,
  },
  {
    name: "credential_exfil_attempt",
    pattern: /\b(print|dump|reveal|exfiltrate)\s+(the\s+|your\s+)?(api[_\s-]?key|credentials|secrets|\.env)\b/i,
  },
];

/**
 * Heuristic detector for prompt-injection motifs inside untrusted external data.
 *
 * NOTE: Detection signals are informational telemetry only and NEVER serve as
 * the authorization boundary. PolicyService and ApprovalService remain strictly
 * deterministic and independent of model text interpretation.
 */
export function inspectUntrustedText(text: string): string[] {
  if (text.length === 0) return [];
  const sample = text.length > 32_768 ? text.slice(0, 32_768) : text;
  const matched: string[] = [];
  for (const signal of INJECTION_SIGNALS) {
    if (signal.pattern.test(sample)) {
      matched.push(signal.name);
    }
  }
  return matched;
}

/** Wrap external or model-facing output with explicit untrusted provenance metadata. */
export function tagUntrustedData(
  data: unknown,
  source: UntrustedSourceKind,
  origin: string,
): { payload: unknown; provenance: UntrustedProvenance } {
  const serialized = typeof data === "string" ? data : JSON.stringify(data ?? "");
  return {
    payload: data,
    provenance: {
      trustLevel: "untrusted",
      source,
      origin,
      flaggedSignals: inspectUntrustedText(serialized),
    },
  };
}
