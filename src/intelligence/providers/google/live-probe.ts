import { GoogleGenAI, Modality } from "@google/genai";
import { AelvoError } from "../../../shared/errors/index.js";

export interface LiveProbeResult {
  /** "verified" only when a live server turn actually produced a model reply. */
  status: "verified" | "unverified" | "failed";
  model: string;
  detail: string;
  text?: string;
}

/**
 * Optional live-session probe. This is deliberately isolated from the chat
 * runtime: a Live API claim is only made when this probe returns "verified".
 * Without a working key or a Live-capable model the result is "unverified".
 */
export async function probeLiveSession(options: {
  apiKey: string;
  model: string;
  timeoutMs?: number;
}): Promise<LiveProbeResult> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const ai = new GoogleGenAI({ apiKey: options.apiKey });
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
        config: { responseModalities: [Modality.TEXT] },
        callbacks: {
          onmessage: (message) => {
            const parts = message.serverContent?.modelTurn?.parts ?? [];
            const text = parts.map((part) => part.text ?? "").join("").trim();
            if (text.length > 0) {
              finish({ status: "verified", model: options.model, detail: "Live session returned a model turn", text });
            }
          },
          onerror: (event) => {
            finish({
              status: "failed",
              model: options.model,
              detail: `Live session error: ${event.message}`,
            });
          },
          onclose: (event) => {
            finish({
              status: "unverified",
              model: options.model,
              detail: `Live session closed before replying (${event.reason || "no reason"})`,
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
          detail: message,
        });
      });
  });
}

export function assertLiveProbeConfigured(apiKey: string | undefined, model: string | undefined): void {
  if (apiKey === undefined) {
    throw new AelvoError("PROVIDER_NOT_CONFIGURED", "Live probe requires a Google API key");
  }
  if (model === undefined) {
    throw new AelvoError("CONFIG_MISSING", "Live probe requires AELVO_MODEL");
  }
}
