import type { Content, LiveServerMessage, Part } from "@google/genai";
import { newId } from "../../../../shared/ids.js";
import { AelvoError } from "../../../../shared/errors/index.js";
import type {
  LiveSessionEventPayload,
  ProviderFunctionCall,
  ProviderUsage,
} from "../../types.js";
import {
  audioFormatForOutput,
  decodeLiveAudio,
  parseDurationMs,
} from "./audio.js";

export interface ProtocolContext {
  generationId: string;
}

function protocolError(message: string, details: Record<string, unknown> = {}): AelvoError {
  return new AelvoError("LIVE_PROTOCOL_INVALID", message, { details });
}

function asFunctionCall(value: unknown): ProviderFunctionCall {
  if (value === null || typeof value !== "object") {
    throw protocolError("Live function call is not an object");
  }
  const record = value as {
    id?: unknown;
    name?: unknown;
    args?: unknown;
    thoughtSignature?: unknown;
  };
  if (typeof record.name !== "string" || record.name.trim().length === 0) {
    throw protocolError("Live function call has no name");
  }
  if (
    record.args !== undefined &&
    (record.args === null || typeof record.args !== "object" || Array.isArray(record.args))
  ) {
    throw protocolError(`Live function call ${record.name} has non-object arguments`);
  }
  const id =
    typeof record.id === "string" && record.id.length > 0
      ? record.id
      : newId("live_call");
  return {
    id,
    name: record.name,
    args: (record.args as Record<string, unknown> | undefined) ?? {},
    ...(typeof record.thoughtSignature === "string"
      ? { thoughtSignature: record.thoughtSignature }
      : {}),
  };
}

function collectContentParts(
  content: Content | undefined,
  generationId: string,
  calls: ProviderFunctionCall[],
): LiveSessionEventPayload[] {
  if (content?.parts === undefined) return [];
  const events: LiveSessionEventPayload[] = [];
  for (const part of content.parts) {
    assertSupportedOutputPart(part);
    if (typeof part.text === "string" && part.text.length > 0) {
      events.push({
        type: "text",
        text: part.text,
        generationId,
        ...(part.thought === true ? { thought: true } : {}),
      });
    }
    if (part.inlineData !== undefined) {
      const mimeType = part.inlineData.mimeType ?? "audio/pcm;rate=24000";
      if (!/^audio\//i.test(mimeType)) {
        throw protocolError(`Unsupported Live output media type "${mimeType}"`);
      }
      const format = audioFormatForOutput(mimeType);
      events.push({
        type: "audio",
        data: decodeLiveAudio(part.inlineData.data),
        mimeType: format.mimeType,
        format,
        generationId,
      });
    }
    if (part.functionCall !== undefined) {
      calls.push(
        asFunctionCall({
          ...part.functionCall,
          ...(part.thoughtSignature === undefined
            ? {}
            : { thoughtSignature: part.thoughtSignature }),
        }),
      );
    }
  }
  return events;
}

function readUsage(message: LiveServerMessage): ProviderUsage | undefined {
  const usage = message.usageMetadata;
  if (usage === undefined) return undefined;
  return {
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: usage.responseTokenCount ?? 0,
    ...(usage.totalTokenCount === undefined ? {} : { totalTokens: usage.totalTokenCount }),
    ...(usage.cachedContentTokenCount === undefined
      ? {}
      : { cachedInputTokens: usage.cachedContentTokenCount }),
    ...(usage.thoughtsTokenCount === undefined ? {} : { thoughtsTokens: usage.thoughtsTokenCount }),
    ...(usage.toolUsePromptTokenCount === undefined
      ? {}
      : { toolUsePromptTokens: usage.toolUsePromptTokenCount }),
  };
}

/**
 * Normalize every supported field independently. A Live server message can
 * contain content, tool calls, usage, GoAway and resumption fields at once, so
 * this function never uses an else-if chain that could discard a later field.
 */
export function normalizeLiveMessage(
  message: LiveServerMessage,
  context: ProtocolContext,
): LiveSessionEventPayload[] {
  const events: LiveSessionEventPayload[] = [];

  if (message.setupComplete !== undefined) {
    events.push({
      type: "setup_complete",
      ...(message.setupComplete.sessionId === undefined
        ? {}
        : { providerSessionId: message.setupComplete.sessionId }),
    });
  }

  const calls: ProviderFunctionCall[] = [];
  const content = message.serverContent;
  if (content !== undefined) {
    events.push(...collectContentParts(content.modelTurn, context.generationId, calls));

    if (content.inputTranscription !== undefined) {
      const text = content.inputTranscription.text ?? "";
      if (text.length > 0 || content.inputTranscription.finished === true) {
        events.push({
          type: "input_transcription",
          text,
          final: content.inputTranscription.finished === true,
        });
      }
    }
    if (content.outputTranscription !== undefined) {
      const text = content.outputTranscription.text ?? "";
      if (text.length > 0 || content.outputTranscription.finished === true) {
        events.push({
          type: "output_transcription",
          text,
          final: content.outputTranscription.finished === true,
        });
      }
    }
    if (content.interrupted === true) {
      events.push({ type: "interrupted", generationId: context.generationId, providerNotified: true });
    }
    if (content.generationComplete === true) {
      events.push({ type: "generation_complete", generationId: context.generationId });
    }
    if (content.turnComplete === true) {
      events.push({
        type: "turn_complete",
        generationId: context.generationId,
        ...(content.turnCompleteReason === undefined
          ? {}
          : { reason: String(content.turnCompleteReason) }),
      });
    }
  }

  for (const raw of message.toolCall?.functionCalls ?? []) {
    calls.push(asFunctionCall(raw));
  }
  if (calls.length > 0) {
    const seen = new Set<string>();
    const unique = calls.filter((call) => {
      const key = `${call.id}\0${call.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    events.push({ type: "function_call", calls: unique, generationId: context.generationId });
  }

  const cancelledIds = message.toolCallCancellation?.ids?.filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  if (cancelledIds !== undefined && cancelledIds.length > 0) {
    events.push({ type: "function_call_cancellation", ids: [...new Set(cancelledIds)] });
  }

  const usage = readUsage(message);
  if (usage !== undefined) events.push({ type: "usage", usage });

  if (message.goAway !== undefined) {
    const timeLeftMs = parseDurationMs(message.goAway.timeLeft);
    events.push({
      type: "connection_expiring",
      ...(timeLeftMs === undefined ? {} : { timeLeftMs }),
    });
  }

  if (message.sessionResumptionUpdate !== undefined) {
    events.push({
      type: "resumption_update",
      resumable: message.sessionResumptionUpdate.resumable === true,
    });
  }

  return events;
}

/** Reject a model turn part that would violate the supported Live surface. */
export function assertSupportedOutputPart(part: Part): void {
  if (part.executableCode !== undefined || part.codeExecutionResult !== undefined) {
    throw protocolError("Live returned code execution output, which this runtime does not execute");
  }
}
