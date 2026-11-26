import { z } from "zod";

/**
 * Shared contracts between the runtime, the local server bridge, the CLI and
 * the frontend. Schemas are the authority: anything crossing the bridge is
 * parsed, never cast.
 */

export const CapabilitySchema = z.enum([
  "fs.read",
  "fs.write",
  "fs.delete",
  "fs.move",
  "process.inspect",
  "process.exec",
  "app.control",
  "clipboard",
  "notification",
  "memory",
  "schedule",
  "screen",
  "microphone",
  "network",
  "integration",
  "credentials",
  "data.sensitive",
  "destructive",
]);
export type Capability = z.infer<typeof CapabilitySchema>;

export const AutonomyLevelSchema = z.enum(["restricted", "balanced", "high"]);
export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>;

export const RiskLevelSchema = z.enum(["low", "moderate", "high", "critical"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const RequestOriginSchema = z.enum([
  "text",
  "live",
  "graph",
  "task",
  "workflow",
  "mcp",
  "bridge",
  "cli",
  "system",
]);
export type RequestOrigin = z.infer<typeof RequestOriginSchema>;

export const ToolEvidenceSchema = z.object({
  kind: z.enum([
    "file_stat",
    "file_hash",
    "directory_listing",
    "search_results",
    "rows_affected",
    "process_exit",
    "provider_response",
    "external_result",
  ]),
  detail: z.record(z.string(), z.unknown()),
});
export type ToolEvidence = z.infer<typeof ToolEvidenceSchema>;

export const ToolOutcomeSchema = z.object({
  summary: z.string().min(1),
  data: z.unknown(),
  evidence: z.array(ToolEvidenceSchema).min(1),
});
export type ToolOutcome = z.infer<typeof ToolOutcomeSchema>;

export const ToolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const VerificationResultSchema = z.object({
  ok: z.boolean(),
  detail: z.string(),
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

export const ToolExecutionStatusSchema = z.enum([
  "succeeded",
  "failed",
  "denied",
  "approval_required",
  "cancelled",
]);
export type ToolExecutionStatus = z.infer<typeof ToolExecutionStatusSchema>;

export interface ToolExecutionRecord {
  call: ToolCall;
  status: ToolExecutionStatus;
  outcome?: ToolOutcome;
  error?: { code: string; message: string };
  approval?: ApprovalRequest;
  durationMs: number;
  attempts: number;
}

export const ApprovalRequestSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  tool: z.string().min(1),
  capability: CapabilitySchema,
  resource: z.string(),
  digest: z.string().length(64),
  expiresAt: z.string(),
  summary: z.string(),
  sessionId: z.string().min(1).optional(),
  executionId: z.string().min(1).optional(),
  origin: RequestOriginSchema.optional(),
  riskLevel: RiskLevelSchema.optional(),
  scope: z.string().optional(),
  policyEpoch: z.number().int().nonnegative().optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalResolutionSchema = z.object({
  approvalId: z.string().min(1),
  approved: z.boolean(),
});
export type ApprovalResolution = z.infer<typeof ApprovalResolutionSchema>;

export const RunStatusSchema = z.enum([
  "running",
  "waiting_for_approval",
  "completed",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RuntimeRequestSchema = z.object({
  input: z.string().trim().min(1).max(100_000),
  sessionId: z.string().min(1).max(200).optional(),
  /** Request an explicit durable plan instead of the direct conversation loop. */
  plan: z.boolean().default(false),
  /** Continue a run that is blocked on approval. */
  resumeRunId: z.string().min(1).max(200).optional(),
});
export type RuntimeRequest = z.infer<typeof RuntimeRequestSchema>;

/* ------------------------------------------------------------------ events */

export const RuntimeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run.started"), runId: z.string(), sessionId: z.string() }),
  z.object({ type: z.literal("run.waiting_for_approval"), runId: z.string(), approval: ApprovalRequestSchema }),
  z.object({ type: z.literal("run.completed"), runId: z.string(), output: z.string() }),
  z.object({
    type: z.literal("run.failed"),
    runId: z.string(),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
  z.object({ type: z.literal("run.cancelled"), runId: z.string() }),
  z.object({ type: z.literal("message.delta"), runId: z.string(), text: z.string() }),
  z.object({ type: z.literal("tool.started"), runId: z.string(), tool: z.string(), callId: z.string() }),
  z.object({
    type: z.literal("tool.finished"),
    runId: z.string(),
    tool: z.string(),
    callId: z.string(),
    status: ToolExecutionStatusSchema,
    durationMs: z.number(),
  }),
  z.object({ type: z.literal("approval.resolved"), approvalId: z.string(), approved: z.boolean() }),
  z.object({ type: z.literal("task.updated"), taskId: z.string(), status: z.string() }),
  z.object({ type: z.literal("provider.usage"), provider: z.string(), model: z.string(), inputTokens: z.number(), outputTokens: z.number() }),
  z.object({
    type: z.literal("live.session.started"),
    liveSessionId: z.string(),
    connectionGeneration: z.number(),
    model: z.string(),
    resumed: z.boolean(),
  }),
  z.object({
    type: z.literal("live.session.state"),
    liveSessionId: z.string(),
    connectionGeneration: z.number(),
    connectionState: z.enum(["IDLE", "CONNECTING", "CONNECTED", "RECONNECTING", "CLOSING", "CLOSED", "FAILED"]),
    activityState: z.enum(["idle", "listening", "user_speaking", "model_responding", "tool_executing", "interrupted"]),
  }),
  z.object({
    type: z.literal("live.session.closed"),
    liveSessionId: z.string(),
    connectionGeneration: z.number(),
    expected: z.boolean(),
  }),
  z.object({
    type: z.literal("live.interrupted"),
    liveSessionId: z.string(),
    connectionGeneration: z.number(),
    generationId: z.string(),
    providerNotified: z.boolean(),
  }),
  z.object({
    type: z.literal("live.approval_required"),
    liveSessionId: z.string(),
    connectionGeneration: z.number(),
    callId: z.string(),
    approval: ApprovalRequestSchema,
  }),
  z.object({
    type: z.literal("live.input"),
    liveSessionId: z.string(),
    connectionGeneration: z.number(),
    modality: z.enum(["TEXT", "AUDIO"]),
  }),
  z.object({
    type: z.literal("live.tool.response_sent"),
    liveSessionId: z.string(),
    connectionGeneration: z.number(),
    count: z.number(),
  }),
  z.object({
    type: z.literal("live.reconnected"),
    liveSessionId: z.string(),
    connectionGeneration: z.number(),
    resumed: z.boolean(),
  }),
  z.object({
    type: z.literal("live.error"),
    liveSessionId: z.string(),
    error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }),
  }),
  z.object({ type: z.literal("security.emergency_stop"), active: z.boolean() }),
  z.object({ type: z.literal("system.notice"), level: z.enum(["info", "warn", "error"]), message: z.string() }),
]);
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;

/* ------------------------------------------------------------------ server */

export const ServerCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth"), token: z.string().min(1).max(512) }),
  z.object({
    type: z.literal("run.start"),
    input: z.string().trim().min(1).max(100_000),
    sessionId: z.string().min(1).max(200).optional(),
  }),
  z.object({ type: z.literal("run.cancel"), runId: z.string().min(1).max(200) }),
  z.object({ type: z.literal("approval.resolve"), approvalId: z.string().min(1).max(200), approved: z.boolean() }),
  z.object({ type: z.literal("memory.search"), query: z.string().min(1).max(500), limit: z.number().int().min(1).max(50).default(10) }),
  z.object({ type: z.literal("state.get") }),
  z.object({ type: z.literal("subscribe"), topics: z.array(z.string().min(1).max(100)).max(50) }),
  z.object({ type: z.literal("emergency.stop"), reason: z.string().max(300).optional() }),
  z.object({ type: z.literal("emergency.resume"), reason: z.string().max(300).optional() }),
]);
export type ServerCommand = z.infer<typeof ServerCommandSchema>;

export type ServerResponse =
  | { type: "ready"; authRequired: boolean }
  | { type: "authenticated"; sessionId: string }
  | { type: "run.accepted"; runId: string; sessionId: string }
  | { type: "run.state"; runId: string; status: RunStatus; output?: string }
  | { type: "memory.results"; items: unknown[] }
  | { type: "state"; runtime: Record<string, unknown> }
  | { type: "error"; error: { code: string; message: string } }
  | { type: "event"; event: RuntimeEvent };

export const MAX_BRIDGE_MESSAGE_BYTES = 64 * 1024;
