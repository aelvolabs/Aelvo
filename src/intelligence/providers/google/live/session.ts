import {
  ActivityHandling,
  Modality,
  ThinkingLevel,
  type Content,
  type LiveConnectConfig,
  type LiveServerMessage,
} from "@google/genai";
import type { ContextBuilder } from "../../../context/context-builder.js";
import type { MemoryService } from "../../../../memory/service.js";
import type { Logger } from "../../../../observability/logger.js";
import type { RuntimeMetrics } from "../../../../observability/metrics.js";
import { redactText } from "../../../../observability/redact.js";
import type { ApprovalService } from "../../../../security/approvals/service.js";
import { AelvoError, isAelvoError, toPublicError } from "../../../../shared/errors/index.js";
import { newId, nowIso } from "../../../../shared/ids.js";
import type { RuntimeEvent, ToolExecutionRecord } from "../../../../shared/contracts/index.js";
import type { ToolDescriptor } from "../../../../tools/registry/types.js";
import { toGeminiFunctionDeclarations } from "../schema.js";
import { getCatalogModelMetadata, normalizeGoogleModelId } from "../models.js";
import { classifyGoogleError } from "../gateway.js";
import {
  decodeLiveAudio,
  encodeLiveAudio,
  LIVE_INPUT_AUDIO_MIME,
  parsePcmMime,
  validatePcmChunk,
} from "./audio.js";
import { normalizeLiveMessage } from "./protocol.js";
import { LiveRecoveryPolicy } from "./recovery.js";
import {
  LiveToolDispatcher,
  liveToolResponse,
  type LiveToolRuntime,
} from "./tool-dispatch.js";
import type {
  LiveActivityState,
  LiveAudioChunk,
  LiveConnectionState,
  LiveSessionConfig,
  LiveSessionEvent,
  LiveSessionEventPayload,
  LiveSessionHandle,
  LiveToolResponseInput,
  LiveTransportState,
  ProviderThinkingConfig,
} from "../../types.js";
import type { LiveTransport, LiveTransportConnection } from "./transport.js";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A startup failure can occur before a consumer starts awaiting the pump.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

class BoundedEventQueue {
  private readonly items: LiveSessionEvent[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<LiveSessionEvent>) => void;
    reject: (error: Error) => void;
  }> = [];
  private ended = false;
  private error: Error | undefined;

  constructor(private readonly max: number) {}

  push(event: LiveSessionEvent): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ value: event, done: false });
      return;
    }
    if (this.items.length >= this.max) {
      throw new AelvoError(
        "LIVE_QUEUE_OVERFLOW",
        `Live event queue exceeded ${this.max} entries; closing to avoid silent loss`,
        { details: { max: this.max } },
      );
    }
    this.items.push(event);
  }

  end(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.error = error;
    if (error !== undefined) {
      for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    } else {
      for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
    }
  }

  async next(): Promise<IteratorResult<LiveSessionEvent>> {
    const item = this.items.shift();
    if (item !== undefined) return { value: item, done: false };
    if (this.error !== undefined) throw this.error;
    if (this.ended) return { value: undefined, done: true };
    return await new Promise<IteratorResult<LiveSessionEvent>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
}

type InputItem =
  | { kind: "text"; text: string; turnComplete: boolean }
  | { kind: "realtime_text"; text: string }
  | { kind: "audio"; chunk: LiveAudioChunk }
  | { kind: "activity_start" }
  | { kind: "activity_end" }
  | { kind: "audio_stream_end" }
  | { kind: "tool_response"; responses: LiveToolResponseInput[] };

export interface LiveSessionDependencies {
  model: string;
  transport: LiveTransport;
  resolveApiKey: () => Promise<string | undefined>;
  tools: ToolDescriptor[] | (() => ToolDescriptor[]);
  toolRuntime: LiveToolRuntime;
  approvals: ApprovalService;
  isEmergencyStopActive?: () => boolean;
  memory?: MemoryService;
  context?: ContextBuilder;
  metrics?: RuntimeMetrics;
  logger?: Logger;
  onRuntimeEvent?: (event: RuntimeEvent) => void;
  onClosed?: (session: GoogleLiveSession) => void;
}

function clampQueue(value: number | undefined, fallback: number, maxValue: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maxValue, Math.floor(value)));
}

function mapThinkingLevel(level: ProviderThinkingConfig["level"]): ThinkingLevel | undefined {
  switch (level) {
    case undefined:
      return undefined;
    case "MINIMAL":
      return ThinkingLevel.MINIMAL;
    case "LOW":
      return ThinkingLevel.LOW;
    case "MEDIUM":
      return ThinkingLevel.MEDIUM;
    case "HIGH":
      return ThinkingLevel.HIGH;
  }
}

/**
 * One Live connection session. Connection state and conversational activity
 * are intentionally separate: audio can arrive while output is active, and a
 * failed reconnect must not make the conversation look completed.
 */
export class GoogleLiveSession implements LiveSessionHandle {
  readonly sessionId: string;
  readonly model: string;
  readonly contextSessionId: string;

  private readonly deps: LiveSessionDependencies;
  private readonly config: LiveSessionConfig;
  private readonly metadata: ReturnType<typeof getCatalogModelMetadata>;
  private readonly recovery: LiveRecoveryPolicy;
  private readonly eventQueue: BoundedEventQueue;
  private readonly inputQueue: InputItem[] = [];
  private readonly maxInputQueue: number;
  private readonly sessionAbort = new AbortController();
  private readonly sessionStartedAt = Date.now();
  private connectionStartedAt = 0;
  private setupStartedAt = 0;
  private firstTextRecorded = false;
  private firstAudioRecorded = false;
  private readonly sequences = new Map<string, number>();
  private readonly pendingServerMessages: Array<{ message: LiveServerMessage; generation: number }> = [];
  private readonly toolDispatcher: LiveToolDispatcher;
  private readonly systemInstruction: string;
  private readonly initialReplay: Content[];
  private readonly shutdownSignal: AbortSignal | undefined;
  private replayInitialized = false;

  private connection: LiveTransportConnection | undefined;
  private connectionAbort: AbortController | undefined;
  private connectionGeneration = 0;
  private generationId = newId("gen");
  private connectionStateValue: LiveConnectionState = "IDLE";
  private transportStateValue: LiveTransportState = "idle";
  private activityStateValue: LiveActivityState = "idle";
  private setupComplete = false;
  private setupDeferred: Deferred;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private setupTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private recovering = false;
  private started = false;
  private closing = false;
  private expectedClose = false;
  private disposed = false;
  private pumpRunning = false;
  private resumptionHandle: string | undefined;
  private currentResumed = false;
  private inputTranscript = "";
  private outputTranscript = "";
  private assistantText = "";
  private outputFinalizedThisTurn = false;
  private inputFinalizedThisTurn = false;

  constructor(deps: LiveSessionDependencies, config: LiveSessionConfig = {}) {
    this.deps = deps;
    this.config = config;
    this.model = normalizeGoogleModelId(config.model ?? deps.model);
    if (this.model.length === 0) {
      throw new AelvoError("CONFIG_MISSING", "A Live model is required");
    }
    this.sessionId = config.sessionId ?? newId("live");
    this.contextSessionId = config.contextSessionId ?? config.sessionId ?? this.sessionId;
    this.metadata = getCatalogModelMetadata(this.model);
    const requestedModalities =
      config.responseModalities ?? (this.metadata.details.nativeAudio === true ? ["AUDIO"] : ["TEXT"]);
    if (requestedModalities.some((modality) => modality !== "AUDIO" && modality !== "TEXT")) {
      throw new AelvoError("CONFIG_INVALID", "Live response modality must be AUDIO or TEXT");
    }
    if (this.metadata.details.nativeAudio === true && requestedModalities.includes("TEXT")) {
      throw new AelvoError(
        "PROVIDER_MODEL_UNSUPPORTED",
        `Native-audio Live model ${this.model} does not support TEXT responseModality; use AUDIO with outputAudioTranscription`,
        { details: { model: this.model, responseModalities: requestedModalities } },
      );
    }
    if (this.metadata.details.liveSession === false) {
      throw new AelvoError(
        "PROVIDER_MODEL_UNSUPPORTED",
        `Model ${this.model} does not advertise Gemini Live support`,
        { details: { model: this.model } },
      );
    }
    if (this.metadata.details.liveSession === "unknown" && config.allowUnverifiedModel !== true) {
      throw new AelvoError(
        "PROVIDER_MODEL_UNSUPPORTED",
        `Live support for model ${this.model} is unknown; pass allowUnverifiedModel only after checking it`,
        { details: { model: this.model } },
      );
    }
    if (this.metadata.details.nativeAudio === true && config.outputLanguageCodes !== undefined) {
      throw new AelvoError(
        "PROVIDER_MODEL_UNSUPPORTED",
        `Native-audio Live model ${this.model} chooses its output language automatically; outputLanguageCodes is not supported`,
        { details: { model: this.model } },
      );
    }
    if (this.metadata.details.functionCalling === false && deps.tools.length > 0) {
      throw new AelvoError(
        "PROVIDER_MODEL_UNSUPPORTED",
        `Model ${this.model} does not advertise Live function calling`,
        { details: { model: this.model } },
      );
    }

    if (this.config.thinking !== undefined && this.metadata.details.thinking !== true) {
      throw new AelvoError(
        "PROVIDER_MODEL_UNSUPPORTED",
        `Thinking configuration is not verified for Live model ${this.model}`,
        { details: { model: this.model, thinking: this.metadata.details.thinking } },
      );
    }

    this.recovery = new LiveRecoveryPolicy(config.reconnect);
    this.maxInputQueue = clampQueue(config.maxInputQueue, 256, 2_048);
    this.eventQueue = new BoundedEventQueue(clampQueue(config.maxEventQueue, 512, 4_096));
    this.setupDeferred = deferred();
    this.shutdownSignal = config.signal;
    this.systemInstruction = config.systemInstruction ?? this.buildSystemInstruction();
    // Snapshot the pre-session history before a caller can append new text
    // while setup is in flight. Replaying that new turn would duplicate it.
    this.initialReplay = this.buildReplayMessages();

    if (this.shutdownSignal?.aborted === true) {
      throw new AelvoError("PROVIDER_ABORTED", "Live session start was cancelled");
    }
    this.shutdownSignal?.addEventListener("abort", this.onShutdownSignal, { once: true });

    this.toolDispatcher = new LiveToolDispatcher({
      runtime: deps.toolRuntime,
      approvals: deps.approvals,
      callbacks: {
        onResult: (record, sendResponse) => this.onToolResult(record, sendResponse),
        onApprovalRequired: (call, approval) => {
          this.emit({
            type: "approval_required",
            callId: call.id,
            approval,
          });
          this.emitRuntime({
            type: "live.approval_required",
            liveSessionId: this.sessionId,
            connectionGeneration: this.connectionGeneration,
            callId: call.id,
            approval,
          });
        },
      },
    });

    this.metrics("live.sessions.created", 1, { model: this.model });
  }

  state(): LiveTransportState {
    return this.transportStateValue;
  }

  connectionState(): LiveConnectionState {
    return this.connectionStateValue;
  }

  activityState(): LiveActivityState {
    return this.activityStateValue;
  }

  events(): AsyncIterable<LiveSessionEvent> {
    const iterator: AsyncIterableIterator<LiveSessionEvent> = {
      next: () => this.eventQueue.next(),
      [Symbol.asyncIterator]: () => iterator,
    };
    return iterator;
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new AelvoError("LIVE_SESSION_STATE_INVALID", "Live session was already started");
    }
    this.started = true;
    this.setConnectionState("CONNECTING");
    try {
      await this.connectOnce(false);
    } catch (error) {
      const classified = this.classify(error);
      this.failPermanent(classified);
      throw classified;
    }
    this.startPump();
  }

  sendText(text: string, turnComplete = true): void {
    if (text.trim().length === 0) {
      throw new AelvoError("LIVE_SESSION_STATE_INVALID", "Live text input must not be empty");
    }
    if (text.length > 100_000) {
      throw new AelvoError("LIVE_SESSION_STATE_INVALID", "Live text input exceeds 100,000 characters");
    }
    this.assertOpenForInput();
    this.enqueue({ kind: "text", text, turnComplete });
    this.setActivity("listening", true);
    this.startPump();
  }

  sendRealtimeText(text: string): void {
    if (text.trim().length === 0) {
      throw new AelvoError("LIVE_SESSION_STATE_INVALID", "Live text input must not be empty");
    }
    if (text.length > 100_000) {
      throw new AelvoError("LIVE_SESSION_STATE_INVALID", "Live text input exceeds 100,000 characters");
    }
    this.assertOpenForInput();
    this.enqueue({ kind: "realtime_text", text });
    this.setActivity("listening", true);
    this.startPump();
  }

  sendAudio(chunk: LiveAudioChunk): void {
    this.assertOpenForInput();
    validatePcmChunk(chunk.data, "Live audio chunk");
    const expected = this.sequences.get(chunk.streamId) ?? 0;
    if (chunk.sequence !== expected) {
      throw new AelvoError(
        "LIVE_SESSION_STATE_INVALID",
        `Live audio stream ${chunk.streamId} expected sequence ${expected}, received ${chunk.sequence}; refusing to reorder`,
        { details: { streamId: chunk.streamId, expected, received: chunk.sequence } },
      );
    }
    const mimeType = parsePcmMime(chunk.mimeType, 16_000).mimeType;
    this.sequences.set(chunk.streamId, expected + 1);
    this.enqueue({
      kind: "audio",
      // The caller may reuse its capture buffer; retain an owned frame so a
      // later write cannot corrupt audio that is still queued.
      chunk: { ...chunk, data: chunk.data.slice(), mimeType },
    });
    this.setActivity("user_speaking", true);
    this.startPump();
  }

  sendMediaChunk(mimeType: string, base64Data: string): void {
    this.assertOpenForInput();
    const data = decodeLiveAudio(base64Data);
    validatePcmChunk(data, "Live compatibility audio chunk");
    const streamId = "compat";
    const sequence = this.sequences.get(streamId) ?? 0;
    this.sequences.set(streamId, sequence + 1);
    this.enqueue({
      kind: "audio",
      chunk: {
        data,
        mimeType: parsePcmMime(mimeType, 16_000).mimeType,
        streamId,
        sequence,
      },
    });
    this.setActivity("user_speaking", true);
    this.startPump();
  }

  sendActivityStart(streamId: string): void {
    this.assertOpenForInput();
    if (this.config.automaticActivityDetection !== false) {
      throw new AelvoError(
        "LIVE_SESSION_STATE_INVALID",
        "Explicit activity signals require automaticActivityDetection=false",
      );
    }
    if (!this.sequences.has(streamId)) this.sequences.set(streamId, 0);
    this.enqueue({ kind: "activity_start" });
    this.setActivity("user_speaking", true);
    this.startPump();
  }

  sendActivityEnd(streamId: string): void {
    this.assertOpenForInput();
    if (this.config.automaticActivityDetection !== false) {
      throw new AelvoError(
        "LIVE_SESSION_STATE_INVALID",
        "Explicit activity signals require automaticActivityDetection=false",
      );
    }
    if (!this.sequences.has(streamId)) this.sequences.set(streamId, 0);
    this.enqueue({ kind: "activity_end" });
    this.setActivity("listening", true);
    this.startPump();
  }

  sendAudioStreamEnd(streamId: string): void {
    this.assertOpenForInput();
    if (this.config.automaticActivityDetection === false) {
      throw new AelvoError(
        "LIVE_SESSION_STATE_INVALID",
        "audioStreamEnd is only valid with automatic activity detection enabled",
      );
    }
    if (!this.sequences.has(streamId)) this.sequences.set(streamId, 0);
    this.enqueue({ kind: "audio_stream_end" });
    this.startPump();
  }

  sendToolResponses(responses: LiveToolResponseInput[]): void {
    this.assertOpenForInput();
    if (responses.length === 0) return;
    for (const response of responses) {
      if (response.id.trim().length === 0 || response.name.trim().length === 0) {
        throw new AelvoError("LIVE_SESSION_STATE_INVALID", "Live tool response requires id and name");
      }
    }
    this.enqueue({ kind: "tool_response", responses });
    this.startPump();
  }

  async resolveApproval(
    approvalId: string,
    approved: boolean,
    decidedBy: "user" | "cli" | "bridge" | "system" | "model" = "user",
  ): Promise<void> {
    if (this.connectionStateValue === "CLOSED" || this.connectionStateValue === "FAILED") {
      throw new AelvoError("LIVE_SESSION_CLOSED", "Live session is closed");
    }
    await this.toolDispatcher.resolveApproval(approvalId, approved, decidedBy);
  }

  interrupt(): void {
    if (this.connectionStateValue === "CLOSED" || this.connectionStateValue === "FAILED") {
      throw new AelvoError("LIVE_SESSION_CLOSED", "Live session is closed");
    }
    const previous = this.generationId;
    this.generationId = newId("gen");
    this.activityStateValue = "interrupted";
    this.emit({ type: "interrupted", generationId: previous, providerNotified: false });
    this.emitState();
    this.metrics("live.interruptions", 1, { model: this.model, source: "application" });
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closing = true;
    this.expectedClose = true;
    this.connectionStateValue = "CLOSING";
    this.transportStateValue = "closing";
    this.emitState();
    this.clearTimers();
    this.sessionAbort.abort(new Error("Live session closed"));
    this.connectionAbort?.abort(new Error("Live session closed"));
    this.connectionAbort = undefined;
    try {
      this.connection?.close();
    } catch {
      // Idempotent close: a transport that is already closed is acceptable.
    }
    this.connection = undefined;
    this.pendingServerMessages.splice(0);
    this.toolDispatcher.close();
    this.inputQueue.splice(0);
    this.rejectSetup(new Error("Live session closed"));
    this.shutdownSignal?.removeEventListener("abort", this.onShutdownSignal);
    this.emit({ type: "close", expected: true });
    this.eventQueue.end();
    this.connectionStateValue = "CLOSED";
    this.transportStateValue = "closed";
    this.emitRuntime({
      type: "live.session.closed",
      liveSessionId: this.sessionId,
      connectionGeneration: this.connectionGeneration,
      expected: true,
    });
    this.metrics("live.sessions.closed", 1, { model: this.model });
    this.deps.onClosed?.(this);
  }

  private assertOpenForInput(): void {
    if (this.disposed || this.closing) {
      throw new AelvoError("LIVE_SESSION_CLOSED", "Live session is closed");
    }
    if (!this.started || this.connectionStateValue === "FAILED") {
      throw new AelvoError("LIVE_SESSION_STATE_INVALID", "Live session is not connected");
    }
  }

  private enqueue(item: InputItem): void {
    if (this.inputQueue.length >= this.maxInputQueue) {
      this.metrics("live.input.queue_overflow", 1, { model: this.model });
      throw new AelvoError(
        "LIVE_QUEUE_OVERFLOW",
        `Live input queue exceeded ${this.maxInputQueue} entries; input was not accepted`,
        { details: { max: this.maxInputQueue } },
      );
    }
    this.inputQueue.push(item);
    this.metrics("live.input.queue_depth", this.inputQueue.length, { model: this.model });
  }

  private startPump(): void {
    if (this.pumpRunning || this.disposed || this.closing) return;
    this.pumpRunning = true;
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      await this.setupDeferred.promise;
      while (!this.disposed && !this.closing) {
        const item = this.inputQueue.shift();
        if (item === undefined) break;
        await this.sendInput(item);
        this.metrics("live.input.queue_depth", this.inputQueue.length, { model: this.model });
      }
    } catch (error) {
      if (!this.closing && !this.disposed) this.handleTransportFailure(error);
    } finally {
      this.pumpRunning = false;
      if (!this.disposed && !this.closing && this.inputQueue.length > 0) this.startPump();
    }
  }

  private async sendInput(item: InputItem): Promise<void> {
    const connection = this.connection;
    if (connection === undefined) {
      throw new AelvoError("LIVE_SESSION_CLOSED", "Live connection is unavailable");
    }
    const started = Date.now();
    switch (item.kind) {
      case "text":
        connection.sendClientContent({
          turns: [{ role: "user", parts: [{ text: item.text }] }],
          turnComplete: item.turnComplete,
        });
        this.appendMessage("user", item.text, { live: true, modality: "text" });
        this.emitRuntime({
          type: "live.input",
          liveSessionId: this.sessionId,
          connectionGeneration: this.connectionGeneration,
          modality: "TEXT",
        });
        break;
      case "realtime_text":
        connection.sendRealtimeInput({ text: item.text });
        this.appendMessage("user", item.text, { live: true, modality: "text" });
        this.emitRuntime({
          type: "live.input",
          liveSessionId: this.sessionId,
          connectionGeneration: this.connectionGeneration,
          modality: "TEXT",
        });
        break;
      case "audio":
        connection.sendRealtimeInput({
          audio: {
            data: encodeLiveAudio(item.chunk.data),
            mimeType: item.chunk.mimeType ?? LIVE_INPUT_AUDIO_MIME,
          },
        });
        this.metrics("live.audio.input_chunks", 1, { model: this.model });
        this.emitRuntime({
          type: "live.input",
          liveSessionId: this.sessionId,
          connectionGeneration: this.connectionGeneration,
          modality: "AUDIO",
        });
        break;
      case "activity_start":
        connection.sendRealtimeInput({ activityStart: {} });
        break;
      case "activity_end":
        connection.sendRealtimeInput({ activityEnd: {} });
        break;
      case "audio_stream_end":
        connection.sendRealtimeInput({ audioStreamEnd: true });
        break;
      case "tool_response":
        connection.sendToolResponse({
          functionResponses: item.responses.map((response) => ({
            id: response.id,
            name: response.name,
            response: response.response,
          })),
        });
        this.emitRuntime({
          type: "live.tool.response_sent",
          liveSessionId: this.sessionId,
          connectionGeneration: this.connectionGeneration,
          count: item.responses.length,
        });
        break;
    }
    this.metrics("live.input.send_latency_ms", Date.now() - started, { model: this.model });
  }

  private async connectOnce(isReconnect: boolean): Promise<void> {
    if (this.disposed || this.closing) {
      throw new AelvoError("LIVE_SESSION_CLOSED", "Live session is closed");
    }
    const apiKey = await this.deps.resolveApiKey();
    if (apiKey === undefined || apiKey.trim().length === 0) {
      throw new AelvoError("PROVIDER_NOT_CONFIGURED", "Google Live requires an available API key");
    }

    this.connectionGeneration += 1;
    const generation = this.connectionGeneration;
    this.connectionStartedAt = Date.now();
    this.setupStartedAt = this.connectionStartedAt;
    const abort = new AbortController();
    this.connectionAbort = abort;
    this.transportStateValue = "connecting";
    this.connectionStateValue = isReconnect ? "RECONNECTING" : "CONNECTING";
    this.setupComplete = false;
    this.currentResumed = this.resumptionHandle !== undefined;
    this.startSetupTimer(generation);
    const handle = this.currentResumed ? this.resumptionHandle : undefined;

    const connectPromise = this.deps.transport.connect({
      model: this.model,
      apiKey,
      config: this.buildConnectConfig(handle, abort.signal),
      callbacks: {
        onOpen: () => {
          if (!this.isCurrent(generation)) return;
          this.transportStateValue = "open";
        },
        onMessage: (message) => this.handleServerMessage(message, generation),
        onError: (error) => {
          if (!this.isCurrent(generation) || this.connection === undefined) return;
          this.handleTransportFailure(error);
        },
        onClose: (code, reason) => {
          if (!this.isCurrent(generation) || this.connection === undefined) return;
          this.handleTransportClose(code, reason);
        },
      },
    });

    let connection: LiveTransportConnection;
    try {
      connection = await this.withConnectTimeout(connectPromise, generation, abort);
    } catch (error) {
      this.clearConnectTimer();
      this.clearSetupTimer();
      throw error;
    }
    if (!this.isCurrent(generation) || this.disposed || this.closing) {
      try {
        connection.close();
      } catch {
        // The session may have been closed while the connection was opening.
      }
      throw new AelvoError("PROVIDER_ABORTED", "Live connection was superseded");
    }
    this.connection = connection;
    this.transportStateValue = "open";
    this.connectionStateValue = "CONNECTED";
    this.emit({ type: "open", model: this.model, resumed: this.currentResumed });
    this.emitRuntime({
      type: "live.session.started",
      liveSessionId: this.sessionId,
      connectionGeneration: generation,
      model: this.model,
      resumed: this.currentResumed,
    });
    this.metrics("live.connection.established", 1, {
      model: this.model,
      resumed: String(this.currentResumed),
    });
    this.metrics("live.connection.latency_ms", Date.now() - this.connectionStartedAt, {
      model: this.model,
    });
    // The SDK can invoke onmessage before the connect promise resolves. Do not
    // process setup/content while `this.connection` is still undefined or a
    // pump could consume and drop queued input.
    const pending = this.pendingServerMessages.splice(0);
    for (const item of pending) {
      if (item.generation === generation) this.processServerMessage(item.message, generation);
    }
  }

  private async withConnectTimeout(
    promise: Promise<LiveTransportConnection>,
    generation: number,
    abort: AbortController,
  ): Promise<LiveTransportConnection> {
    const timeoutMs = this.config.connectTimeoutMs ?? 15_000;
    return await new Promise<LiveTransportConnection>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        abort.abort(new Error("Live connection timed out"));
        reject(new AelvoError("PROVIDER_TIMEOUT", `Live connection timed out after ${timeoutMs}ms`, { retryable: true }));
      }, timeoutMs);
      this.connectTimer = timer;
      promise.then(
        (connection) => {
          if (settled) {
            try {
              connection.close();
            } catch {
              // Late connection after timeout.
            }
            return;
          }
          settled = true;
          clearTimeout(timer);
          if (this.connectTimer === timer) this.connectTimer = undefined;
          if (!this.isCurrent(generation)) {
            try {
              connection.close();
            } catch {
              // Superseded connection.
            }
            reject(new AelvoError("PROVIDER_ABORTED", "Live connection was superseded"));
            return;
          }
          resolve(connection);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (this.connectTimer === timer) this.connectTimer = undefined;
          reject(error);
        },
      );
    });
  }

  private startSetupTimer(generation: number): void {
    this.clearSetupTimer();
    const timeoutMs = this.config.setupTimeoutMs ?? 15_000;
    this.setupTimer = setTimeout(() => {
      if (!this.isCurrent(generation) || this.setupComplete || this.closing) return;
      this.handleTransportFailure(
        new AelvoError("PROVIDER_TIMEOUT", `Live setup did not complete within ${timeoutMs}ms`, {
          retryable: true,
        }),
      );
    }, timeoutMs);
  }

  private handleServerMessage(message: LiveServerMessage, generation: number): void {
    if (!this.isCurrent(generation) || this.closing || this.disposed) return;
    if (this.connection === undefined) {
      if (this.pendingServerMessages.length >= 128) {
        this.handleTransportFailure(
          new AelvoError("LIVE_QUEUE_OVERFLOW", "Live setup delivered too many messages before the connection was ready"),
        );
        return;
      }
      this.pendingServerMessages.push({ message, generation });
      return;
    }
    this.processServerMessage(message, generation);
  }

  private processServerMessage(message: LiveServerMessage, generation: number): void {
    if (!this.isCurrent(generation) || this.closing || this.disposed) return;
    try {
      if (message.sessionResumptionUpdate?.resumable === true) {
        const handle = message.sessionResumptionUpdate.newHandle;
        if (typeof handle === "string" && handle.length > 0 && handle.length <= 16_384) {
          this.resumptionHandle = handle;
        }
      }
      const events = normalizeLiveMessage(message, { generationId: this.generationId });
      for (const event of events) this.handleProtocolEvent(event);
    } catch (error) {
      this.handleTransportFailure(error);
    }
  }

  private handleProtocolEvent(event: LiveSessionEventPayload): void {
    switch (event.type) {
      case "setup_complete":
        this.setupComplete = true;
        this.clearSetupTimer();
        this.reconnectAttempt = 0;
        this.recovering = false;
        this.activityStateValue = "listening";
        if (this.setupStartedAt > 0) {
          this.metrics("live.setup.latency_ms", Date.now() - this.setupStartedAt, { model: this.model });
        }
        this.setupDeferred.resolve();
        this.emit(event);
        if (!this.currentResumed) this.replayContext();
        this.emitState();
        this.startPump();
        return;
      case "text":
        this.assistantText += event.thought === true ? "" : event.text;
        if (event.thought !== true && !this.firstTextRecorded) {
          this.firstTextRecorded = true;
          this.metrics("live.first_text_ms", Date.now() - this.sessionStartedAt, { model: this.model });
        }
        this.setActivity("model_responding", false);
        this.emit(event);
        return;
      case "audio":
        if (!this.firstAudioRecorded) {
          this.firstAudioRecorded = true;
          this.metrics("live.first_audio_ms", Date.now() - this.sessionStartedAt, { model: this.model });
        }
        this.setActivity("model_responding", false);
        this.emit(event);
        this.metrics("live.audio.output_chunks", 1, {
          model: this.model,
          sampleRate: String(event.format.sampleRate),
        });
        return;
      case "input_transcription":
        this.inputTranscript += event.text;
        if (event.final) {
          const text = this.inputTranscript.trim();
          if (text.length > 0 && !this.inputFinalizedThisTurn) {
            this.appendMessage("user", text, { live: true, modality: "audio_transcript" });
          }
          this.inputTranscript = "";
          this.inputFinalizedThisTurn = true;
        }
        this.emit(event);
        return;
      case "output_transcription":
        this.outputTranscript += event.text;
        if (event.final) {
          const text = this.outputTranscript.trim();
          if (text.length > 0 && !this.outputFinalizedThisTurn) {
            this.appendMessage("assistant", text, { live: true, modality: "audio_transcript" });
          }
          this.outputTranscript = "";
          this.outputFinalizedThisTurn = true;
        }
        this.emit(event);
        return;
      case "function_call":
        this.setActivity("tool_executing", false);
        this.emit(event);
        this.metrics("live.tool.calls", event.calls.length, { model: this.model });
        void this.toolDispatcher
          .dispatch(event.calls, this.toolContext())
          .catch((error: unknown) => this.handleTransportFailure(error));
        return;
      case "function_call_cancellation":
        this.toolDispatcher.cancel(event.ids);
        this.emit(event);
        return;
      case "interrupted":
        this.onInterrupted(event);
        return;
      case "turn_complete":
        this.finishTurn(event);
        return;
      case "generation_complete":
        this.emit(event);
        return;
      case "usage":
        this.emit(event);
        this.metrics("live.usage.input", event.usage.inputTokens, { model: this.model });
        this.metrics("live.usage.output", event.usage.outputTokens, { model: this.model });
        return;
      case "resumption_update":
        this.emit(event);
        return;
      case "connection_expiring":
        this.emit(event);
        if (event.timeLeftMs !== undefined) {
          const delay = Math.max(0, event.timeLeftMs - 1_000);
          if (this.reconnectTimer === undefined && !this.recovering) {
            this.reconnectTimer = setTimeout(() => {
              this.reconnectTimer = undefined;
              this.scheduleReconnect("Live connection is expiring");
            }, delay);
          }
        }
        return;
      case "approval_required":
      case "tool_result":
      case "error":
      case "close":
      case "open":
      case "reconnecting":
      case "reconnected":
        // These payloads are emitted by the session itself, never accepted
        // from a server message.
        return;
    }
  }

  private onInterrupted(event: Extract<LiveSessionEventPayload, { type: "interrupted" }>): void {
    this.activityStateValue = "interrupted";
    this.emit(event);
    this.emitRuntime({
      type: "live.interrupted",
      liveSessionId: this.sessionId,
      connectionGeneration: this.connectionGeneration,
      generationId: event.generationId,
      providerNotified: event.providerNotified,
    });
    this.metrics("live.interruptions", 1, {
      model: this.model,
      source: event.providerNotified ? "provider" : "application",
    });
    this.generationId = newId("gen");
    this.assistantText = "";
    this.outputTranscript = "";
    this.outputFinalizedThisTurn = false;
    this.inputTranscript = "";
    this.inputFinalizedThisTurn = false;
    this.emitState();
  }

  private finishTurn(event: Extract<LiveSessionEventPayload, { type: "turn_complete" }>): void {
    if (!this.inputFinalizedThisTurn && this.inputTranscript.trim().length > 0) {
      // Partial transcriptions are never promoted to durable user facts.
      this.inputTranscript = "";
    }
    const assistant = this.assistantText.trim();
    if (assistant.length > 0 && !this.outputFinalizedThisTurn) {
      this.appendMessage("assistant", assistant, { live: true, modality: "text" });
    }
    this.assistantText = "";
    this.outputTranscript = "";
    this.inputFinalizedThisTurn = false;
    this.outputFinalizedThisTurn = false;
    this.activityStateValue = "listening";
    this.emit(event);
    this.emitState();
    this.generationId = newId("gen");
  }

  private toolContext() {
    return {
      runId: `live_${this.sessionId}`,
      sessionId: this.contextSessionId,
      signal: this.sessionAbort.signal,
      userInitiated: false,
      origin: "live" as const,
    };
  }

  private currentTools(): ToolDescriptor[] {
    return typeof this.deps.tools === "function" ? this.deps.tools() : this.deps.tools;
  }

  private onToolResult(record: ToolExecutionRecord, sendResponse: boolean): void {
    this.metrics("live.tool.execution_ms", record.durationMs, {
      model: this.model,
      tool: record.call.name,
    });
    this.emit({
      type: "tool_result",
      callId: record.call.id,
      name: record.call.name,
      status: record.status,
      ...(record.outcome?.summary === undefined ? {} : { summary: record.outcome.summary }),
      ...(record.error === undefined ? {} : { error: record.error }),
    });
    if (sendResponse && record.status !== "approval_required" && record.status !== "cancelled") {
      try {
        this.sendToolResponses([liveToolResponse(record)]);
      } catch (error) {
        if (isAelvoError(error) && error.code === "LIVE_QUEUE_OVERFLOW") {
          // Losing a tool response silently would leave the provider waiting
          // and desynchronize the conversation. Fail the session explicitly.
          this.failPermanent(error);
        } else {
          this.deps.logger?.warn(
            { code: isAelvoError(error) ? error.code : "LIVE_SESSION_CLOSED" },
            "Live tool response could not be queued",
          );
        }
      }
    }
    if (record.status !== "approval_required" && record.status !== "cancelled") {
      this.setActivity("model_responding", false);
    }
  }

  private handleTransportClose(code?: number, reason?: string): void {
    if (this.expectedClose || this.closing || this.disposed) return;
    const safeReason = reason === undefined ? undefined : redactText(reason);
    const details = {
      ...(code === undefined ? {} : { code }),
      ...(safeReason === undefined ? {} : { reason: safeReason }),
    };

    let error: AelvoError;
    if (code === 1008 || (safeReason !== undefined && /unauth|api key|permission|forbidden/i.test(safeReason))) {
      error = new AelvoError(
        "PROVIDER_AUTH",
        safeReason ? `Live authentication failed (${safeReason})` : "Live connection rejected authentication",
        { retryable: false, details },
      );
    } else if (code === 1007) {
      const isUnsupported =
        safeReason !== undefined &&
        /modality|modalities|not supported|thinking level|unsupported/i.test(safeReason);
      error = new AelvoError(
        isUnsupported ? "PROVIDER_MODEL_UNSUPPORTED" : "PROVIDER_INVALID_REQUEST",
        safeReason ?? "Live session rejected configuration or payload (1007)",
        { retryable: false, details },
      );
    } else {
      error = new AelvoError("PROVIDER_UNAVAILABLE", "Live connection closed unexpectedly", {
        retryable: true,
        details,
      });
    }
    this.handleTransportFailure(error);
  }

  private handleTransportFailure(error: unknown): void {
    if (this.expectedClose || this.closing || this.disposed || this.recovering) return;
    const classified = this.classify(error);
    this.teardownConnection();
    if (!this.recovery.shouldRetry(classified)) {
      this.failPermanent(classified);
      return;
    }
    this.scheduleReconnect(classified.message);
  }

  private scheduleReconnect(reason: string): void {
    if (this.recovering || this.closing || this.disposed) return;
    if (this.reconnectAttempt >= this.recovery.maxAttempts) {
      this.failPermanent(
        new AelvoError("PROVIDER_UNAVAILABLE", `Live reconnect budget exhausted: ${redactText(reason)}`, {
          retryable: false,
        }),
      );
      return;
    }
    this.recovering = true;
    this.reconnectAttempt += 1;
    const attempt = this.reconnectAttempt;
    const delayMs = this.recovery.delay(attempt);
    this.connectionStateValue = "RECONNECTING";
    this.transportStateValue = "connecting";
    this.emit({
      type: "reconnecting",
      attempt,
      delayMs,
      reason: redactText(reason),
    });
    this.emitState();
    this.metrics("live.reconnect.attempts", 1, { model: this.model, attempt: String(attempt) });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.attemptReconnect(attempt);
    }, delayMs);
  }

  private async attemptReconnect(attempt: number): Promise<void> {
    if (this.closing || this.disposed) return;
    const reconnectStartedAt = Date.now();
    // GoAway recovery starts while the old connection is still open; close and
    // fence it before establishing the replacement connection.
    if (this.connection !== undefined) this.teardownConnection();
    try {
      await this.connectOnce(true);
      this.recovering = false;
      this.metrics("live.reconnect.latency_ms", Date.now() - reconnectStartedAt, {
        model: this.model,
      });
      this.emit({ type: "reconnected", resumed: this.currentResumed });
      this.emitRuntime({
        type: "live.reconnected",
        liveSessionId: this.sessionId,
        connectionGeneration: this.connectionGeneration,
        resumed: this.currentResumed,
      });
    } catch (error) {
      if (this.closing || this.disposed) return;
      const classified = this.classify(error);
      if (
        this.currentResumed &&
        this.recovery.allowReplacementSession &&
        !this.recovery.shouldRetry(classified)
      ) {
        // A stale/expired resume handle is not a successfully resumed session.
        this.resumptionHandle = undefined;
        this.currentResumed = false;
        this.recovering = false;
        this.metrics("live.resumption.fallback", 1, { model: this.model });
        this.scheduleReconnect("Resumption was unavailable; starting a replacement session");
        return;
      }
      if (!this.recovery.shouldRetry(classified) || attempt >= this.recovery.maxAttempts) {
        this.failPermanent(classified);
        return;
      }
      this.recovering = false;
      this.scheduleReconnect(classified.message);
    }
  }

  private teardownConnection(): void {
    this.clearSetupTimer();
    this.clearConnectTimer();
    // Fence any late connect promise / callbacks from the failed connection.
    this.connectionGeneration += 1;
    this.connectionAbort?.abort(new Error("Live connection torn down"));
    this.connectionAbort = undefined;
    try {
      this.connection?.close();
    } catch {
      // Cleanup is idempotent.
    }
    this.connection = undefined;
    this.pendingServerMessages.splice(0);
    this.transportStateValue = "error";
    this.setupComplete = false;
    this.rejectSetup(new Error("Live connection is not available"));
    // Replace the rejected setup promise immediately. A pump started while
    // disconnected must wait for the replacement handshake, not observe the
    // already-resolved promise from the previous connection and drop input.
    this.setupDeferred = deferred();
  }

  private failPermanent(error: AelvoError): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closing = true;
    this.clearTimers();
    this.connectionAbort?.abort(error);
    this.connectionAbort = undefined;
    try {
      this.connection?.close();
    } catch {
      // Cleanup is idempotent.
    }
    this.connection = undefined;
    this.pendingServerMessages.splice(0);
    this.toolDispatcher.close();
    this.sessionAbort.abort(error);
    this.shutdownSignal?.removeEventListener("abort", this.onShutdownSignal);
    this.inputQueue.splice(0);
    this.rejectSetup(error);
    this.connectionStateValue = "FAILED";
    this.transportStateValue = "error";
    this.emit({ type: "error", error: toPublicError(error), fatal: true });
    this.emitRuntime({ type: "live.error", liveSessionId: this.sessionId, error: toPublicError(error) });
    this.emit({ type: "close", expected: false });
    // End with the fault so a consumer that drained already-queued events sees
    // the failure instead of mistaking a full queue for a clean close.
    this.eventQueue.end(error);
    this.metrics("live.sessions.failed", 1, { model: this.model, code: error.code });
    this.deps.onClosed?.(this);
  }

  private classify(error: unknown): AelvoError {
    if (isAelvoError(error) && error.code.startsWith("LIVE_")) return error;
    if (isAelvoError(error) && error.code.startsWith("CREDENTIAL_")) {
      return new AelvoError("PROVIDER_AUTH", "Live credential is unavailable or invalid", {
        cause: error,
        retryable: false,
      });
    }
    return classifyGoogleError(error, { model: this.model });
  }

  private isCurrent(generation: number): boolean {
    return generation === this.connectionGeneration && !this.disposed;
  }

  private setActivity(next: LiveActivityState, emitState: boolean): void {
    if (this.activityStateValue === next) return;
    this.activityStateValue = next;
    if (emitState) this.emitState();
  }

  private setConnectionState(next: LiveConnectionState): void {
    this.connectionStateValue = next;
    this.emitState();
  }

  private emitState(): void {
    this.emitRuntime({
      type: "live.session.state",
      liveSessionId: this.sessionId,
      connectionGeneration: this.connectionGeneration,
      connectionState: this.connectionStateValue,
      activityState: this.activityStateValue,
    });
  }

  private emit(payload: LiveSessionEventPayload): void {
    const event: LiveSessionEvent = {
      ...payload,
      sessionId: this.sessionId,
      connectionGeneration: this.connectionGeneration,
      at: nowIso(),
    };
    try {
      this.eventQueue.push(event);
    } catch (error) {
      if (isAelvoError(error) && error.code === "LIVE_QUEUE_OVERFLOW") {
        this.failPermanent(error);
      } else {
        throw error;
      }
    }
  }

  private emitRuntime(event: RuntimeEvent): void {
    try {
      this.deps.onRuntimeEvent?.(event);
    } catch {
      // Observability subscribers must never break the media path.
    }
  }

  private appendMessage(
    role: "user" | "assistant",
    text: string,
    metadata: Record<string, unknown>,
  ): void {
    if (this.deps.memory === undefined || text.trim().length === 0) return;
    try {
      this.deps.memory.ensureSession(this.contextSessionId, "Live conversation");
      this.deps.memory.appendMessage(this.contextSessionId, role, text, metadata);
    } catch (error) {
      this.deps.logger?.warn(
        { code: isAelvoError(error) ? error.code : "STORAGE_FAILED" },
        "Live transcript persistence failed",
      );
    }
  }

  private buildSystemInstruction(): string {
    if (this.deps.context === undefined) return "";
    try {
      this.deps.memory?.ensureSession(this.contextSessionId, "Live conversation");
      return this.deps.context.build(this.contextSessionId).system;
    } catch {
      return "";
    }
  }

  private replayContext(): void {
    const connection = this.connection;
    if (connection === undefined) return;
    const messages = this.replayInitialized ? this.buildReplayMessages() : this.initialReplay;
    this.replayInitialized = true;
    if (messages.length === 0) return;
    try {
      connection.sendClientContent({ turns: messages, turnComplete: false });
      this.metrics("live.context.replayed_messages", messages.length, { model: this.model });
    } catch (error) {
      this.deps.logger?.warn(
        { code: isAelvoError(error) ? error.code : "LIVE_PROTOCOL_INVALID" },
        "Live context replay failed",
      );
    }
  }

  private buildReplayMessages(): Content[] {
    if (this.deps.context === undefined) return [];
    try {
      this.deps.memory?.ensureSession(this.contextSessionId, "Live conversation");
      const built = this.deps.context.build(this.contextSessionId);
      return built.messages
        .slice(-40)
        .map((message) => ({
          role: message.role,
          parts: message.parts
            .filter((part) => part.kind === "text")
            .map((part) => ({ text: part.kind === "text" ? part.text : "" })),
        }))
        .filter((message) => message.parts.length > 0);
    } catch {
      return [];
    }
  }

  private buildConnectConfig(handle: string | undefined, abortSignal: AbortSignal): LiveConnectConfig {
    const responseModalities = this.config.responseModalities ?? ["AUDIO"];
    if (responseModalities.length === 0) {
      throw new AelvoError("CONFIG_INVALID", "Live responseModalities must not be empty");
    }
    const config: LiveConnectConfig = {
      abortSignal,
      responseModalities: responseModalities.map((modality) =>
        modality === "TEXT" ? Modality.TEXT : Modality.AUDIO,
      ),
    };
    if (this.systemInstruction.length > 0) {
      config.systemInstruction = { role: "user", parts: [{ text: this.systemInstruction }] };
    }
    if (this.config.temperature !== undefined) config.temperature = this.config.temperature;
    if (this.config.maxOutputTokens !== undefined) config.maxOutputTokens = this.config.maxOutputTokens;
    const tools = this.currentTools();
    if (tools.length > 0) {
      config.tools = [
        { functionDeclarations: toGeminiFunctionDeclarations(tools, this.metadata) },
      ];
    }
    if (this.config.voiceName !== undefined || this.config.outputLanguageCodes !== undefined) {
      config.speechConfig = {
        ...(this.config.outputLanguageCodes?.[0] === undefined
          ? {}
          : { languageCode: this.config.outputLanguageCodes[0] }),
        ...(this.config.voiceName === undefined
          ? {}
          : { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.config.voiceName } } }),
      };
    }
    if (this.config.inputAudioTranscription === true) {
      config.inputAudioTranscription = {
        ...(this.config.inputLanguageCodes === undefined
          ? {}
          : { languageCodes: this.config.inputLanguageCodes }),
      };
    }
    if (this.config.outputAudioTranscription === true) {
      config.outputAudioTranscription = {
        ...(this.config.outputLanguageCodes === undefined
          ? {}
          : { languageCodes: this.config.outputLanguageCodes }),
      };
    }
    if (this.config.thinking !== undefined) {
      const thinkingLevel = mapThinkingLevel(this.config.thinking.level);
      config.thinkingConfig = {
        ...(this.config.thinking.budgetTokens === undefined
          ? {}
          : { thinkingBudget: this.config.thinking.budgetTokens }),
        ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
        ...(this.config.thinking.includeThoughts === undefined
          ? {}
          : { includeThoughts: this.config.thinking.includeThoughts }),
      };
    }
    if (this.config.contextWindowCompression !== undefined) {
      const trigger = this.config.contextWindowCompression.triggerTokens;
      const target = this.config.contextWindowCompression.targetTokens;
      if (trigger !== undefined && (trigger < 5_000 || trigger > 128_000)) {
        throw new AelvoError(
          "CONFIG_INVALID",
          "Live context compression triggerTokens must be between 5,000 and 128,000",
        );
      }
      if (target !== undefined && (target < 0 || target > 128_000 || (trigger !== undefined && target >= trigger))) {
        throw new AelvoError(
          "CONFIG_INVALID",
          "Live context compression targetTokens must be below triggerTokens and within 0..128,000",
        );
      }
      config.contextWindowCompression = {
        ...(trigger === undefined ? {} : { triggerTokens: String(trigger) }),
        slidingWindow: {
          ...(target === undefined ? {} : { targetTokens: String(target) }),
        },
      };
    }
    if (this.config.sessionResumption === true) {
      config.sessionResumption = handle === undefined ? {} : { handle };
    }
    if (
      this.config.automaticActivityDetection !== undefined ||
      this.config.activityHandling !== undefined
    ) {
      config.realtimeInputConfig = {
        automaticActivityDetection: {
          disabled: this.config.automaticActivityDetection === false,
        },
        ...(this.config.activityHandling === undefined
          ? {}
          : {
              activityHandling:
                this.config.activityHandling === "no_interrupt"
                  ? ActivityHandling.NO_INTERRUPTION
                  : ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
            }),
      };
    }
    return config;
  }

  private onShutdownSignal = (): void => {
    this.close();
  };

  private clearConnectTimer(): void {
    if (this.connectTimer !== undefined) clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
  }

  private clearSetupTimer(): void {
    if (this.setupTimer !== undefined) clearTimeout(this.setupTimer);
    this.setupTimer = undefined;
  }

  private clearTimers(): void {
    this.clearConnectTimer();
    this.clearSetupTimer();
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private rejectSetup(error: Error): void {
    try {
      this.setupDeferred.reject(error);
    } catch {
      // A rejected setup promise may already have been observed.
    }
  }

  private metrics(name: string, value: number, tags: Record<string, string>): void {
    this.deps.metrics?.record(name, value, tags);
  }
}

export interface LiveSessionManagerOptions {
  model: string;
  transport: LiveTransport;
  resolveApiKey: () => Promise<string | undefined>;
  tools: ToolDescriptor[] | (() => ToolDescriptor[]);
  toolRuntime: LiveToolRuntime;
  approvals: ApprovalService;
  isEmergencyStopActive?: () => boolean;
  memory?: MemoryService;
  context?: ContextBuilder;
  metrics?: RuntimeMetrics;
  logger?: Logger;
  onRuntimeEvent?: (event: RuntimeEvent) => void;
  defaultVoiceName?: string;
}

/** Owns active Live sessions; there is one transport and one credential source. */
export class LiveSessionManager {
  private readonly options: LiveSessionManagerOptions;
  private readonly sessions = new Map<string, GoogleLiveSession>();

  constructor(options: LiveSessionManagerOptions) {
    this.options = options;
  }

  async createLiveSession(config: LiveSessionConfig = {}): Promise<LiveSessionHandle> {
    if (this.options.isEmergencyStopActive?.() === true) {
      throw new AelvoError("EMERGENCY_STOP", "Emergency stop is active; Live sessions are suspended");
    }
    if (config.voiceName === undefined && this.options.defaultVoiceName !== undefined) {
      config = { ...config, voiceName: this.options.defaultVoiceName };
    }
    if (this.sessions.size >= 8) {
      throw new AelvoError("LIVE_SESSION_STATE_INVALID", "Maximum concurrent Live sessions reached");
    }
    const session = new GoogleLiveSession(
      {
        ...this.options,
        onClosed: (closed) => {
          this.sessions.delete(closed.sessionId);
        },
      },
      config,
    );
    if (this.sessions.has(session.sessionId)) {
      throw new AelvoError("LIVE_SESSION_STATE_INVALID", `Live session ${session.sessionId} already exists`);
    }
    this.sessions.set(session.sessionId, session);
    try {
      await session.start();
    } catch (error) {
      this.sessions.delete(session.sessionId);
      throw error;
    }
    return session;
  }

  activeSessions(): Array<{ sessionId: string; model: string; state: LiveConnectionState; activity: LiveActivityState }> {
    return [...this.sessions.values()].map((session) => ({
      sessionId: session.sessionId,
      model: session.model,
      state: session.connectionState(),
      activity: session.activityState(),
    }));
  }

  /** Credential rotation/deletion closes active sessions; a caller can open a replacement. */
  invalidateAll(reason = "Provider credential changed"): void {
    const count = this.sessions.size;
    for (const session of this.sessions.values()) {
      session.close();
    }
    this.options.logger?.info({ reason, sessions: count }, "Live sessions invalidated");
    this.sessions.clear();
  }

  close(): void {
    this.invalidateAll("Application shutdown");
  }
}
