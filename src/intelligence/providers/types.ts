import type { ApprovalRequest, ToolExecutionStatus } from "../../shared/contracts/index.js";
import type { PublicError } from "../../shared/errors/index.js";
import type { ToolDescriptor } from "../../tools/registry/types.js";

export type CapabilitySupport = boolean | "unknown";
export type CapabilitySource = "catalog" | "runtime" | "catalog+runtime" | "unknown";

export type ProviderPart =
  | { kind: "text"; text: string; thought?: boolean }
  | { kind: "inline_data"; mimeType: string; data: string; displayName?: string }
  | { kind: "file_data"; mimeType: string; fileUri: string; displayName?: string }
  | {
      kind: "function_call";
      id: string;
      name: string;
      args: Record<string, unknown>;
      thoughtSignature?: string;
    }
  | { kind: "function_response"; id: string; name: string; response: Record<string, unknown> };

export interface ProviderMessage {
  role: "user" | "model";
  parts: ProviderPart[];
}

export type ProviderThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

export interface ProviderThinkingConfig {
  budgetTokens?: number;
  level?: ProviderThinkingLevel;
  includeThoughts?: boolean;
}

export interface ProviderStructuredOutputRequest<T = unknown> {
  /** JSON Schema passed to the provider when structured output is requested. */
  jsonSchema?: Record<string, unknown>;
  /** Human-readable schema name for error context. */
  schemaName?: string;
  /** Optional runtime validator applied after JSON parsing. */
  validate?: (value: unknown) => { ok: true; data: T } | { ok: false; error: string };
  /** Maximum bounded repair attempts when invalid JSON or schema mismatch occurs. */
  maxRepairAttempts?: number;
}

export type ProviderToolChoice = "auto" | "any" | "none" | "validated";

export interface ProviderRequest {
  system: string;
  messages: ProviderMessage[];
  tools: ToolDescriptor[];
  signal?: AbortSignal;
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  /** Per-request deadline in milliseconds, composed cleanly with `signal`. */
  timeoutMs?: number;
  thinking?: ProviderThinkingConfig;
  structuredOutput?: ProviderStructuredOutputRequest;
  toolChoice?: ProviderToolChoice;
  allowedTools?: string[];
}

export interface ProviderFunctionCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Opaque thinking signature echoed back cleanly in subsequent model turns. */
  thoughtSignature?: string;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  thoughtsTokens?: number;
  toolUsePromptTokens?: number;
}

export interface ProviderSafetyRating {
  category: string;
  probability: string;
  blocked?: boolean;
}

export interface ProviderResponse {
  text: string;
  functionCalls: ProviderFunctionCall[];
  usage: ProviderUsage;
  finishReason?: string;
  reasoning?: string;
  modelVersion?: string;
  responseId?: string;
  safetyRatings?: ProviderSafetyRating[];
  parsedStructured?: unknown;
}

export interface ProviderStructuredResult<T> {
  data: T;
  response: ProviderResponse;
  repaired: boolean;
}

export type ProviderStreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "function_call"; call: ProviderFunctionCall }
  | { type: "usage"; usage: ProviderUsage }
  | { type: "done"; response: ProviderResponse };

export interface ProviderCapabilityDetails {
  streaming: CapabilitySupport;
  functionCalling: CapabilitySupport;
  structuredOutput: CapabilitySupport;
  multimodalInput: CapabilitySupport;
  nativeAudio: CapabilitySupport;
  liveSession: CapabilitySupport;
  thinking: CapabilitySupport;
}

export interface ProviderCapabilities {
  streaming: boolean;
  functionCalling: boolean;
  nativeAudio: boolean;
  liveSession: boolean;
  structuredOutput?: CapabilitySupport;
  multimodalInput?: CapabilitySupport;
  thinking?: CapabilitySupport;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  knownModel?: boolean;
  source?: CapabilitySource;
  details?: ProviderCapabilityDetails;
}

export interface ProviderModelMetadata {
  model: string;
  displayName?: string;
  description?: string;
  version?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedActions?: string[];
  source: CapabilitySource;
  knownModel: boolean;
  details: ProviderCapabilityDetails;
}

export interface ProviderGateway {
  readonly name: string;
  readonly model: string;
  capabilities(): ProviderCapabilities;
  generate(request: ProviderRequest): Promise<ProviderResponse>;
  stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent>;
}

export interface ProviderProbeResult {
  ok: boolean;
  model: string;
  detail: string;
  capabilities: ProviderCapabilities;
  metadata?: ProviderModelMetadata;
}

/* -------------------------------------------------------------------------- */
/* Module 02B Live session contracts                                           */
/* -------------------------------------------------------------------------- */

export type LiveModality = "TEXT" | "AUDIO";
export type LiveTransportState = "idle" | "connecting" | "open" | "closing" | "closed" | "error";
export type LiveConnectionState =
  | "IDLE"
  | "CONNECTING"
  | "CONNECTED"
  | "RECONNECTING"
  | "CLOSING"
  | "CLOSED"
  | "FAILED";
export type LiveActivityState =
  | "idle"
  | "listening"
  | "user_speaking"
  | "model_responding"
  | "tool_executing"
  | "interrupted";

export interface LiveAudioFormat {
  mimeType: string;
  sampleRate: number;
  channels: number;
  bitsPerSample: 16;
}

export interface LiveAudioChunk {
  /** Raw PCM bytes. Base64 conversion happens only at the SDK boundary. */
  data: Uint8Array;
  /** Defaults to raw 16-bit little-endian PCM at 16 kHz. */
  mimeType?: string;
  streamId: string;
  sequence: number;
}

export interface LiveReconnectConfig {
  /** Total reconnection budget for one continuous conversational session. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** A replacement session replays finalized text context; it is never called a resume. */
  allowReplacementSession?: boolean;
  random?: () => number;
}

export interface LiveContextWindowCompressionConfig {
  triggerTokens?: number;
  targetTokens?: number;
}

export interface LiveSessionConfig {
  /** Defaults to the manager's configured Live model. */
  model?: string;
  /** Stable application session id used for context and provenance. */
  sessionId?: string;
  /** Durable AELVO conversation to continue. */
  contextSessionId?: string;
  systemInstruction?: string;
  responseModalities?: LiveModality[];
  /** Omit to advertise the application registry; pass [] to disable tools. */
  tools?: ToolDescriptor[];
  temperature?: number;
  maxOutputTokens?: number;
  voiceName?: string;
  /** BCP-47 language codes for transcription hints. */
  inputLanguageCodes?: string[];
  outputLanguageCodes?: string[];
  inputAudioTranscription?: boolean;
  outputAudioTranscription?: boolean;
  thinking?: ProviderThinkingConfig;
  contextWindowCompression?: LiveContextWindowCompressionConfig;
  sessionResumption?: boolean;
  automaticActivityDetection?: boolean;
  activityHandling?: "interrupt" | "no_interrupt";
  /** Explicitly opt in before using a model whose Live capability is unknown. */
  allowUnverifiedModel?: boolean;
  connectTimeoutMs?: number;
  setupTimeoutMs?: number;
  maxInputQueue?: number;
  maxEventQueue?: number;
  reconnect?: LiveReconnectConfig;
  signal?: AbortSignal;
}

export interface LiveSessionEventMeta {
  sessionId: string;
  connectionGeneration: number;
  at: string;
}

export type LiveSessionEventPayload =
  | { type: "open"; model: string; resumed: boolean }
  | { type: "setup_complete"; providerSessionId?: string }
  | { type: "text"; text: string; generationId: string; thought?: boolean }
  | {
      type: "audio";
      data: Uint8Array;
      mimeType: string;
      format: LiveAudioFormat;
      generationId: string;
    }
  | { type: "input_transcription"; text: string; final: boolean }
  | { type: "output_transcription"; text: string; final: boolean }
  | { type: "function_call"; calls: ProviderFunctionCall[]; generationId: string }
  | { type: "function_call_cancellation"; ids: string[] }
  | {
      type: "tool_result";
      callId: string;
      name: string;
      status: ToolExecutionStatus;
      summary?: string;
      error?: { code: string; message: string };
    }
  | { type: "approval_required"; callId: string; approval: ApprovalRequest }
  | { type: "interrupted"; generationId: string; providerNotified: boolean }
  | { type: "turn_complete"; generationId: string; reason?: string }
  | { type: "generation_complete"; generationId: string }
  | { type: "usage"; usage: ProviderUsage }
  | { type: "resumption_update"; resumable: boolean }
  | { type: "connection_expiring"; timeLeftMs?: number }
  | { type: "reconnecting"; attempt: number; delayMs: number; reason: string }
  | { type: "reconnected"; resumed: boolean }
  | { type: "error"; error: PublicError; fatal: boolean }
  | { type: "close"; code?: number; reason?: string; expected: boolean };

export type LiveSessionEvent = LiveSessionEventMeta & LiveSessionEventPayload;

export interface LiveToolResponseInput {
  id: string;
  name: string;
  response: Record<string, unknown>;
}

export interface LiveSessionHandle {
  readonly sessionId: string;
  readonly contextSessionId: string;
  readonly model: string;
  state(): LiveTransportState;
  connectionState(): LiveConnectionState;
  activityState(): LiveActivityState;
  sendText(text: string, turnComplete?: boolean): void;
  /** Low-latency user text input; the server applies normal VAD/turn behavior. */
  sendRealtimeText(text: string): void;
  sendAudio(chunk: LiveAudioChunk): void;
  /** Compatibility boundary for callers that already hold base64 media. */
  sendMediaChunk(mimeType: string, base64Data: string): void;
  sendActivityStart(streamId: string): void;
  sendActivityEnd(streamId: string): void;
  sendAudioStreamEnd(streamId: string): void;
  sendToolResponses(responses: LiveToolResponseInput[]): void;
  resolveApproval(approvalId: string, approved: boolean): Promise<void>;
  /** Invalidate the current output generation and notify downstream playback. */
  interrupt(): void;
  close(): void;
  events(): AsyncIterable<LiveSessionEvent>;
}

export interface LiveProviderBoundary {
  createLiveSession(config?: LiveSessionConfig): Promise<LiveSessionHandle>;
}
