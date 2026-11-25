export interface ParsedToolCall {
  name: string;
  args: Record<string, unknown>;
}

export type ParsedModelOutput =
  | { kind: "kernel_command"; commands: string[] }
  | { kind: "tool_calls"; calls: ParsedToolCall[] }
  | { kind: "unknown"; text: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Python's json.loads(strict=False) accepts raw newlines and tabs inside
 * strings. JSON.parse does not, so escape only unescaped control characters
 * while preserving existing escapes and string boundaries.
 */
function lenientJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    let repaired = "";
    let inString = false;
    let escaped = false;
    for (const character of text) {
      if (inString) {
        if (escaped) {
          repaired += character;
          escaped = false;
          continue;
        }
        if (character === "\\") {
          repaired += character;
          escaped = true;
          continue;
        }
        if (character === '"') {
          repaired += character;
          inString = false;
          continue;
        }
        if (character === "\n") {
          repaired += "\\n";
          continue;
        }
        if (character === "\r") {
          repaired += "\\r";
          continue;
        }
        if (character === "\t") {
          repaired += "\\t";
          continue;
        }
        if (character.charCodeAt(0) < 0x20) {
          repaired += `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
          continue;
        }
        repaired += character;
        continue;
      }
      if (character === '"') inString = true;
      repaired += character;
    }
    return JSON.parse(repaired);
  }
}

function callFrom(value: unknown): ParsedToolCall | null {
  if (!isRecord(value)) return null;
  const name = typeof value.tool === "string" ? value.tool : typeof value.name === "string" ? value.name : "";
  if (name.length === 0) return null;
  const args = value.args ?? value.arguments ?? value.parameters;
  return { name, args: isRecord(args) ? args : {} };
}

function normalizeCalls(value: unknown): ParsedToolCall[] | null {
  if (Array.isArray(value)) {
    const calls = value.map(callFrom).filter((call): call is ParsedToolCall => call !== null);
    return calls.length === value.length ? calls : null;
  }
  const single = callFrom(value);
  return single === null ? null : [single];
}

function decodeCalls(value: unknown): ParsedToolCall[] | null {
  const normalized = normalizeCalls(value);
  return normalized !== null && normalized.length > 0 ? normalized : null;
}

/** Extract the first balanced JSON object/array, ignoring trailing prose. */
function extractBalanced(text: string, start: number): string | null {
  const opener = text[start];
  const closer = opener === "{" ? "}" : opener === "[" ? "]" : null;
  if (closer === null) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === opener) depth += 1;
    if (character === closer) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/**
 * Port of archive/core/orchestration/parser.py.
 *
 * Native provider function calling remains the primary path. This parser is
 * only a fallback for models that emit tool calls as text. Parsed calls still
 * pass through the same registry, policy, approval and execution gateway.
 */
export function parseModelOutput(input: string): ParsedModelOutput {
  const text = input.trim();
  if (text.length === 0) return { kind: "unknown", text: "" };
  if (text.startsWith("#")) return { kind: "kernel_command", commands: [text] };

  const fenced = /```json\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1] !== undefined) {
    try {
      const calls = decodeCalls(lenientJsonParse(fenced[1].trim()));
      if (calls !== null) return { kind: "tool_calls", calls };
    } catch {
      // Fall through to direct parsing.
    }
  }

  try {
    const calls = decodeCalls(lenientJsonParse(text));
    if (calls !== null) return { kind: "tool_calls", calls };
  } catch {
    // Fall through to a balanced scan.
  }

  for (const marker of ["[", "{"]) {
    const start = text.indexOf(marker);
    if (start === -1) continue;
    const candidate = extractBalanced(text, start);
    if (candidate === null) continue;
    try {
      const calls = decodeCalls(lenientJsonParse(candidate));
      if (calls !== null) return { kind: "tool_calls", calls };
    } catch {
      // Try the other marker.
    }
  }

  return { kind: "unknown", text };
}
