import { GoogleGenAI } from "@google/genai";
import { randomUUID } from "node:crypto";
import { AelvoError } from "../../../shared/errors/index.js";
import type { ToolDescriptor } from "../../../tools/registry/types.js";
import type {
  ProviderCapabilities,
  ProviderFunctionCall,
  ProviderGateway,
  ProviderMessage,
  ProviderProbeResult,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  ProviderUsage,
} from "../types.js";

export interface GoogleGatewayOptions {
  apiKey: string;
  model: string;
  /** Retries apply only before any output has been emitted. */
  maxAttempts?: number;
  client?: GoogleGenAI;
}

interface GoogleErrorLike {
  name?: string;
  status?: number;
  code?: number | string;
  message?: string;
}

function classify(error: unknown): AelvoError {
  const candidate = error as GoogleErrorLike;
  const status = typeof candidate?.status === "number" ? candidate.status : Number(candidate?.code);
  const message = candidate?.message ?? String(error);
  if (status === 401 || status === 403) {
    return new AelvoError("PROVIDER_AUTH", "Google rejected the API credential", { cause: error });
  }
  if (status === 429) {
    return new AelvoError("PROVIDER_RATE_LIMIT", "Google rate limit reached", { cause: error, retryable: true });
  }
  if (status >= 500) {
    return new AelvoError("PROVIDER_UNAVAILABLE", "Google service unavailable", { cause: error, retryable: true });
  }
  if (candidate?.name === "AbortError" || message.includes("aborted")) {
    return new AelvoError("PROVIDER_ABORTED", "Provider request was cancelled", { cause: error });
  }
  return new AelvoError("PROVIDER_RESPONSE_INVALID", message, { cause: error });
}

function usageOf(metadata: { promptTokenCount?: number; candidatesTokenCount?: number } | undefined): ProviderUsage {
  return {
    inputTokens: metadata?.promptTokenCount ?? 0,
    outputTokens: metadata?.candidatesTokenCount ?? 0,
  };
}

function toContents(messages: ProviderMessage[]) {
  return messages.map((message) => ({
    role: message.role,
    parts: message.parts.map((part) => {
      if (part.kind === "text") return { text: part.text };
      if (part.kind === "function_call") {
        return { functionCall: { id: part.id, name: part.name, args: part.args } };
      }
      return { functionResponse: { id: part.id, name: part.name, response: part.response } };
    }),
  }));
}

function toFunctionDeclarations(tools: ToolDescriptor[]) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.parameters,
  }));
}

/**
 * Google-first provider gateway built on the official @google/genai SDK.
 * The model identifier is supplied by configuration; nothing here assumes a
 * model name, quota or capability that has not been verified at runtime.
 */
export class GoogleGateway implements ProviderGateway {
  readonly name = "google";
  readonly model: string;
  private readonly client: GoogleGenAI;
  private readonly maxAttempts: number;

  constructor(options: GoogleGatewayOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new AelvoError("PROVIDER_NOT_CONFIGURED", "A Google API key is required");
    }
    if (options.model.trim().length === 0) {
      throw new AelvoError("CONFIG_MISSING", "AELVO_MODEL must name a Google model");
    }
    this.model = options.model;
    this.client = options.client ?? new GoogleGenAI({ apiKey: options.apiKey });
    this.maxAttempts = options.maxAttempts ?? 3;
  }

  capabilities(): ProviderCapabilities {
    // Declared, not probed: see probe() for the runtime check.
    return { streaming: true, functionCalling: true, nativeAudio: false, liveSession: false };
  }

  private buildConfig(request: ProviderRequest) {
    return {
      systemInstruction: request.system,
      ...(request.tools.length === 0
        ? {}
        : { tools: [{ functionDeclarations: toFunctionDeclarations(request.tools) }] }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.signal === undefined ? {} : { abortSignal: request.signal }),
    };
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    let lastError: AelvoError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await this.client.models.generateContent({
          model: this.model,
          contents: toContents(request.messages),
          config: this.buildConfig(request),
        });
        const calls = (response.functionCalls ?? []).map((call) => this.normalizeCall(call));
        return {
          text: response.text ?? "",
          functionCalls: calls,
          usage: usageOf(response.usageMetadata),
          ...(response.candidates?.[0]?.finishReason === undefined
            ? {}
            : { finishReason: String(response.candidates[0].finishReason) }),
        };
      } catch (error) {
        lastError = classify(error);
        if (!lastError.retryable || attempt === this.maxAttempts) throw lastError;
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
      }
    }
    throw lastError ?? new AelvoError("PROVIDER_UNAVAILABLE", "Google request failed");
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    let emitted = false;
    let lastError: AelvoError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const stream = await this.client.models.generateContentStream({
          model: this.model,
          contents: toContents(request.messages),
          config: this.buildConfig(request),
        });
        let text = "";
        const calls: ProviderFunctionCall[] = [];
        let usage: ProviderUsage = { inputTokens: 0, outputTokens: 0 };
        let finishReason: string | undefined;
        for await (const chunk of stream) {
          const chunkText = chunk.text ?? "";
          if (chunkText.length > 0) {
            emitted = true;
            text += chunkText;
            yield { type: "text", text: chunkText };
          }
          for (const call of chunk.functionCalls ?? []) {
            emitted = true;
            const normalized = this.normalizeCall(call);
            calls.push(normalized);
            yield { type: "function_call", call: normalized };
          }
          if (chunk.usageMetadata !== undefined) {
            usage = usageOf(chunk.usageMetadata);
            yield { type: "usage", usage };
          }
          const reason = chunk.candidates?.[0]?.finishReason;
          if (reason !== undefined) finishReason = String(reason);
        }
        yield {
          type: "done",
          response: {
            text,
            functionCalls: calls,
            usage,
            ...(finishReason === undefined ? {} : { finishReason }),
          },
        };
        return;
      } catch (error) {
        lastError = classify(error);
        if (emitted || !lastError.retryable || attempt === this.maxAttempts) throw lastError;
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
      }
    }
    throw lastError ?? new AelvoError("PROVIDER_UNAVAILABLE", "Google stream failed");
  }

  private normalizeCall(call: { id?: string; name?: string; args?: Record<string, unknown> }): ProviderFunctionCall {
    if (call.name === undefined || call.name.length === 0) {
      throw new AelvoError("PROVIDER_RESPONSE_INVALID", "Provider returned a function call without a name");
    }
    return {
      id: call.id ?? `call_${randomUUID()}`,
      name: call.name,
      args: call.args ?? {},
    };
  }

  /** Runtime capability/availability probe against the configured model. */
  async probe(): Promise<ProviderProbeResult> {
    try {
      const model = await this.client.models.get({ model: this.model });
      return {
        ok: true,
        model: this.model,
        detail: `model reachable (${model.displayName ?? "unnamed"})`,
        capabilities: this.capabilities(),
      };
    } catch (error) {
      const classified = classify(error);
      return { ok: false, model: this.model, detail: `${classified.code}: ${classified.message}`, capabilities: this.capabilities() };
    }
  }
}
