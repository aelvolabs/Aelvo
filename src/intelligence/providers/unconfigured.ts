import { AelvoError } from "../../shared/errors/index.js";
import type {
  ProviderCapabilities,
  ProviderGateway,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
} from "./types.js";

/**
 * Explicit "no provider configured" gateway.
 *
 * It exists so an unconfigured installation fails loudly and honestly instead
 * of silently using a mock, a cached answer or a hard-coded model.
 */
export class UnconfiguredGateway implements ProviderGateway {
  readonly name = "unconfigured";
  readonly model = "";

  capabilities(): ProviderCapabilities {
    return {
      streaming: false,
      functionCalling: false,
      nativeAudio: false,
      liveSession: false,
      structuredOutput: false,
      multimodalInput: false,
      thinking: false,
      knownModel: false,
      source: "unknown",
    };
  }

  private unavailable(): AelvoError {
    return new AelvoError(
      "PROVIDER_NOT_CONFIGURED",
      "No model provider is configured. Set AELVO_MODEL and GEMINI_API_KEY (or GOOGLE_API_KEY).",
    );
  }

  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    throw this.unavailable();
  }

  async *stream(_request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    throw this.unavailable();
  }
}
