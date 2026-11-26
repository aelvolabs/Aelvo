import {
  BlockedReason,
  FinishReason,
  FunctionCallingConfigMode,
  GoogleGenAI,
  ThinkingLevel,
  type Content,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type HttpOptions,
  type Model as SdkModel,
  type Part,
} from "@google/genai";
import { randomUUID } from "node:crypto";
import type { Logger } from "../../../observability/logger.js";
import type { RuntimeMetrics } from "../../../observability/metrics.js";
import { redactText } from "../../../observability/redact.js";
import { AelvoError } from "../../../shared/errors/index.js";
import {
  getCatalogModelMetadata,
  mergeRuntimeModelMetadata,
  normalizeGoogleModelId,
  toProviderCapabilities,
} from "./models.js";
import {
  ProviderRateLimiter,
  computeRetryDelayMs,
  extractRetryAfterMs,
  sleepWithAbort,
  type RateLimiterOptions,
} from "./rate-limit.js";
import {
  parseAndValidateStructuredOutput,
  sanitizeGeminiJsonSchema,
  toGeminiFunctionDeclarations,
} from "./schema.js";
import type {
  ProviderCapabilities,
  ProviderFunctionCall,
  ProviderGateway,
  ProviderMessage,
  ProviderModelMetadata,
  ProviderPart,
  ProviderProbeResult,
  ProviderRequest,
  ProviderResponse,
  ProviderSafetyRating,
  ProviderStreamEvent,
  ProviderStructuredOutputRequest,
  ProviderStructuredResult,
  ProviderUsage,
} from "../types.js";

export interface GoogleSdkClient {
  models: {
    generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse>;
    generateContentStream(
      params: GenerateContentParameters,
    ): Promise<AsyncIterable<GenerateContentResponse>>;
    get(params: {
      model: string;
      config?: { httpOptions?: HttpOptions; abortSignal?: AbortSignal };
    }): Promise<SdkModel>;
    list(params?: {
      config?: { pageSize?: number; httpOptions?: HttpOptions; abortSignal?: AbortSignal };
    }): Promise<AsyncIterable<SdkModel>>;
  };
}

export interface GoogleGatewayOptions {
  /** Static API key. Omit if providing `credentialResolver`. */
  apiKey?: string;
  /** Dynamic credential resolver consulted lazily when resolving the client. */
  credentialResolver?: () => Promise<string | undefined>;
  model: string;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  defaultTimeoutMs?: number;
  rateLimit?: RateLimiterOptions;
  metrics?: RuntimeMetrics;
  logger?: Logger;
  clientFactory?: (apiKey: string) => GoogleSdkClient;
}

const BLOCKED_FINISH_REASONS = new Set<string>([
  FinishReason.SAFETY,
  FinishReason.RECITATION,
  FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII,
  FinishReason.IMAGE_SAFETY,
  FinishReason.IMAGE_PROHIBITED_CONTENT,
]);

const INVALID_CALL_FINISH_REASONS = new Set<string>([
  FinishReason.MALFORMED_FUNCTION_CALL,
  FinishReason.UNEXPECTED_TOOL_CALL,
]);

const RETRYABLE_PROVIDER_CODES = new Set([
  "PROVIDER_RATE_LIMIT",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
]);

function readErrorStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  if (typeof record.status === "number") return record.status;
  if (typeof record.statusCode === "number") return record.statusCode;
  if (record.cause !== undefined) return readErrorStatus(record.cause);
  return undefined;
}

function readErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  if (typeof record.code === "string") return record.code;
  if (record.cause !== undefined) return readErrorCode(record.cause);
  return undefined;
}

function isAbortLike(error: unknown): boolean {
  if (error instanceof AelvoError && error.code === "PROVIDER_ABORTED") return true;
  if (error !== null && typeof error === "object") {
    const name = (error as { name?: unknown }).name;
    if (name === "AbortError") return true;
  }
  const msg = error instanceof Error ? error.message : String(error);
  return /aborted/i.test(msg);
}

/**
 * Map raw Google GenAI SDK / HTTP / transport errors into structured `AelvoError` codes
 * while redacting any sensitive substrings.
 */
export function classifyGoogleError(
  error: unknown,
  context: { model: string; timedOut?: boolean; abortedByCaller?: boolean } = { model: "" },
): AelvoError {
  if (error instanceof AelvoError) {
    return error;
  }

  const rawMessage = error instanceof Error ? error.message : String(error);
  const safeMessage = redactText(rawMessage);
  const status = readErrorStatus(error);
  const sysCode = readErrorCode(error);

  if (context.timedOut === true) {
    return new AelvoError("PROVIDER_TIMEOUT", `Google request timed out: ${safeMessage}`, {
      cause: error,
      retryable: true,
      details: { model: context.model, status },
    });
  }

  if (context.abortedByCaller === true || isAbortLike(error)) {
    return new AelvoError("PROVIDER_ABORTED", "Provider request was cancelled", {
      cause: error,
      details: { model: context.model },
    });
  }

  if (
    status === 401 ||
    status === 403 ||
    /API_KEY_INVALID|API key not valid|UNAUTHENTICATED|PERMISSION_DENIED/i.test(rawMessage)
  ) {
    return new AelvoError("PROVIDER_AUTH", "Google rejected the API credential", {
      cause: error,
      details: { model: context.model, status },
    });
  }

  if (status === 429 || /RESOURCE_EXHAUSTED|rate limit|too many requests|quota/i.test(rawMessage)) {
    const retryAfterMs = extractRetryAfterMs(error);
    const isHardQuota =
      /exceeded your current quota|plan and billing|billing account|quota.*limit:\s*0|free_tier|daily limit exceeded/i.test(
        rawMessage,
      );
    if (isHardQuota) {
      return new AelvoError("PROVIDER_QUOTA_EXCEEDED", `Google quota exceeded: ${safeMessage}`, {
        cause: error,
        retryable: false,
        details: { model: context.model, status },
      });
    }
    return new AelvoError("PROVIDER_RATE_LIMIT", "Google rate limit reached", {
      cause: error,
      retryable: true,
      details: {
        model: context.model,
        status,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      },
    });
  }

  if (
    /context length|maximum context|exceeds the maximum number of tokens|input token count.*exceeds|too many tokens/i.test(
      rawMessage,
    )
  ) {
    return new AelvoError("PROVIDER_CONTEXT_LENGTH", `Input exceeds model context limit: ${safeMessage}`, {
      cause: error,
      retryable: false,
      details: { model: context.model, status },
    });
  }

  if (/prompt was blocked|SAFETY|PROHIBITED_CONTENT|RECITATION|BLOCKLIST/i.test(rawMessage)) {
    return new AelvoError("PROVIDER_CONTENT_BLOCKED", `Google blocked content: ${safeMessage}`, {
      cause: error,
      retryable: false,
      details: { model: context.model, status },
    });
  }

  if (
    status === 404 ||
    /NOT_FOUND|not found for API version|is not supported for|does not support/i.test(rawMessage)
  ) {
    return new AelvoError("PROVIDER_MODEL_UNSUPPORTED", `Unsupported or unavailable model "${context.model}": ${safeMessage}`, {
      cause: error,
      retryable: false,
      details: { model: context.model, status },
    });
  }

  if (
    status === 408 ||
    status === 504 ||
    sysCode === "ETIMEDOUT" ||
    sysCode === "UND_ERR_CONNECT_TIMEOUT" ||
    /timed out|deadline_exceeded|timeout/i.test(rawMessage)
  ) {
    return new AelvoError("PROVIDER_TIMEOUT", `Google request timed out: ${safeMessage}`, {
      cause: error,
      retryable: true,
      details: { model: context.model, status, sysCode },
    });
  }

    if (
    status === 400 ||
    /INVALID[_ ]ARGUMENT|FAILED[_ ]PRECONDITION/i.test(rawMessage)
  ) {
    return new AelvoError("PROVIDER_INVALID_REQUEST", `Invalid Google request: ${safeMessage}`, {
      cause: error,
      retryable: false,
      details: { model: context.model, status },
    });
  }

  if (/Retryable HTTP Error/i.test(rawMessage)) {
    return new AelvoError(
      "PROVIDER_UNAVAILABLE",
      `Google provider returned a retryable error: ${safeMessage}`,
      {
        cause: error,
        retryable: true,
        details: { model: context.model, status },
      },
    );
  }

  if (
    (status !== undefined && status >= 500) ||
    sysCode === "ECONNRESET" ||
    sysCode === "ECONNREFUSED" ||
    sysCode === "ENOTFOUND" ||
    sysCode === "EAI_AGAIN" ||
    sysCode === "UND_ERR_SOCKET" ||
    /fetch failed|network error|socket hang up|service unavailable|internal error/i.test(rawMessage)
  ) {
    return new AelvoError("PROVIDER_UNAVAILABLE", `Google service unavailable: ${safeMessage}`, {
      cause: error,
      retryable: true,
      details: { model: context.model, status, sysCode },
    });
  }

  return new AelvoError("PROVIDER_RESPONSE_INVALID", safeMessage, {
    cause: error,
    details: { model: context.model, status },
  });
}

function toSdkPart(part: ProviderPart): Part {
  switch (part.kind) {
    case "text":
      return {
        text: part.text,
        ...(part.thought ? { thought: true } : {}),
      };
    case "inline_data":
      return {
        inlineData: {
          mimeType: part.mimeType,
          data: part.data,
          ...(part.displayName === undefined ? {} : { displayName: part.displayName }),
        },
      };
    case "file_data":
      return {
        fileData: {
          mimeType: part.mimeType,
          fileUri: part.fileUri,
          ...(part.displayName === undefined ? {} : { displayName: part.displayName }),
        },
      };
    case "function_call":
      return {
        functionCall: { id: part.id, name: part.name, args: part.args },
        ...(part.thoughtSignature === undefined ? {} : { thoughtSignature: part.thoughtSignature }),
      };
    case "function_response":
      return {
        functionResponse: { id: part.id, name: part.name, response: part.response },
      };
  }
}

export function toGoogleContents(messages: ProviderMessage[]): Content[] {
  return messages.map((message) => ({
    role: message.role,
    parts: message.parts.map(toSdkPart),
  }));
}

function extractUsage(usage: GenerateContentResponse["usageMetadata"]): ProviderUsage {
  if (usage === undefined) {
    return { inputTokens: 0, outputTokens: 0 };
  }
  return {
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: usage.candidatesTokenCount ?? 0,
    ...(usage.totalTokenCount === undefined ? {} : { totalTokens: usage.totalTokenCount }),
    ...(usage.cachedContentTokenCount === undefined ? {} : { cachedInputTokens: usage.cachedContentTokenCount }),
    ...(usage.thoughtsTokenCount === undefined ? {} : { thoughtsTokens: usage.thoughtsTokenCount }),
    ...(usage.toolUsePromptTokenCount === undefined ? {} : { toolUsePromptTokens: usage.toolUsePromptTokenCount }),
  };
}

function extractSafetyRatings(response: GenerateContentResponse): ProviderSafetyRating[] | undefined {
  const ratings = response.candidates?.[0]?.safetyRatings;
  if (ratings === undefined || ratings.length === 0) return undefined;
  return ratings.map((rating) => ({
    category: String(rating.category ?? "UNKNOWN"),
    probability: String(rating.probability ?? "UNKNOWN"),
    ...(rating.blocked === undefined ? {} : { blocked: rating.blocked }),
  }));
}

function assertResponseSafe(response: GenerateContentResponse, model: string): void {
  const blockReason = response.promptFeedback?.blockReason;
  if (blockReason !== undefined && blockReason !== BlockedReason.BLOCKED_REASON_UNSPECIFIED) {
    const reasonMsg = response.promptFeedback?.blockReasonMessage;
    throw new AelvoError(
      "PROVIDER_CONTENT_BLOCKED",
      `Prompt blocked by Google safety filter (${blockReason})${reasonMsg ? `: ${redactText(reasonMsg)}` : ""}`,
      { details: { model, blockReason } },
    );
  }

  const candidate = response.candidates?.[0];
  const finishReason = candidate?.finishReason;
  if (finishReason !== undefined && BLOCKED_FINISH_REASONS.has(finishReason)) {
    throw new AelvoError(
      "PROVIDER_CONTENT_BLOCKED",
      `Response stopped by Google safety/policy filter (${finishReason})`,
      { details: { model, finishReason, finishMessage: candidate?.finishMessage } },
    );
  }
  if (finishReason !== undefined && INVALID_CALL_FINISH_REASONS.has(finishReason)) {
    throw new AelvoError(
      "PROVIDER_RESPONSE_INVALID",
      `Google returned invalid tool call termination (${finishReason})`,
      { details: { model, finishReason, finishMessage: candidate?.finishMessage } },
    );
  }
}

function extractPartsFromResponse(response: GenerateContentResponse): {
  text: string;
  reasoning: string;
  calls: ProviderFunctionCall[];
} {
  const candidateParts = response.candidates?.[0]?.content?.parts;
  if (Array.isArray(candidateParts) && candidateParts.length > 0) {
    let text = "";
    let reasoning = "";
    const calls: ProviderFunctionCall[] = [];
    for (const part of candidateParts) {
      if (typeof part.text === "string" && part.text.length > 0) {
        if (part.thought === true) {
          reasoning += part.text;
        } else {
          text += part.text;
        }
      }
      if (part.functionCall !== undefined) {
        if (typeof part.functionCall.name !== "string" || part.functionCall.name.length === 0) {
          throw new AelvoError("PROVIDER_RESPONSE_INVALID", "Provider returned a function call without a name");
        }
        calls.push({
          id: part.functionCall.id ?? `call_${randomUUID()}`,
          name: part.functionCall.name,
          args: part.functionCall.args ?? {},
          ...(part.thoughtSignature === undefined ? {} : { thoughtSignature: part.thoughtSignature }),
        });
      }
    }
    return { text, reasoning, calls };
  }

  const fallbackText = response.text ?? "";
  const rawCalls = response.functionCalls ?? [];
  const calls: ProviderFunctionCall[] = rawCalls.map((call) => {
    if (typeof call.name !== "string" || call.name.length === 0) {
      throw new AelvoError("PROVIDER_RESPONSE_INVALID", "Provider returned a function call without a name");
    }
    return {
      id: call.id ?? `call_${randomUUID()}`,
      name: call.name,
      args: call.args ?? {},
    };
  });
  return { text: fallbackText, reasoning: "", calls };
}

function toThinkingLevel(level: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH"): ThinkingLevel {
  switch (level) {
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

function toFunctionCallingMode(choice: NonNullable<ProviderRequest["toolChoice"]>): FunctionCallingConfigMode {
  switch (choice) {
    case "auto":
      return FunctionCallingConfigMode.AUTO;
    case "any":
      return FunctionCallingConfigMode.ANY;
    case "none":
      return FunctionCallingConfigMode.NONE;
    case "validated":
      return FunctionCallingConfigMode.VALIDATED;
  }
}

function estimatePromptTokens(request: ProviderRequest): number {
  let chars = request.system.length;
  for (const msg of request.messages) {
    for (const part of msg.parts) {
      if (part.kind === "text") chars += part.text.length;
      else if (part.kind === "function_call") chars += JSON.stringify(part.args).length + part.name.length;
      else if (part.kind === "function_response") chars += JSON.stringify(part.response).length + part.name.length;
      else chars += 256;
    }
  }
  return Math.max(1, Math.ceil(chars / 4));
}

interface RequestAbortContext {
  signal: AbortSignal;
  timedOut: () => boolean;
  abortedByCaller: () => boolean;
  cleanup: () => void;
}

function createRequestAbortContext(callerSignal?: AbortSignal, timeoutMs?: number): RequestAbortContext {
  const controller = new AbortController();
  let timedOutFlag = false;
  let callerAbortedFlag = callerSignal?.aborted === true;

  if (callerSignal?.aborted) {
    controller.abort(callerSignal.reason);
  }

  const onCallerAbort = (): void => {
    callerAbortedFlag = true;
    controller.abort(callerSignal?.reason);
  };
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

  const timer =
    timeoutMs !== undefined && timeoutMs > 0
      ? setTimeout(() => {
          if (!controller.signal.aborted) {
            timedOutFlag = true;
            controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs)
      : undefined;

  return {
    signal: controller.signal,
    timedOut: () => timedOutFlag,
    abortedByCaller: () => callerAbortedFlag,
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

/**
 * Production Google Gemini gateway built on `@google/genai`.
 * Handles lazy/reloadable client creation, explicit capability reporting,
 * non-automatic native tool execution, structured outputs, rate limiting,
 * jittered backoff, error taxonomy mapping, and runtime telemetry.
 */
export class GoogleGateway implements ProviderGateway {
  readonly name = "google";
  readonly model: string;

  private staticApiKey: string | undefined;
  private readonly credentialResolver: (() => Promise<string | undefined>) | undefined;
  private cachedApiKey: string | undefined;
  private cachedClient: GoogleSdkClient | undefined;
  private runtimeMetadata: ProviderModelMetadata | undefined;

  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly defaultTimeoutMs: number | undefined;
  private readonly limiter: ProviderRateLimiter;
  private readonly metrics: RuntimeMetrics | undefined;
  private readonly logger: Logger | undefined;
  private readonly clientFactory: (apiKey: string) => GoogleSdkClient;

  constructor(options: GoogleGatewayOptions) {
    if (options.apiKey === undefined && options.credentialResolver === undefined) {
      throw new AelvoError("PROVIDER_NOT_CONFIGURED", "A Google API key or credential resolver is required");
    }
    if (options.apiKey !== undefined && options.apiKey.trim().length === 0) {
      throw new AelvoError("PROVIDER_NOT_CONFIGURED", "A non-empty Google API key is required");
    }

    this.staticApiKey = options.apiKey;
    this.credentialResolver = options.credentialResolver;
    this.model = options.model;
    this.maxRetries = Math.max(0, options.maxRetries ?? 2);
    this.baseDelayMs = Math.max(0, options.baseDelayMs ?? 250);
    this.maxDelayMs = Math.max(this.baseDelayMs, options.maxDelayMs ?? 8_000);
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.limiter = new ProviderRateLimiter(options.rateLimit);
    this.metrics = options.metrics;
    this.logger = options.logger;
    this.clientFactory =
      options.clientFactory ??
      ((apiKey: string) =>
        new GoogleGenAI({
          apiKey,
        }) as unknown as GoogleSdkClient);
  }

  /** Replace static API key or clear the cached SDK client after credential changes. */
  updateApiKey(apiKey: string | undefined): void {
    this.staticApiKey = apiKey !== undefined && apiKey.trim().length > 0 ? apiKey : undefined;
    if (this.cachedApiKey !== this.staticApiKey) {
      this.invalidateClient();
    }
  }

  /** Drop the cached SDK client so the next request re-resolves credentials cleanly. */
  invalidateClient(): void {
    this.cachedApiKey = undefined;
    this.cachedClient = undefined;
  }

  modelMetadata(): ProviderModelMetadata {
    return this.runtimeMetadata ?? getCatalogModelMetadata(this.model);
  }

  capabilities(): ProviderCapabilities {
    return toProviderCapabilities(this.modelMetadata());
  }

  private async resolveClient(): Promise<{ apiKey: string; client: GoogleSdkClient }> {
    const resolved = this.credentialResolver !== undefined ? await this.credentialResolver() : this.staticApiKey;
    if (resolved === undefined || resolved.trim().length === 0) {
      this.invalidateClient();
      throw new AelvoError("PROVIDER_NOT_CONFIGURED", "Google API key is not configured");
    }
    if (this.cachedClient === undefined || this.cachedApiKey !== resolved) {
      this.cachedApiKey = resolved;
      this.cachedClient = this.clientFactory(resolved);
    }
    return { apiKey: resolved, client: this.cachedClient };
  }

  private buildConfig(
    request: ProviderRequest,
    abortSignal: AbortSignal,
    timeoutMs?: number,
  ): GenerateContentConfig {
    const metadata = this.modelMetadata();
    const config: GenerateContentConfig = {
      abortSignal,
      // Explicitly disable SDK automatic function calling so EVERY tool call
      // must pass through AELVO RunCoordinator -> ToolExecutor -> PolicyService -> ApprovalService.
      automaticFunctionCalling: { disable: true },
      // Omit `retryOptions` so @google/genai runs fetch once directly without
      // wrapping errors in its pRetry wrapper (which strips HTTP bodies/status).
      ...(timeoutMs === undefined ? {} : { httpOptions: { timeout: timeoutMs } }),
    };

    if (request.system.length > 0) config.systemInstruction = request.system;
    if (request.temperature !== undefined) config.temperature = request.temperature;
    if (request.maxOutputTokens !== undefined) config.maxOutputTokens = request.maxOutputTokens;
    if (request.topP !== undefined) config.topP = request.topP;
    if (request.topK !== undefined) config.topK = request.topK;
    if (request.stopSequences !== undefined && request.stopSequences.length > 0) {
      config.stopSequences = request.stopSequences;
    }

    if (request.thinking !== undefined) {
      if (metadata.details.thinking === false) {
        throw new AelvoError(
          "PROVIDER_MODEL_UNSUPPORTED",
          `Model ${this.model} does not support thinking configuration`,
          { details: { model: this.model } },
        );
      }
      config.thinkingConfig = {
        ...(request.thinking.budgetTokens === undefined ? {} : { thinkingBudget: request.thinking.budgetTokens }),
        ...(request.thinking.level === undefined ? {} : { thinkingLevel: toThinkingLevel(request.thinking.level) }),
        ...(request.thinking.includeThoughts === undefined
          ? {}
          : { includeThoughts: request.thinking.includeThoughts }),
      };
    }

    if (request.tools.length > 0 && request.toolChoice !== "none") {
      const declarations = toGeminiFunctionDeclarations(request.tools, metadata);
      config.tools = [{ functionDeclarations: declarations }];
      if (request.toolChoice !== undefined || (request.allowedTools !== undefined && request.allowedTools.length > 0)) {
        config.toolConfig = {
          functionCallingConfig: {
            ...(request.toolChoice === undefined ? {} : { mode: toFunctionCallingMode(request.toolChoice) }),
            ...(request.allowedTools === undefined ? {} : { allowedFunctionNames: request.allowedTools }),
          },
        };
      }
    } else if (request.toolChoice === "none") {
      config.toolConfig = {
        functionCallingConfig: { mode: FunctionCallingConfigMode.NONE },
      };
    }

    if (request.structuredOutput !== undefined) {
      if (metadata.details.structuredOutput === false) {
        throw new AelvoError(
          "PROVIDER_MODEL_UNSUPPORTED",
          `Model ${this.model} does not support structured JSON outputs`,
          { details: { model: this.model } },
        );
      }
      config.responseMimeType = "application/json";
      if (request.structuredOutput.jsonSchema !== undefined) {
        config.responseJsonSchema = sanitizeGeminiJsonSchema(
          request.structuredOutput.jsonSchema,
          request.structuredOutput.schemaName ?? "structured_output",
        );
      }
    }

    return config;
  }

  private recordMetrics(operation: string, elapsedMs: number, usage?: ProviderUsage, status = "ok"): void {
    if (this.metrics === undefined) return;
    this.metrics.record("provider.requests", 1, { model: this.model, operation, status });
    this.metrics.record("provider.latency_ms", elapsedMs, { model: this.model, operation });
    if (usage !== undefined) {
      this.metrics.record("provider.tokens.input", usage.inputTokens, { model: this.model });
      this.metrics.record("provider.tokens.output", usage.outputTokens, { model: this.model });
    }
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    return this.executeGenerate(request, false);
  }

  private async executeGenerate(request: ProviderRequest, skipStructuredValidation: boolean): Promise<ProviderResponse> {
    const startMs = Date.now();
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    const contents = toGoogleContents(request.messages);
    const estimatedTokens = estimatePromptTokens(request);
    let lastError: AelvoError | undefined;
    let rotatedRetryUsed = false;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const abortCtx = createRequestAbortContext(request.signal, timeoutMs);
      try {
        const waitMs = await this.limiter.acquire(estimatedTokens, abortCtx.signal);
        if (waitMs > 0) {
          this.metrics?.record("provider.rate_limit_wait_ms", waitMs, { model: this.model });
        }

        const { client } = await this.resolveClient();
        const response = await client.models.generateContent({
          model: this.model,
          contents,
          config: this.buildConfig(request, abortCtx.signal, timeoutMs),
        });

        assertResponseSafe(response, this.model);
        const extracted = extractPartsFromResponse(response);
        const usage = extractUsage(response.usageMetadata);
        const safetyRatings = extractSafetyRatings(response);

        const parsedStructured =
          !skipStructuredValidation && request.structuredOutput !== undefined
            ? parseAndValidateStructuredOutput(extracted.text, request.structuredOutput)
            : undefined;

        const result: ProviderResponse = {
          text: extracted.text,
          functionCalls: extracted.calls,
          usage,
          ...(response.candidates?.[0]?.finishReason === undefined
            ? {}
            : { finishReason: String(response.candidates[0].finishReason) }),
          ...(extracted.reasoning.length === 0 ? {} : { reasoning: extracted.reasoning }),
          ...(response.modelVersion === undefined ? {} : { modelVersion: response.modelVersion }),
          ...(response.responseId === undefined ? {} : { responseId: response.responseId }),
          ...(safetyRatings === undefined ? {} : { safetyRatings }),
          ...(parsedStructured === undefined ? {} : { parsedStructured }),
        };

        this.recordMetrics("generate", Date.now() - startMs, usage, "ok");
        return result;
      } catch (error) {
        const classified = classifyGoogleError(error, {
          model: this.model,
          timedOut: abortCtx.timedOut(),
          abortedByCaller: abortCtx.abortedByCaller(),
        });
        lastError = classified;

        if (classified.code === "PROVIDER_ABORTED") {
          this.metrics?.record("provider.cancellations", 1, { model: this.model, operation: "generate" });
          this.recordMetrics("generate", Date.now() - startMs, undefined, classified.code);
          throw classified;
        }

        if (classified.code === "PROVIDER_AUTH" && this.credentialResolver !== undefined && !rotatedRetryUsed) {
          const previousKey = this.cachedApiKey;
          this.invalidateClient();
          const nextKey = await this.credentialResolver();
          if (nextKey !== undefined && nextKey.trim().length > 0 && nextKey !== previousKey) {
            rotatedRetryUsed = true;
            continue;
          }
        }

        if (!RETRYABLE_PROVIDER_CODES.has(classified.code) || attempt === this.maxRetries) {
          this.recordMetrics("generate", Date.now() - startMs, undefined, classified.code);
          this.logger?.warn({ code: classified.code, model: this.model, detail: classified.message }, "Gemini generate failed");
          throw classified;
        }

        const retryAfterMs =
          typeof classified.details.retryAfterMs === "number" ? classified.details.retryAfterMs : undefined;
        const delayMs = computeRetryDelayMs({
          attempt: attempt + 1,
          baseDelayMs: this.baseDelayMs,
          maxDelayMs: this.maxDelayMs,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        });
        this.metrics?.record("provider.retries", 1, { model: this.model, operation: "generate", code: classified.code });
        await sleepWithAbort(delayMs, abortCtx.signal);
      } finally {
        abortCtx.cleanup();
      }
    }

    throw lastError ?? new AelvoError("PROVIDER_UNAVAILABLE", "Google request failed");
  }

  /**
   * Generate JSON conforming to `structuredOutput` with bounded single-shot repair
   * on JSON syntax or schema mismatch. Tools are never executed during repair.
   */
  async generateStructured<T>(
    request: Omit<ProviderRequest, "structuredOutput"> & {
      structuredOutput: ProviderStructuredOutputRequest<T>;
    },
  ): Promise<ProviderStructuredResult<T>> {
    const maxRepairAttempts = Math.min(2, Math.max(0, request.structuredOutput.maxRepairAttempts ?? 1));
    let currentMessages = [...request.messages];
    let lastError: AelvoError | undefined;

    const { validate: _omitValidate, ...requestStructuredConfig } = request.structuredOutput;

    for (let attempt = 0; attempt <= maxRepairAttempts; attempt += 1) {
      const response = await this.executeGenerate(
        {
          ...request,
          messages: currentMessages,
          tools: attempt === 0 ? request.tools : [],
          structuredOutput: requestStructuredConfig,
        },
        true,
      );

      try {
        const data = parseAndValidateStructuredOutput<T>(response.text, request.structuredOutput);
        return {
          data,
          response: { ...response, parsedStructured: data },
          repaired: attempt > 0,
        };
      } catch (error) {
        const classified =
          error instanceof AelvoError
            ? error
            : new AelvoError("PROVIDER_RESPONSE_INVALID", redactText(String(error)));
        lastError = classified;
        if (attempt >= maxRepairAttempts) {
          throw classified;
        }
        currentMessages = [
          ...currentMessages,
          { role: "model", parts: [{ kind: "text", text: response.text }] },
          {
            role: "user",
            parts: [
              {
                kind: "text",
                text: `Your previous output did not satisfy the required JSON schema (${classified.message}). Reply ONLY with valid JSON matching the schema.`,
              },
            ],
          },
        ];
      }
    }

    throw lastError ?? new AelvoError("PROVIDER_RESPONSE_INVALID", "Structured output validation failed");
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const startMs = Date.now();
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    const contents = toGoogleContents(request.messages);
    const estimatedTokens = estimatePromptTokens(request);
    let lastError: AelvoError | undefined;
    let rotatedRetryUsed = false;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const abortCtx = createRequestAbortContext(request.signal, timeoutMs);
      let emittedAnyEvent = false;
      let streamIterator: AsyncIterator<GenerateContentResponse> | undefined;

      try {
        const waitMs = await this.limiter.acquire(estimatedTokens, abortCtx.signal);
        if (waitMs > 0) {
          this.metrics?.record("provider.rate_limit_wait_ms", waitMs, { model: this.model });
        }

        const { client } = await this.resolveClient();
        const sdkStream = await client.models.generateContentStream({
          model: this.model,
          contents,
          config: this.buildConfig(request, abortCtx.signal, timeoutMs),
        });

        let text = "";
        let reasoning = "";
        const calls: ProviderFunctionCall[] = [];
        let usage: ProviderUsage = { inputTokens: 0, outputTokens: 0 };
        let finishReason: string | undefined;
        let modelVersion: string | undefined;
        let responseId: string | undefined;
        let safetyRatings: ProviderSafetyRating[] | undefined;
        let sawAnyCandidate = false;
        let recordedTtfb = false;

        streamIterator = sdkStream[Symbol.asyncIterator]();
        while (true) {
          if (abortCtx.signal.aborted) {
            throw new AelvoError("PROVIDER_ABORTED", "Provider stream was cancelled");
          }

          const step = await streamIterator.next();
          if (step.done) break;
          const chunk = step.value;

          if (!recordedTtfb) {
            recordedTtfb = true;
            this.metrics?.record("provider.stream.ttfb_ms", Date.now() - startMs, { model: this.model });
          }

          assertResponseSafe(chunk, this.model);
          if (chunk.candidates !== undefined && chunk.candidates.length > 0) {
            sawAnyCandidate = true;
          }

          const extracted = extractPartsFromResponse(chunk);
          if (extracted.reasoning.length > 0) {
            reasoning += extracted.reasoning;
            emittedAnyEvent = true;
            yield { type: "reasoning", text: extracted.reasoning };
          }
          if (extracted.text.length > 0) {
            text += extracted.text;
            emittedAnyEvent = true;
            yield { type: "text", text: extracted.text };
          }
          for (const call of extracted.calls) {
            calls.push(call);
            emittedAnyEvent = true;
            yield { type: "function_call", call };
          }

          if (chunk.usageMetadata !== undefined) {
            usage = extractUsage(chunk.usageMetadata);
            emittedAnyEvent = true;
            yield { type: "usage", usage };
          }

          const reason = chunk.candidates?.[0]?.finishReason;
          if (reason !== undefined) finishReason = String(reason);
          if (chunk.modelVersion !== undefined) modelVersion = chunk.modelVersion;
          if (chunk.responseId !== undefined) responseId = chunk.responseId;
          const chunkSafety = extractSafetyRatings(chunk);
          if (chunkSafety !== undefined) safetyRatings = chunkSafety;
        }

        if (abortCtx.signal.aborted) {
          throw abortCtx.timedOut()
            ? new AelvoError("PROVIDER_TIMEOUT", "Google stream timed out", { retryable: true })
            : new AelvoError("PROVIDER_ABORTED", "Provider stream was cancelled");
        }

        if (!sawAnyCandidate && text.length === 0 && calls.length === 0 && finishReason === undefined) {
          throw new AelvoError("PROVIDER_RESPONSE_INVALID", "Provider stream closed without any response candidate");
        }

        const parsedStructured =
          request.structuredOutput !== undefined
            ? parseAndValidateStructuredOutput(text, request.structuredOutput)
            : undefined;

        this.recordMetrics("stream", Date.now() - startMs, usage, "ok");
        yield {
          type: "done",
          response: {
            text,
            functionCalls: calls,
            usage,
            ...(finishReason === undefined ? {} : { finishReason }),
            ...(reasoning.length === 0 ? {} : { reasoning }),
            ...(modelVersion === undefined ? {} : { modelVersion }),
            ...(responseId === undefined ? {} : { responseId }),
            ...(safetyRatings === undefined ? {} : { safetyRatings }),
            ...(parsedStructured === undefined ? {} : { parsedStructured }),
          },
        };
        return;
      } catch (error) {
        const classified = classifyGoogleError(error, {
          model: this.model,
          timedOut: abortCtx.timedOut(),
          abortedByCaller: abortCtx.abortedByCaller(),
        });
        lastError = classified;

        if (classified.code === "PROVIDER_ABORTED") {
          this.metrics?.record("provider.cancellations", 1, { model: this.model, operation: "stream" });
          this.recordMetrics("stream", Date.now() - startMs, undefined, classified.code);
          throw classified;
        }

        // Never retry mid-stream after emitting chunks to the caller.
        if (emittedAnyEvent) {
          this.recordMetrics("stream", Date.now() - startMs, undefined, classified.code);
          throw classified;
        }

        if (classified.code === "PROVIDER_AUTH" && this.credentialResolver !== undefined && !rotatedRetryUsed) {
          const previousKey = this.cachedApiKey;
          this.invalidateClient();
          const nextKey = await this.credentialResolver();
          if (nextKey !== undefined && nextKey.trim().length > 0 && nextKey !== previousKey) {
            rotatedRetryUsed = true;
            continue;
          }
        }

        if (!RETRYABLE_PROVIDER_CODES.has(classified.code) || attempt === this.maxRetries) {
          this.recordMetrics("stream", Date.now() - startMs, undefined, classified.code);
          this.logger?.warn({ code: classified.code, model: this.model, detail: classified.message }, "Gemini stream failed");
          throw classified;
        }

        const retryAfterMs =
          typeof classified.details.retryAfterMs === "number" ? classified.details.retryAfterMs : undefined;
        const delayMs = computeRetryDelayMs({
          attempt: attempt + 1,
          baseDelayMs: this.baseDelayMs,
          maxDelayMs: this.maxDelayMs,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        });
        this.metrics?.record("provider.retries", 1, { model: this.model, operation: "stream", code: classified.code });
        await sleepWithAbort(delayMs, abortCtx.signal);
      } finally {
        if (streamIterator?.return !== undefined) {
          try {
            await streamIterator.return();
          } catch {
            // Stream cleanup failures must not mask primary errors.
          }
        }
        abortCtx.cleanup();
      }
    }

    throw lastError ?? new AelvoError("PROVIDER_UNAVAILABLE", "Google stream failed");
  }

  /** Fetch runtime metadata for `modelId` (defaults to `this.model`). */
  async getModelInfo(modelId = this.model, signal?: AbortSignal): Promise<ProviderModelMetadata> {
    const normalized = normalizeGoogleModelId(modelId);
    const { client } = await this.resolveClient();
    const abortCtx = createRequestAbortContext(signal, this.defaultTimeoutMs);
    try {
      const sdkModel = await client.models.get({
        model: normalized,
        config: {
          abortSignal: abortCtx.signal,
        },
      });
      const merged = mergeRuntimeModelMetadata(normalized, sdkModel, getCatalogModelMetadata(normalized));
      if (normalized === normalizeGoogleModelId(this.model)) {
        this.runtimeMetadata = merged;
      }
      return merged;
    } catch (error) {
      throw classifyGoogleError(error, {
        model: normalized,
        timedOut: abortCtx.timedOut(),
        abortedByCaller: abortCtx.abortedByCaller(),
      });
    } finally {
      abortCtx.cleanup();
    }
  }

  /** Discover available Gemini models via `models.list` up to `limit` items. */
  async listModels(limit = 50, signal?: AbortSignal): Promise<ProviderModelMetadata[]> {
    const { client } = await this.resolveClient();
    const abortCtx = createRequestAbortContext(signal, this.defaultTimeoutMs);
    const results: ProviderModelMetadata[] = [];
    try {
      const pager = await client.models.list({
        config: {
          pageSize: limit,
          abortSignal: abortCtx.signal,
        },
      });
      for await (const sdkModel of pager) {
        const modelName = normalizeGoogleModelId(sdkModel.name ?? "unknown");
        results.push(mergeRuntimeModelMetadata(modelName, sdkModel, getCatalogModelMetadata(modelName)));
        if (results.length >= limit) break;
      }
      return results;
    } catch (error) {
      throw classifyGoogleError(error, {
        model: this.model,
        timedOut: abortCtx.timedOut(),
        abortedByCaller: abortCtx.abortedByCaller(),
      });
    } finally {
      abortCtx.cleanup();
    }
  }

  async probe(signal?: AbortSignal): Promise<ProviderProbeResult> {
    try {
      const metadata = await this.getModelInfo(this.model, signal);
      const capabilities = toProviderCapabilities(metadata);
      return {
        ok: true,
        model: metadata.model,
        detail: `${metadata.displayName ?? metadata.model} (${metadata.supportedActions?.join(", ") || "model accessible"})`,
        capabilities,
        metadata,
      };
    } catch (error) {
      const safe =
        error instanceof AelvoError ? error : classifyGoogleError(error, { model: this.model });
      return {
        ok: false,
        model: this.model,
        detail: safe.message,
        capabilities: this.capabilities(),
      };
    }
  }
}
