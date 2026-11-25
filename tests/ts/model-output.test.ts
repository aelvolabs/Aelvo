import { describe, expect, it } from "vitest";
import { parseModelOutput } from "../../src/intelligence/parsing/model-output.js";

describe("model output parser", () => {
  it("parses a fenced JSON tool call", () => {
    const result = parseModelOutput('```json\n{"tool":"fs.read","args":{"path":"README.md"}}\n```');
    expect(result).toEqual({
      kind: "tool_calls",
      calls: [{ name: "fs.read", args: { path: "README.md" } }],
    });
  });

  it("parses batched calls and accepts arguments aliases", () => {
    const result = parseModelOutput('[{"name":"fs.list","arguments":{"path":"."}},{"tool":"fs.read","parameters":{"path":"a.txt"}}]');
    expect(result).toEqual({
      kind: "tool_calls",
      calls: [
        { name: "fs.list", args: { path: "." } },
        { name: "fs.read", args: { path: "a.txt" } },
      ],
    });
  });

  it("extracts JSON from surrounding prose and tolerates raw control characters", () => {
    const result = parseModelOutput('I will inspect it: {"tool":"fs.read","args":{"path":"a.txt","note":"line one\nline two"}} done');
    expect(result.kind).toBe("tool_calls");
    if (result.kind === "tool_calls") {
      expect(result.calls[0]?.name).toBe("fs.read");
      expect(result.calls[0]?.args.note).toBe("line one\nline two");
    }
  });

  it("preserves kernel-command output as a non-executable typed result", () => {
    expect(parseModelOutput("# help")).toEqual({ kind: "kernel_command", commands: ["# help"] });
  });

  it("returns ordinary prose unchanged when no call is present", () => {
    expect(parseModelOutput("The workspace is healthy.")).toEqual({
      kind: "unknown",
      text: "The workspace is healthy.",
    });
  });

  it("does not treat arbitrary objects as tool calls", () => {
    expect(parseModelOutput('{"path":"README.md"}')).toEqual({
      kind: "unknown",
      text: '{"path":"README.md"}',
    });
  });
});
