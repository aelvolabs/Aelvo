import type { ToolDescriptor } from "../../tools/registry/types.js";

export type ProviderPart =
  | { kind: "text"; text: string }
  | { kind: "function_call"; id: string; name: string; args: Record<string, unknown> }
  | { kind: "function_response"; id: string; name: string; response: Record<string, unknown> };

export interface ProviderMessage {
  role: "user" | "model";
  parts: ProviderPart[];
}

export interface ProviderRequest {
  system: string;
  messages: ProviderMessage[];
  tools: ToolDescriptor[];
  signal?: AbortSignal;
  temperature?: number;
}

export interface ProviderFunctionCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderResponse {
  text: string;
  functionCalls: ProviderFunctionCall[];
  usage: ProviderUsage;
  /** Provider-reported finish reason, passed through verbatim. */
  finishReason?: string;
}

export type ProviderStreamEvent =
  | { type: "text"; text: string }
  | { type: "function_call"; call: ProviderFunctionCall }
  | { type: "usage"; usage: ProviderUsage }
  | { type: "done"; response: ProviderResponse };

export interface ProviderCapabilities {
  streaming: boolean;
  functionCalling: boolean;
  nativeAudio: boolean;
  liveSession: boolean;
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
}
