import type { z } from "zod";
import type { Capability, RequestOrigin, ToolOutcome, VerificationResult } from "../../shared/contracts/index.js";

export interface ToolContext {
  runId: string;
  sessionId: string;
  signal: AbortSignal;
  userInitiated: boolean;
  origin?: RequestOrigin;
  taskId?: string;
}

export interface ToolDefinition<Input> {
  name: string;
  description: string;
  capability: Capability;
  destructive: boolean;
  idempotent: boolean;
  inputSchema: z.ZodType<Input>;
  /** Human-readable target for audit and approval records. */
  resource(input: Input): string;
  /** Canonical absolute paths this call may touch; used by policy. */
  paths(input: Input): string[];
  summary(input: Input): string;
  execute(input: Input, context: ToolContext): Promise<ToolOutcome>;
  /** Independent read-back check; a tool without it must still return evidence. */
  verify?(input: Input, outcome: ToolOutcome, context: ToolContext): Promise<VerificationResult>;
  timeoutMs?: number;
  /** TTL for idempotent read-result caching; omitted means no caching. */
  cacheTtlMs?: number;
}

/** Type-erased tool stored in the registry. Inputs are validated on entry. */
export interface AnyTool {
  name: string;
  description: string;
  capability: Capability;
  destructive: boolean;
  idempotent: boolean;
  inputSchema: z.ZodType;
  resource(input: unknown): string;
  paths(input: unknown): string[];
  summary(input: unknown): string;
  execute(input: unknown, context: ToolContext): Promise<ToolOutcome>;
  verify?(input: unknown, outcome: ToolOutcome, context: ToolContext): Promise<VerificationResult>;
  timeoutMs?: number;
  cacheTtlMs?: number;
}

export function defineTool<Input>(definition: ToolDefinition<Input>): AnyTool {
  const erased: AnyTool = {
    name: definition.name,
    description: definition.description,
    capability: definition.capability,
    destructive: definition.destructive,
    idempotent: definition.idempotent,
    inputSchema: definition.inputSchema,
    resource: (input) => definition.resource(input as Input),
    paths: (input) => definition.paths(input as Input),
    summary: (input) => definition.summary(input as Input),
    execute: (input, context) => definition.execute(input as Input, context),
    ...(definition.timeoutMs === undefined ? {} : { timeoutMs: definition.timeoutMs }),
    ...(definition.cacheTtlMs === undefined ? {} : { cacheTtlMs: definition.cacheTtlMs }),
  };
  if (definition.verify !== undefined) {
    erased.verify = (input, outcome, context) =>
      definition.verify === undefined
        ? Promise.resolve({ ok: true, detail: "no verifier" })
        : definition.verify(input as Input, outcome, context);
  }
  return erased;
}

/** JSON-schema-like description sent to the model. */
export interface ToolDescriptor {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
