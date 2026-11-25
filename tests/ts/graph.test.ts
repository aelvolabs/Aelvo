import { describe, expect, it } from "vitest";
import {
  EdgeCondition,
  ExecutionGraph,
  GraphExecutionEngine,
  NodeDefinition,
  OutputContract,
  RetryPolicy,
  type GraphRunner,
} from "../../src/runtime/execution/graph.js";

function node(id: string, options: { dependsOn?: string[]; retry?: RetryPolicy; contract?: OutputContract } = {}): NodeDefinition {
  return new NodeDefinition({
    id,
    ...(options.retry === undefined ? {} : { retryPolicy: options.retry }),
    ...(options.contract === undefined ? {} : { outputContract: options.contract }),
  });
}

function graphWith(nodes: NodeDefinition[], edges: Array<[string, string]>): ExecutionGraph {
  const graph = new ExecutionGraph("g_test", "test graph");
  for (const item of nodes) graph.addNode(item);
  for (const [source, target] of edges) graph.connect(source, target);
  return graph;
}

const success: GraphRunner = {
  async runNode() {
    return { status: "success", output: { value: 1 } };
  },
};

describe("execution graph", () => {
  it("orders dependencies and rejects cycles instead of reporting a partial plan", () => {
    const graph = graphWith([node("a"), node("b"), node("c")], [
      ["a", "b"],
      ["b", "c"],
    ]);
    expect(graph.topologicalSort()).toEqual(["a", "b", "c"]);

    const cyclic = graphWith([node("x"), node("y")], [
      ["x", "y"],
      ["y", "x"],
    ]);
    expect(() => cyclic.topologicalSort()).toThrowError(/cycle/);
  });

  it("executes independent ready nodes as one parallel wave", async () => {
    const graph = graphWith([node("a"), node("b"), node("c")], []);
    let active = 0;
    let maxActive = 0;
    const runner: GraphRunner = {
      async runNode() {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return { output: { value: true } };
      },
    };
    const result = await new GraphExecutionEngine(graph, runner).execute();
    expect(result.status).toBe("completed");
    expect(maxActive).toBeGreaterThanOrEqual(2);
    expect(result.completed).toHaveLength(3);
  });

  it("blocks dependents of a failed node and never reports them completed", async () => {
    const graph = graphWith([node("a"), node("b")], [["a", "b"]]);
    const runner: GraphRunner = {
      async runNode() {
        throw new Error("permanent failure");
      },
    };
    const result = await new GraphExecutionEngine(graph, runner).execute();
    expect(result.status).toBe("failed");
    expect(result.completed).toHaveLength(0);
    expect(result.failed).toContain("a");
    expect(result.blocked).toContain("b");
    expect(graph.requireNode("b").state).toBe("blocked");
  });

  it("retries a transient failure according to the node retry policy", async () => {
    const graph = graphWith(
      [node("a", { retry: new RetryPolicy({ maxRetries: 2, baseDelayMs: 1 }) })],
      [],
    );
    let calls = 0;
    const flaky: GraphRunner = {
      async runNode() {
        calls += 1;
        if (calls === 1) throw new Error("temporary timeout while calling service");
        return { output: { value: "ok" } };
      },
    };
    const result = await new GraphExecutionEngine(graph, flaky).execute();
    expect(result.status).toBe("completed");
    expect(calls).toBe(2);
    expect(graph.requireNode("a").retryCount).toBe(1);
  });

  it("does not retry a non-transient failure", async () => {
    const graph = graphWith(
      [node("a", { retry: new RetryPolicy({ maxRetries: 3, baseDelayMs: 1 }) })],
      [],
    );
    let calls = 0;
    const runner: GraphRunner = {
      async runNode() {
        calls += 1;
        throw new Error("validation rejected the payload");
      },
    };
    const result = await new GraphExecutionEngine(graph, runner).execute();
    expect(result.status).toBe("failed");
    expect(calls).toBe(1);
  });

  it("enforces output contracts before marking a node complete", async () => {
    const graph = graphWith(
      [node("a", { contract: new OutputContract({ requiredFields: ["path"] }) })],
      [],
    );
    const runner: GraphRunner = {
      async runNode() {
        return { output: { value: "no path" } };
      },
    };
    const result = await new GraphExecutionEngine(graph, runner).execute();
    expect(result.status).toBe("failed");
    expect(graph.requireNode("a").error).toMatch(/Missing required field/);
  });

  it("round-trips graph structure, conditions and transformers through JSON", () => {
    const graph = graphWith([node("a"), node("b")], []);
    graph.connect(
      "a",
      "b",
      new EdgeCondition({ conditionType: "field_comparison", fieldPath: "count", operator: ">", value: 2 }),
    );
    const restored = ExecutionGraph.deserialize(JSON.parse(JSON.stringify(graph.snapshot())));
    expect(restored.topologicalSort()).toEqual(["a", "b"]);
    const edge = restored.allEdges()[0];
    expect(edge?.condition.evaluate({ count: 3 })).toBe(true);
    expect(edge?.condition.evaluate({ count: 1 })).toBe(false);
  });
});
