import { AelvoError } from "../../../../shared/errors/index.js";
import type { LiveAudioFormat } from "../../types.js";

/** Official Live API input format: raw little-endian 16-bit PCM at 16 kHz. */
export const LIVE_INPUT_AUDIO_MIME = "audio/pcm;rate=16000";
/** Official Live API output format: raw little-endian 16-bit PCM at 24 kHz. */
export const LIVE_OUTPUT_AUDIO_MIME = "audio/pcm;rate=24000";
export const LIVE_INPUT_SAMPLE_RATE = 16_000;
export const LIVE_OUTPUT_SAMPLE_RATE = 24_000;
export const LIVE_AUDIO_CHANNELS = 1;
export const LIVE_AUDIO_BITS_PER_SAMPLE = 16 as const;
/** Bounds accidental multi-second or malformed frames without limiting normal 20-100 ms chunks. */
export const LIVE_MAX_AUDIO_CHUNK_BYTES = 320_000;

const PCM_MIME = /^audio\/pcm(?:;\s*rate=(\d{4,6}))?$/i;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export interface ParsedAudioMime {
  sampleRate: number;
  channels: number;
  mimeType: string;
}

function invalid(message: string, details: Record<string, unknown> = {}): AelvoError {
  return new AelvoError("LIVE_PROTOCOL_INVALID", message, { details });
}

/**
 * Parse the PCM MIME form used by Gemini Live. The service can resample input,
 * but the bytes must still be raw 16-bit PCM; arbitrary compressed formats are
 * rejected rather than silently relabelled.
 */
export function parsePcmMime(
  mimeType: string | undefined,
  fallbackSampleRate = LIVE_INPUT_SAMPLE_RATE,
): ParsedAudioMime {
  if (mimeType === undefined || mimeType.trim().length === 0) {
    return {
      sampleRate: fallbackSampleRate,
      channels: LIVE_AUDIO_CHANNELS,
      mimeType: `audio/pcm;rate=${fallbackSampleRate}`,
    };
  }
  const normalized = mimeType.trim();
  const match = PCM_MIME.exec(normalized);
  if (match === null) {
    throw invalid(`Unsupported Live audio MIME type "${normalized}"; expected audio/pcm;rate=<hz>`);
  }
  const sampleRate = match[1] === undefined ? fallbackSampleRate : Number(match[1]);
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 96_000) {
    throw invalid(`Unsupported Live audio sample rate ${String(sampleRate)}`);
  }
  return { sampleRate, channels: LIVE_AUDIO_CHANNELS, mimeType: `audio/pcm;rate=${sampleRate}` };
}

export function audioFormatForInput(mimeType?: string): LiveAudioFormat {
  const parsed = parsePcmMime(mimeType, LIVE_INPUT_SAMPLE_RATE);
  return {
    mimeType: parsed.mimeType,
    sampleRate: parsed.sampleRate,
    channels: parsed.channels,
    bitsPerSample: LIVE_AUDIO_BITS_PER_SAMPLE,
  };
}

export function audioFormatForOutput(mimeType?: string): LiveAudioFormat {
  const parsed = parsePcmMime(mimeType, LIVE_OUTPUT_SAMPLE_RATE);
  return {
    mimeType: parsed.mimeType,
    sampleRate: parsed.sampleRate,
    channels: parsed.channels,
    bitsPerSample: LIVE_AUDIO_BITS_PER_SAMPLE,
  };
}

/** Validate a raw PCM frame before queueing. Byte length must describe whole samples. */
export function validatePcmChunk(data: Uint8Array, label = "Live audio chunk"): void {
  if (data.byteLength === 0) {
    throw invalid(`${label} is empty`);
  }
  if (data.byteLength % 2 !== 0) {
    throw invalid(`${label} is not whole 16-bit PCM samples`, { bytes: data.byteLength });
  }
  if (data.byteLength > LIVE_MAX_AUDIO_CHUNK_BYTES) {
    throw invalid(`${label} exceeds the bounded maximum of ${LIVE_MAX_AUDIO_CHUNK_BYTES} bytes`, {
      bytes: data.byteLength,
    });
  }
}

function decodeBase64Strict(data: string): Buffer {
  const compact = data.replace(/\s+/g, "");
  if (compact.length === 0 || !BASE64.test(compact) || compact.length % 4 !== 0) {
    throw invalid("Live audio payload is not valid base64");
  }
  const decoded = Buffer.from(compact, "base64");
  // Some malformed strings still decode under Node's lenient decoder; compare
  // length and canonical form instead of trusting it blindly.
  if (decoded.length === 0 || decoded.toString("base64") !== compact) {
    throw invalid("Live audio payload is not canonical base64");
  }
  return decoded;
}

/** Decode provider audio only at the protocol edge. */
export function decodeLiveAudio(data: string | undefined): Buffer {
  if (data === undefined) throw invalid("Live audio event has no data");
  return decodeBase64Strict(data);
}

/** Encode raw PCM only at the SDK edge, without retaining a base64 copy. */
export function encodeLiveAudio(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64");
}

/** Parse a Google protobuf duration such as "9.5s" for GoAway notices. */
export function parseDurationMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^(-?\d+(?:\.\d+)?)s$/.exec(value.trim());
  if (match?.[1] === undefined) return undefined;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1_000);
}
