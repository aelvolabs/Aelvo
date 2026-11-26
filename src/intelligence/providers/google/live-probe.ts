import { GoogleGenAI, Modality, type LiveConnectParameters, type Session } from "@google/genai";
import { redactText } from "../../../observability/redact.js";
import { AelvoError } from "../../../shared/errors/index.js";
import { getCatalogModelMetadata } from "./models.js";

export interface LiveProbeResult {
  /** "verified" only when a live server turn actually produced a model reply. */
  status: "verified" | "unverified" | "failed";
  model: string;
  detail: string;
  text?: string;
}

export interface LiveClientLike {
  live: {
    connect(params: LiveConnectParameters): Promise<Pick<Session, "sendClientContent" | "close">>;
  };
}

/**
 * Optional network smoke probe. Deliberately isolated from the standard turn
 * runtime and from the persistent LiveSessionManager; it verifies that a real
 * Live connection can produce a model turn without claiming runtime coverage.
 */
export async function probeLiveSession(options: {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  clientFactory?: (apiKey: string) => LiveClientLike;
}): Promise<LiveProbeResult> {
  assertLiveProbeConfigured(options.apiKey, options.model);

  const catalog = getCatalogModelMetadata(options.model);
  if (catalog.details.liveSession === false) {
    return {
      status: "failed",
      model: options.model,
      detail: `Model ${options.model} does not advertise Gemini Live session support`,
    };
  }

  const timeoutMs = options.timeoutMs ?? 20_000;
  const ai: LiveClientLike = options.clientFactory
    ? options.clientFactory(options.apiKey)
    : (new GoogleGenAI({ apiKey: options.apiKey }) as unknown as LiveClientLike);

  return new Promise<LiveProbeResult>((resolve) => {
    let settled = false;
    let session: { close: () => void } | undefined;
    const finish = (result: LiveProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        session?.close();
      } catch {
        // Closing a half-open session must not change the probe result.
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ status: "unverified", model: options.model, detail: `No live reply within ${timeoutMs}ms` });
    }, timeoutMs);

    void ai.live
      .connect({
        model: options.model,
        // Native-audio Live models only support AUDIO output. Use the output
        // transcription as the textual verification signal instead of asking
        // for an unsupported TEXT modality.
        config: {
          responseModalities: [Modality.AUDIO],
          outputAudioTranscription: {},
        },
        callbacks: {
          onmessage: (message) => {
            const parts = message.serverContent?.modelTurn?.parts ?? [];
            const transcript = message.serverContent?.outputTranscription?.text ?? "";
            const text = `${parts.map((part) => part.text ?? "").join("")}${transcript}`.trim();
            if (text.length > 0) {
              finish({ status: "verified", model: options.model, detail: "Live session returned a model turn", text });
            }
          },
          onerror: (event) => {
            finish({
              status: "failed",
              model: options.model,
              detail: `Live session error: ${redactText(event.message)}`,
            });
          },
          onclose: (event) => {
            finish({
              status: "unverified",
              model: options.model,
              detail: `Live session closed before replying (${redactText(event.reason || "no reason")})`,
            });
          },
        },
      })
      .then((connected) => {
        session = connected;
        connected.sendClientContent({ turns: "Reply with exactly: live-ok", turnComplete: true });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        finish({
          status: "failed",
          model: options.model,
          detail: redactText(message),
        });
      });
  });
}

export function assertLiveProbeConfigured(apiKey: string | undefined, model: string | undefined): void {
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new AelvoError("PROVIDER_NOT_CONFIGURED", "Live probe requires a Google API key");
  }
  if (model === undefined || model.trim().length === 0) {
    throw new AelvoError("CONFIG_MISSING", "Live probe requires AELVO_LIVE_MODEL or AELVO_MODEL");
  }
}
