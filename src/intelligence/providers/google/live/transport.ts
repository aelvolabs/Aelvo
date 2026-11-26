import {
  GoogleGenAI,
  type LiveConnectConfig,
  type LiveConnectParameters,
  type LiveSendClientContentParameters,
  type LiveSendRealtimeInputParameters,
  type LiveSendToolResponseParameters,
  type LiveServerMessage,
  type Session,
} from "@google/genai";
import { redactText } from "../../../../observability/redact.js";
import { AelvoError } from "../../../../shared/errors/index.js";

export interface LiveTransportCallbacks {
  onOpen?: () => void;
  onMessage: (message: LiveServerMessage) => void;
  onError: (error: Error) => void;
  onClose?: (code?: number, reason?: string) => void;
}

export interface LiveTransportConnectRequest {
  model: string;
  apiKey: string;
  config: LiveConnectConfig;
  callbacks: LiveTransportCallbacks;
}

export interface LiveTransportConnection {
  sendClientContent(params: LiveSendClientContentParameters): void;
  sendRealtimeInput(params: LiveSendRealtimeInputParameters): void;
  sendToolResponse(params: LiveSendToolResponseParameters): void;
  close(): void;
}

/** Injectable boundary; production uses the official Google GenAI SDK only. */
export interface LiveTransport {
  connect(request: LiveTransportConnectRequest): Promise<LiveTransportConnection>;
}

export interface GoogleLiveSdkClient {
  live: {
    connect(
      params: LiveConnectParameters,
    ): Promise<
      Pick<
        Session,
        "sendClientContent" | "sendRealtimeInput" | "sendToolResponse" | "close"
      >
    >;
  };
}

export interface GoogleLiveTransportOptions {
  /** Injectable only in tests; production constructs the official SDK client. */
  clientFactory?: (apiKey: string) => GoogleLiveSdkClient;
}

function normalizeError(event: { error?: unknown; message?: string }): Error {
  if (event.error instanceof Error) return event.error;
  const raw = event.message ?? (event.error === undefined ? "Live transport error" : String(event.error));
  return new AelvoError("PROVIDER_UNAVAILABLE", redactText(raw), { retryable: true });
}

/**
 * Thin official-SDK adapter. It deliberately contains no session state,
 * reconnection policy, tool execution or queueing; those belong to the Live
 * runtime and can therefore be tested deterministically without a network.
 */
export class GoogleLiveTransport implements LiveTransport {
  private readonly clientFactory: (apiKey: string) => GoogleLiveSdkClient;

  constructor(options: GoogleLiveTransportOptions = {}) {
    this.clientFactory =
      options.clientFactory ??
      ((apiKey: string) =>
        new GoogleGenAI({
          apiKey,
        }) as unknown as GoogleLiveSdkClient);
  }

  async connect(request: LiveTransportConnectRequest): Promise<LiveTransportConnection> {
    if (request.apiKey.trim().length === 0) {
      throw new AelvoError("PROVIDER_NOT_CONFIGURED", "Google Live requires an API key");
    }
    const client = this.clientFactory(request.apiKey);
    let session: Awaited<ReturnType<GoogleLiveSdkClient["live"]["connect"]>>;
    try {
      session = await client.live.connect({
        model: request.model,
        config: request.config,
        callbacks: {
          onopen: () => request.callbacks.onOpen?.(),
          onmessage: (message) => request.callbacks.onMessage(message),
          onerror: (event) => request.callbacks.onError(normalizeError(event)),
          onclose: (event) => request.callbacks.onClose?.(event.code, event.reason),
        },
      });
    } catch (error) {
      // preserve the original for classifyGoogleError; no secret is added.
      throw error;
    }

    let closed = false;
    return {
      sendClientContent: (params) => {
        if (closed) throw new AelvoError("LIVE_SESSION_CLOSED", "Live connection is closed");
        session.sendClientContent(params);
      },
      sendRealtimeInput: (params) => {
        if (closed) throw new AelvoError("LIVE_SESSION_CLOSED", "Live connection is closed");
        session.sendRealtimeInput(params);
      },
      sendToolResponse: (params) => {
        if (closed) throw new AelvoError("LIVE_SESSION_CLOSED", "Live connection is closed");
        session.sendToolResponse(params);
      },
      close: () => {
        if (closed) return;
        closed = true;
        session.close();
      },
    };
  }
}
