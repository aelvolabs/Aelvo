import type {
  ProviderCapabilities,
  ProviderFunctionCall,
  ProviderGateway,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
} from "../types.js";

export type ScriptedTurn =
  | { kind: "text"; text: string }
  | { kind: "calls"; text?: string; calls: Array<{ name: string; args?: Record<string, unknown> }> }
  | { kind: "error"; error: Error };

type NormalizedTurn =
  | { kind: "text"; text: string }
  | { kind: "calls"; text: string; calls: ProviderFunctionCall[] }
  | { kind: "error"; error: Error };

/**
 * Deterministic provider double for tests. It is never selected by the
 * composition root and never returns unscripted output.
 */
export class MockGateway implements ProviderGateway {
  readonly name = "mock";
  readonly model: string;
  readonly requests: ProviderRequest[] = [];
  private readonly turns: ScriptedTurn[];

  constructor(turns: ScriptedTurn[], model = "mock-model") {
    this.turns = [...turns];
    this.model = model;
  }

  capabilities(): ProviderCapabilities {
    return { streaming: true, functionCalling: true, nativeAudio: false, liveSession: false };
  }

  private next(): NormalizedTurn {
    const turn = this.turns.shift();
    if (turn === undefined) {
      throw new Error("MockGateway exhausted: the script has no more turns");
    }
    if (turn.kind === "error") return { kind: "error", error: turn.error };
    if (turn.kind === "text") return { kind: "text", text: turn.text };
    return {
      kind: "calls",
      text: turn.text ?? "",
      calls: turn.calls.map((call, index) => ({
        id: `call_${index + 1}`,
        name: call.name,
        args: call.args ?? {},
      })),
    };
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    const turn = this.next();
    const usage = { inputTokens: 10, outputTokens: 5 };
    if (turn.kind === "error") throw turn.error;
    if (turn.kind === "text") {
      return { text: turn.text, functionCalls: [], usage, finishReason: "STOP" };
    }
    return { text: turn.text, functionCalls: turn.calls, usage, finishReason: "STOP" };
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(request);
    const turn = this.next();
    const usage = { inputTokens: 10, outputTokens: 5 };
    if (turn.kind === "error") throw turn.error;
    if (turn.kind === "text") {
      yield { type: "text", text: turn.text };
      yield { type: "usage", usage };
      yield { type: "done", response: { text: turn.text, functionCalls: [], usage, finishReason: "STOP" } };
      return;
    }
    if (turn.text.length > 0) yield { type: "text", text: turn.text };
    for (const call of turn.calls) yield { type: "function_call", call };
    yield { type: "usage", usage };
    yield {
      type: "done",
      response: { text: turn.text, functionCalls: turn.calls, usage, finishReason: "STOP" },
    };
  }
}
