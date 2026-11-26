import type { Model as SdkModel } from "@google/genai";
import type {
  CapabilitySource,
  ProviderCapabilities,
  ProviderCapabilityDetails,
  ProviderModelMetadata,
} from "../types.js";

const UNKNOWN_DETAILS: ProviderCapabilityDetails = {
  streaming: "unknown",
  functionCalling: "unknown",
  structuredOutput: "unknown",
  multimodalInput: "unknown",
  nativeAudio: "unknown",
  liveSession: "unknown",
  thinking: "unknown",
};

interface CatalogEntry {
  displayName: string;
  inputTokenLimit: number;
  outputTokenLimit: number;
  details: ProviderCapabilityDetails;
}

/**
 * Curated capability profiles for verified Google Gemini model families.
 * Models outside this map remain explicitly `unknown` until discovered via
 * `models.get` / `models.list` rather than having booleans fabricated.
 */
const CATALOG_RULES: Array<{ match: (normalized: string) => boolean; entry: CatalogEntry }> = [
  {
    match: (m) => m.includes("native-audio") || m.includes("extended-thinking"),
    entry: {
      displayName: "Gemini Live Audio Thinking Model",
      inputTokenLimit: 131_072,
      outputTokenLimit: 65_536,
      details: {
        streaming: true,
        functionCalling: true,
        structuredOutput: false,
        multimodalInput: true,
        nativeAudio: true,
        liveSession: true,
        thinking: true,
      },
    },
  },
  {
    match: (m) => m.startsWith("gemini-live-") || m.includes("-live"),
    entry: {
      displayName: "Gemini Live Model",
      inputTokenLimit: 131_072,
      outputTokenLimit: 65_536,
      details: {
        streaming: true,
        functionCalling: true,
        structuredOutput: false,
        multimodalInput: true,
        nativeAudio: true,
        liveSession: true,
        thinking: "unknown",
      },
    },
  },
  {
    match: (m) => /^gemini-4([.-]|$)/.test(m),
    entry: {
      displayName: "Gemini 4",
      inputTokenLimit: 1_048_576,
      outputTokenLimit: 65_536,
      details: {
        streaming: true,
        functionCalling: true,
        structuredOutput: true,
        multimodalInput: true,
        nativeAudio: false,
        liveSession: false,
        thinking: true,
      },
    },
  },
  {
    match: (m) => m.includes("embedding"),
    entry: {
      displayName: "Gemini Embedding Model",
      inputTokenLimit: 2_048,
      outputTokenLimit: 0,
      details: {
        streaming: false,
        functionCalling: false,
        structuredOutput: false,
        multimodalInput: false,
        nativeAudio: false,
        liveSession: false,
        thinking: false,
      },
    },
  },
  {
    match: (m) => /^gemini-3([.-]|$)/.test(m),
    entry: {
      displayName: "Gemini 3",
      inputTokenLimit: 1_048_576,
      outputTokenLimit: 65_536,
      details: {
        streaming: true,
        functionCalling: true,
        structuredOutput: true,
        multimodalInput: true,
        nativeAudio: false,
        liveSession: false,
        thinking: true,
      },
    },
  },
  {
    match: (m) => /^gemini-2\.5-(pro|flash|flash-lite)/.test(m),
    entry: {
      displayName: "Gemini 2.5",
      inputTokenLimit: 1_048_576,
      outputTokenLimit: 65_536,
      details: {
        streaming: true,
        functionCalling: true,
        structuredOutput: true,
        multimodalInput: true,
        nativeAudio: false,
        liveSession: false,
        thinking: true,
      },
    },
  },
  {
    match: (m) => m.startsWith("gemini-2.0-flash-thinking"),
    entry: {
      displayName: "Gemini 2.0 Flash Thinking",
      inputTokenLimit: 1_048_576,
      outputTokenLimit: 8_192,
      details: {
        streaming: true,
        functionCalling: false,
        structuredOutput: false,
        multimodalInput: true,
        nativeAudio: false,
        liveSession: false,
        thinking: true,
      },
    },
  },
  {
    match: (m) => /^gemini-2\.0-(flash|flash-lite|pro)/.test(m),
    entry: {
      displayName: "Gemini 2.0",
      inputTokenLimit: 1_048_576,
      outputTokenLimit: 8_192,
      details: {
        streaming: true,
        functionCalling: true,
        structuredOutput: true,
        multimodalInput: true,
        nativeAudio: false,
        liveSession: false,
        thinking: false,
      },
    },
  },
  {
    match: (m) => /^gemini-1\.5-(pro|flash)/.test(m),
    entry: {
      displayName: "Gemini 1.5",
      inputTokenLimit: 1_048_576,
      outputTokenLimit: 8_192,
      details: {
        streaming: true,
        functionCalling: true,
        structuredOutput: true,
        multimodalInput: true,
        nativeAudio: false,
        liveSession: false,
        thinking: false,
      },
    },
  },
];

export function normalizeGoogleModelId(model: string): string {
  const trimmed = model.trim();
  if (trimmed.startsWith("models/")) {
    return trimmed.slice("models/".length);
  }
  return trimmed;
}

export function getCatalogModelMetadata(model: string): ProviderModelMetadata {
  const normalized = normalizeGoogleModelId(model);
  const matched = CATALOG_RULES.find((rule) => rule.match(normalized));
  if (matched === undefined) {
    return {
      model: normalized,
      source: "unknown",
      knownModel: false,
      details: { ...UNKNOWN_DETAILS },
    };
  }
  return {
    model: normalized,
    displayName: matched.entry.displayName,
    inputTokenLimit: matched.entry.inputTokenLimit,
    outputTokenLimit: matched.entry.outputTokenLimit,
    source: "catalog",
    knownModel: true,
    details: { ...matched.entry.details },
  };
}

export function mergeRuntimeModelMetadata(
  modelId: string,
  sdkModel: SdkModel,
  base?: ProviderModelMetadata,
): ProviderModelMetadata {
  const normalized = normalizeGoogleModelId(sdkModel.name ?? modelId);
  const initial = base ?? getCatalogModelMetadata(normalized);
  const actions = sdkModel.supportedActions ?? [];

  const details: ProviderCapabilityDetails = { ...initial.details };
  if (actions.length > 0) {
    const supportsGenerate =
      actions.includes("generateContent") || actions.includes("streamGenerateContent");
    if (supportsGenerate) {
      details.streaming = true;
    } else if (actions.includes("embedContent")) {
      details.streaming = false;
      details.functionCalling = false;
      details.structuredOutput = false;
    }
    if (actions.includes("bidiGenerateContent")) {
      details.liveSession = true;
      details.streaming = true;
    }
  }
  if (sdkModel.thinking !== undefined) {
    details.thinking = sdkModel.thinking;
  }

  const source: CapabilitySource =
    initial.source === "catalog" || initial.source === "catalog+runtime"
      ? "catalog+runtime"
      : "runtime";

  return {
    model: normalized,
    ...(sdkModel.displayName === undefined
      ? initial.displayName === undefined
        ? {}
        : { displayName: initial.displayName }
      : { displayName: sdkModel.displayName }),
    ...(sdkModel.description === undefined ? {} : { description: sdkModel.description }),
    ...(sdkModel.version === undefined ? {} : { version: sdkModel.version }),
    ...(sdkModel.inputTokenLimit === undefined
      ? initial.inputTokenLimit === undefined
        ? {}
        : { inputTokenLimit: initial.inputTokenLimit }
      : { inputTokenLimit: sdkModel.inputTokenLimit }),
    ...(sdkModel.outputTokenLimit === undefined
      ? initial.outputTokenLimit === undefined
        ? {}
        : { outputTokenLimit: initial.outputTokenLimit }
      : { outputTokenLimit: sdkModel.outputTokenLimit }),
    ...(actions.length === 0 ? {} : { supportedActions: [...actions] }),
    source,
    knownModel: true,
    details,
  };
}

export function toProviderCapabilities(metadata: ProviderModelMetadata): ProviderCapabilities {
  return {
    streaming: metadata.details.streaming === true,
    functionCalling: metadata.details.functionCalling === true,
    nativeAudio: metadata.details.nativeAudio === true,
    liveSession: metadata.details.liveSession === true,
    structuredOutput: metadata.details.structuredOutput,
    multimodalInput: metadata.details.multimodalInput,
    thinking: metadata.details.thinking,
    ...(metadata.inputTokenLimit === undefined ? {} : { inputTokenLimit: metadata.inputTokenLimit }),
    ...(metadata.outputTokenLimit === undefined ? {} : { outputTokenLimit: metadata.outputTokenLimit }),
    knownModel: metadata.knownModel,
    source: metadata.source,
    details: { ...metadata.details },
  };
}
