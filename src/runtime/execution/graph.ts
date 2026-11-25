import { z } from "zod";
import { AelvoError } from "../../shared/errors/index.js";

/**
 * General-purpose execution graph ported from runtime_next/models and
 * runtime_next/engine. The coding-specific node types and specialist concepts
 * are removed; dependency ordering, conditional edges, retry policy, output
 * contracts, lifecycle history, parallel waves and serialization are retained.
 */

export const NodeTypeSchema = z.enum([
  "memory_query",
  "tool_call",
  "verification",
  "decision",
  "synthesis",
]);
export type NodeType = z.infer<typeof NodeTypeSchema>;

export const CriticalitySchema = z.enum(["critical", "important", "optional"]);
export type Criticality = z.infer<typeof CriticalitySchema>;

export const NodeStateSchema = z.enum([
  "pending",
  "ready",
  "running",
  "completed",
  "failed",
  "skipped",
  "blocked",
  "retrying",
]);
export type NodeState = z.infer<typeof NodeStateSchema>;

export const DangerSchema = z.enum(["safe", "reversible", "destructive"]);
export type Danger = z.infer<typeof DangerSchema>;

export const RetryDelayStrategySchema = z.enum(["fixed", "linear", "exponential"]);
export type RetryDelayStrategy = z.infer<typeof RetryDelayStrategySchema>;

export interface RetryPolicyOptions {
  maxRetries?: number;
  delayStrategy?: RetryDelayStrategy;
  baseDelayMs?: number;
  retryableFailureTypes?: string[];
}

/** Port of runtime_next.models.plan.RetryPolicy. */
export class RetryPolicy {
  readonly maxRetries: number;
  readonly delayStrategy: RetryDelayStrategy;
  readonly baseDelayMs: number;
  readonly retryableFailureTypes: string[];

  constructor(options: RetryPolicyOptions = {}) {
    this.maxRetries = options.maxRetries ?? 2;
    this.delayStrategy = options.delayStrategy ?? "exponential";
    this.baseDelayMs = options.baseDelayMs ?? 1_000;
    this.retryableFailureTypes = options.retryableFailureTypes ?? [
      "timeout",
      "rate_limit",
      "rate limit",
      "lock_contention",
      "temporarily unavailable",
      "econnreset",
    ];
  }

  computeDelayMs(attempt: number): number {
    if (this.delayStrategy === "fixed") return this.baseDelayMs;
    if (this.delayStrategy === "linear") return this.baseDelayMs * (attempt + 1);
    return Math.min(60_000, this.baseDelayMs * 2 ** attempt);
  }

  isRetryable(failureReason: string): boolean {
    const normalized = failureReason.toLowerCase().replaceAll(" ", "_");
    return this.retryableFailureTypes.some((type) => {
      const candidate = type.toLowerCase();
      return normalized.includes(candidate) || normalized.includes(candidate.replaceAll(" ", "_"));
    });
  }

  toJSON(): { maxRetries: number; delayStrategy: RetryDelayStrategy; baseDelayMs: number; retryableFailureTypes: string[] } {
    return {
      maxRetries: this.maxRetries,
      delayStrategy: this.delayStrategy,
      baseDelayMs: this.baseDelayMs,
      retryableFailureTypes: this.retryableFailureTypes,
    };
  }
}

export interface OutputContractOptions {
  fields?: Record<string, string>;
  requiredFields?: string[];
}

/** Port of runtime_next.models.plan.OutputContract. */
export class OutputContract {
  readonly fields: Record<string, string>;
  readonly requiredFields: string[];

  constructor(options: OutputContractOptions = {}) {
    this.fields = options.fields ?? {};
    this.requiredFields = options.requiredFields ?? [];
  }

  validate(output: Record<string, unknown>): { ok: boolean; detail: string } {
    for (const field of this.requiredFields) {
      if (!(field in output)) return { ok: false, detail: `Missing required field: ${field}` };
      if (output[field] === null || output[field] === undefined) {
        return { ok: false, detail: `Required field ${field} is null` };
      }
    }
    return { ok: true, detail: "" };
  }

  toJSON(): { fields: Record<string, string>; requiredFields: string[] } {
    return { fields: this.fields, requiredFields: this.requiredFields };
  }
}

export function resolveFieldPath(data: unknown, path: string): unknown {
  let current: unknown = data;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function compare(left: unknown, operator: string, right: unknown): boolean {
  switch (operator) {
    case "==":
      return left === right;
    case "!=":
      return left !== right;
    case ">":
    case "<":
    case ">=":
    case "<=": {
      const a = Number(left);
      const b = Number(right);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      if (operator === ">") return a > b;
      if (operator === "<") return a < b;
      if (operator === ">=") return a >= b;
      return a <= b;
    }
    case "in":
      return Array.isArray(right) ? right.includes(left) : typeof right === "string" && right.includes(String(left));
    case "contains":
      return Array.isArray(left) ? left.includes(right) : typeof left === "string" && left.includes(String(right));
    default:
      return false;
  }
}

export interface EdgeConditionOptions {
  conditionType?: "unconditional" | "output_matches" | "field_comparison" | "status_is";
  fieldPath?: string;
  operator?: string;
  value?: unknown;
}

/** Port of runtime_next.models.plan.EdgeCondition. */
export class EdgeCondition {
  readonly conditionType: NonNullable<EdgeConditionOptions["conditionType"]>;
  readonly fieldPath: string;
  readonly operator: string;
  readonly value: unknown;

  constructor(options: EdgeConditionOptions = {}) {
    this.conditionType = options.conditionType ?? "unconditional";
    this.fieldPath = options.fieldPath ?? "";
    this.operator = options.operator ?? "";
    this.value = options.value;
  }

  evaluate(nodeOutput: Record<string, unknown> | undefined): boolean {
    if (this.conditionType === "unconditional") return true;
    if (this.conditionType === "status_is") return nodeOutput?.status === this.value;
    const value = resolveFieldPath(nodeOutput, this.fieldPath);
    if (this.conditionType === "field_comparison") return compare(value, this.operator, this.value);
    return value === this.value;
  }

  toJSON(): { conditionType: NonNullable<EdgeConditionOptions["conditionType"]>; fieldPath: string; operator: string; value: unknown } {
    return {
      conditionType: this.conditionType,
      fieldPath: this.fieldPath,
      operator: this.operator,
      value: this.value,
    };
  }
}

/** Port of runtime_next.models.plan.DataTransformer. */
export class DataTransformer {
  readonly mappings: Record<string, string>;

  constructor(mappings: Record<string, string> = {}) {
    this.mappings = mappings;
  }

  apply(sourceOutput: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [target, sourcePath] of Object.entries(this.mappings)) {
      result[target] = resolveFieldPath(sourceOutput, sourcePath);
    }
    return result;
  }

  toJSON(): Record<string, string> {
    return this.mappings;
  }
}

export interface NodeInit {
  id: string;
  description?: string;
  nodeType?: NodeType;
  criticality?: Criticality;
  toolName?: string;
  args?: Record<string, unknown>;
  retryPolicy?: RetryPolicy;
  retryBudget?: number;
  outputContract?: OutputContract;
  danger?: Danger;
}

export interface NodeHistoryEntry {
  from: NodeState;
  to: NodeState;
  at: string;
  reason: string;
}

/** Port of runtime_next.models.node.NodeDefinition (coding-only fields removed). */
export class NodeDefinition {
  readonly id: string;
  description: string;
  readonly nodeType: NodeType;
  readonly criticality: Criticality;
  toolName: string;
  args: Record<string, unknown>;
  state: NodeState = "pending";
  result: unknown = null;
  error: string | null = null;
  readonly retryPolicy: RetryPolicy;
  retryBudget: number;
  retryCount = 0;
  readonly outputContract: OutputContract;
  readonly danger: Danger;
  readonly history: NodeHistoryEntry[] = [];
  startedAt: string | null = null;
  endedAt: string | null = null;

  constructor(init: NodeInit) {
    if (init.id.trim().length === 0) throw new AelvoError("TASK_INVALID", "Node id is required");
    this.id = init.id;
    this.description = init.description ?? "";
    this.nodeType = init.nodeType ?? "tool_call";
    this.criticality = init.criticality ?? "important";
    this.toolName = init.toolName ?? "";
    this.args = init.args ?? {};
    this.retryPolicy = init.retryPolicy ?? new RetryPolicy();
    this.retryBudget = init.retryBudget ?? this.retryPolicy.maxRetries + 1;
    this.outputContract = init.outputContract ?? new OutputContract();
    this.danger = init.danger ?? "safe";
  }

  transition(to: NodeState, reason = ""): void {
    if (this.state === to && reason.length === 0) return;
    this.history.push({ from: this.state, to, at: new Date().toISOString(), reason });
    this.state = to;
    if (to === "running" && this.startedAt === null) this.startedAt = new Date().toISOString();
    if (to === "completed" || to === "failed" || to === "skipped" || to === "blocked") {
      this.endedAt = new Date().toISOString();
    }
  }

  canRetry(): boolean {
    return this.retryCount < this.retryBudget;
  }

  nextBackoffMs(): number {
    return this.retryPolicy.computeDelayMs(this.retryCount);
  }

  toSnapshot(): NodeSnapshot {
    return {
      id: this.id,
      description: this.description,
      nodeType: this.nodeType,
      criticality: this.criticality,
      toolName: this.toolName,
      args: this.args,
      state: this.state,
      result: this.result,
      error: this.error,
      retryPolicy: this.retryPolicy.toJSON(),
      retryBudget: this.retryBudget,
      retryCount: this.retryCount,
      outputContract: this.outputContract.toJSON(),
      danger: this.danger,
      history: this.history,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
    };
  }

  static fromSnapshot(snapshot: NodeSnapshot): NodeDefinition {
    const node = new NodeDefinition({
      id: snapshot.id,
      description: snapshot.description,
      nodeType: snapshot.nodeType,
      criticality: snapshot.criticality,
      toolName: snapshot.toolName,
      args: snapshot.args,
      retryPolicy: new RetryPolicy(snapshot.retryPolicy),
      retryBudget: snapshot.retryBudget,
      outputContract: new OutputContract(snapshot.outputContract),
      danger: snapshot.danger,
    });
    node.state = snapshot.state;
    node.result = snapshot.result;
    node.error = snapshot.error;
    node.retryCount = snapshot.retryCount;
    node.history.push(...snapshot.history);
    node.startedAt = snapshot.startedAt;
    node.endedAt = snapshot.endedAt;
    return node;
  }
}

export interface EdgeInit {
  id?: string;
  source: string;
  target: string;
  condition?: EdgeCondition;
  transformer?: DataTransformer;
}

/** Port of runtime_next.models.plan.ExecutionEdge. */
export class GraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly condition: EdgeCondition;
  readonly transformer: DataTransformer;

  constructor(init: EdgeInit) {
    this.id = init.id ?? `${init.source}->${init.target}`;
    this.source = init.source;
    this.target = init.target;
    this.condition = init.condition ?? new EdgeCondition();
    this.transformer = init.transformer ?? new DataTransformer();
  }

  toSnapshot(): EdgeSnapshot {
    return {
      id: this.id,
      source: this.source,
      target: this.target,
      condition: this.condition.toJSON(),
      transformer: this.transformer.toJSON(),
    };
  }

  static fromSnapshot(snapshot: EdgeSnapshot): GraphEdge {
    return new GraphEdge({
      id: snapshot.id,
      source: snapshot.source,
      target: snapshot.target,
      condition: new EdgeCondition(snapshot.condition),
      transformer: new DataTransformer(snapshot.transformer),
    });
  }
}

const NodeSnapshotSchema = z.object({
  id: z.string().min(1),
  description: z.string(),
  nodeType: NodeTypeSchema,
  criticality: CriticalitySchema,
  toolName: z.string(),
  args: z.record(z.string(), z.unknown()),
  state: NodeStateSchema,
  result: z.unknown(),
  error: z.string().nullable(),
  retryPolicy: z.object({
    maxRetries: z.number().int().min(0),
    delayStrategy: RetryDelayStrategySchema,
    baseDelayMs: z.number().min(0),
    retryableFailureTypes: z.array(z.string()),
  }),
  retryBudget: z.number().int().min(0),
  retryCount: z.number().int().min(0),
  outputContract: z.object({
    fields: z.record(z.string(), z.string()),
    requiredFields: z.array(z.string()),
  }),
  danger: DangerSchema,
  history: z.array(
    z.object({
      from: NodeStateSchema,
      to: NodeStateSchema,
      at: z.string(),
      reason: z.string(),
    }),
  ),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
});
export type NodeSnapshot = z.infer<typeof NodeSnapshotSchema>;

const EdgeSnapshotSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  condition: z.object({
    conditionType: z.enum(["unconditional", "output_matches", "field_comparison", "status_is"]),
    fieldPath: z.string(),
    operator: z.string(),
    value: z.unknown(),
  }),
  transformer: z.record(z.string(), z.string()),
});
export type EdgeSnapshot = z.infer<typeof EdgeSnapshotSchema>;

const GraphSnapshotSchema = z.object({
  id: z.string().min(1),
  taskDescription: z.string(),
  totalBudget: z.number().int().min(0),
  nodes: z.array(NodeSnapshotSchema),
  edges: z.array(EdgeSnapshotSchema),
});
export type GraphSnapshot = z.infer<typeof GraphSnapshotSchema>;

/**
 * Dependency graph ported from runtime_next.engine.ExecutionGraph.
 * Cycle handling is corrected: a cycle is rejected instead of silently
 * appending the unsorted remainder and later reporting unexecuted nodes as
 * complete.
 */
export class ExecutionGraph {
  readonly id: string;
  taskDescription: string;
  totalBudget: number;
  private readonly nodes = new Map<string, NodeDefinition>();
  private readonly edges: GraphEdge[] = [];

  constructor(id: string, taskDescription = "", totalBudget = 30) {
    if (id.trim().length === 0) throw new AelvoError("TASK_INVALID", "Graph id is required");
    this.id = id;
    this.taskDescription = taskDescription;
    this.totalBudget = totalBudget;
  }

  addNode(node: NodeDefinition): void {
    if (this.nodes.has(node.id)) {
      throw new AelvoError("TASK_INVALID", `Duplicate graph node: ${node.id}`);
    }
    this.nodes.set(node.id, node);
  }

  getNode(id: string): NodeDefinition | undefined {
    return this.nodes.get(id);
  }

  requireNode(id: string): NodeDefinition {
    const node = this.nodes.get(id);
    if (node === undefined) throw new AelvoError("TASK_NOT_FOUND", `Unknown graph node: ${id}`);
    return node;
  }

  allNodes(): NodeDefinition[] {
    return [...this.nodes.values()];
  }

  allEdges(): readonly GraphEdge[] {
    return this.edges;
  }

  connect(source: string, target: string, condition?: EdgeCondition, transformer?: DataTransformer): GraphEdge {
    this.requireNode(source);
    this.requireNode(target);
    const edge = new GraphEdge({
      source,
      target,
      ...(condition === undefined ? {} : { condition }),
      ...(transformer === undefined ? {} : { transformer }),
    });
    this.edges.push(edge);
    return edge;
  }

  addEdge(edge: GraphEdge): void {
    this.requireNode(edge.source);
    this.requireNode(edge.target);
    this.edges.push(edge);
  }

  removeNode(id: string): void {
    this.nodes.delete(id);
    for (let index = this.edges.length - 1; index >= 0; index -= 1) {
      const edge = this.edges[index];
      if (edge !== undefined && (edge.source === id || edge.target === id)) this.edges.splice(index, 1);
    }
  }

  outgoing(id: string): GraphEdge[] {
    return this.edges.filter((edge) => edge.source === id);
  }

  incoming(id: string): GraphEdge[] {
    return this.edges.filter((edge) => edge.target === id);
  }

  dependencyIds(id: string): string[] {
    return this.incoming(id).map((edge) => edge.source);
  }

  dependentIds(id: string): string[] {
    return this.outgoing(id).map((edge) => edge.target);
  }

  /** Kahn topological order; rejects cycles rather than reporting a partial plan. */
  topologicalSort(): string[] {
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();
    for (const id of this.nodes.keys()) {
      inDegree.set(id, 0);
      adjacency.set(id, []);
    }
    for (const edge of this.edges) {
      adjacency.get(edge.source)?.push(edge.target);
      inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
    }
    const queue = [...inDegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
    const sorted: string[] = [];
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined) break;
      sorted.push(id);
      for (const dependent of adjacency.get(id) ?? []) {
        const next = (inDegree.get(dependent) ?? 0) - 1;
        inDegree.set(dependent, next);
        if (next === 0) queue.push(dependent);
      }
    }
    if (sorted.length !== this.nodes.size) {
      throw new AelvoError("TASK_DEPENDENCY_CYCLE", "Execution graph contains a cycle");
    }
    return sorted;
  }

  getReadyNodes(completedIds: ReadonlySet<string>): string[] {
    return [...this.nodes.values()]
      .filter((node) => node.state === "pending")
      .filter((node) => this.dependencyIds(node.id).every((dependency) => completedIds.has(dependency)))
      .map((node) => node.id);
  }

  calculateCriticalPath(): string[] {
    const sorted = this.topologicalSort();
    const longest = new Map<string, string[]>();
    for (const id of sorted) {
      const dependencies = this.dependencyIds(id);
      if (dependencies.length === 0) {
        longest.set(id, [id]);
        continue;
      }
      let best: string[] = [];
      for (const dependency of dependencies) {
        const candidate = longest.get(dependency) ?? [];
        if (candidate.length > best.length) best = candidate;
      }
      longest.set(id, [...best, id]);
    }
    return [...longest.values()].reduce<string[]>((best, candidate) => (candidate.length > best.length ? candidate : best), []);
  }

  snapshot(): GraphSnapshot {
    return {
      id: this.id,
      taskDescription: this.taskDescription,
      totalBudget: this.totalBudget,
      nodes: this.allNodes().map((node) => node.toSnapshot()),
      edges: this.edges.map((edge) => edge.toSnapshot()),
    };
  }

  static deserialize(value: unknown): ExecutionGraph {
    const snapshot = GraphSnapshotSchema.parse(value);
    const graph = new ExecutionGraph(snapshot.id, snapshot.taskDescription, snapshot.totalBudget);
    for (const nodeSnapshot of snapshot.nodes) graph.addNode(NodeDefinition.fromSnapshot(nodeSnapshot));
    for (const edgeSnapshot of snapshot.edges) graph.addEdge(GraphEdge.fromSnapshot(edgeSnapshot));
    return graph;
  }
}

export interface GraphRunner {
  runNode(node: NodeDefinition, context: Record<string, unknown>): Promise<unknown>;
}

export type GraphEvent =
  | { type: "graph.started"; graphId: string; order: string[] }
  | { type: "graph.completed"; graphId: string; status: GraphRunStatus; completed: number; failed: number }
  | { type: "node.transition"; nodeId: string; from: NodeState; to: NodeState; reason: string };

export type GraphRunStatus = "completed" | "failed" | "blocked";

export interface GraphRunResult {
  graphId: string;
  status: GraphRunStatus;
  order: string[];
  completed: string[];
  failed: string[];
  blocked: string[];
  skipped: string[];
}

export interface GraphExecuteOptions {
  signal?: AbortSignal;
  maxWaves?: number;
  onEvent?: (event: GraphEvent) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(new AelvoError("EXECUTION_ABORTED", "Graph execution cancelled"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AelvoError("EXECUTION_ABORTED", "Graph execution cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Port of runtime_next.engine.ExecutionEngine with corrected completion
 * semantics:
 *  - independent ready nodes execute as a wave (parallel branch support);
 *  - a failed node blocks every dependent instead of leaving it "pending";
 *  - only nodes that actually completed are reported as completed;
 *  - conditional edges that do not match mark the target skipped;
 *  - cancellation propagates before and between waves.
 */
export class GraphExecutionEngine {
  private readonly graph: ExecutionGraph;
  private readonly runner: GraphRunner;
  private readonly maxRetryCycles: number;

  constructor(graph: ExecutionGraph, runner: GraphRunner, maxRetryCycles = 2) {
    this.graph = graph;
    this.runner = runner;
    this.maxRetryCycles = maxRetryCycles;
  }

  async execute(context: Record<string, unknown> = {}, options: GraphExecuteOptions = {}): Promise<GraphRunResult> {
    const order = this.graph.topologicalSort();
    const completed = new Set<string>();
    const failed = new Set<string>();
    const blocked = new Set<string>();
    const skipped = new Set<string>();
    const settled = new Set<string>();
    options.onEvent?.({ type: "graph.started", graphId: this.graph.id, order });

    try {
      let waves = 0;
      while (settled.size < this.graph.allNodes().length) {
        if (options.signal?.aborted === true) throw new AelvoError("EXECUTION_ABORTED", "Graph execution cancelled");
        if (waves > this.maxRetryCycles + this.graph.allNodes().length + 1) {
          throw new AelvoError("EXECUTION_FAILED", "Graph made no progress");
        }
        if (options.maxWaves !== undefined && waves >= options.maxWaves) break;
        waves += 1;

        const ready = this.graph.getReadyNodes(completed);
        if (ready.length === 0) {
          // Nothing runnable: every remaining pending node depends on a node
          // that failed, was blocked or was skipped. Mark it blocked, never
          // "completed".
          for (const node of this.graph.allNodes()) {
            if (node.state !== "pending") continue;
            node.transition("blocked", "Dependencies did not complete");
            blocked.add(node.id);
            settled.add(node.id);
          }
          break;
        }

        await Promise.all(
          ready.map(async (nodeId) => {
            const node = this.graph.requireNode(nodeId);
            if (this.edgeConditionsPass(node)) {
              await this.runNode(node, context, completed, failed, options);
            } else {
              node.transition("skipped", "Incoming edge condition did not match");
              skipped.add(node.id);
            }
            settled.add(node.id);
          }),
        );
      }
    } catch (error) {
      options.onEvent?.({
        type: "graph.completed",
        graphId: this.graph.id,
        status: "failed",
        completed: completed.size,
        failed: failed.size + this.graph.allNodes().filter((node) => node.state === "running").length,
      });
      throw error;
    }

    for (const node of this.graph.allNodes()) {
      if (node.state === "pending" || node.state === "ready" || node.state === "running" || node.state === "retrying") {
        node.transition("blocked", "Graph ended before this node ran");
        blocked.add(node.id);
      }
    }

    const status: GraphRunStatus = failed.size > 0 ? "failed" : blocked.size > 0 ? "blocked" : "completed";
    options.onEvent?.({
      type: "graph.completed",
      graphId: this.graph.id,
      status,
      completed: completed.size,
      failed: failed.size,
    });
    return {
      graphId: this.graph.id,
      status,
      order,
      completed: [...completed],
      failed: [...failed],
      blocked: [...blocked],
      skipped: [...skipped],
    };
  }

  private edgeConditionsPass(node: NodeDefinition): boolean {
    for (const edge of this.graph.incoming(node.id)) {
      const source = this.graph.requireNode(edge.source);
      if (source.state !== "completed") return false;
      const output = isRecord(source.result) ? source.result : undefined;
      if (!edge.condition.evaluate(output)) return false;
    }
    return true;
  }

  private async runNode(
    node: NodeDefinition,
    context: Record<string, unknown>,
    completed: Set<string>,
    failed: Set<string>,
    options: GraphExecuteOptions,
  ): Promise<void> {
    const allDone = this.graph.dependencyIds(node.id).every((dependency) => {
      const dependencyNode = this.graph.requireNode(dependency);
      return dependencyNode.state === "completed";
    });
    if (!allDone) {
      node.transition("blocked", "Dependency failed or was skipped");
      failed.add(node.id);
      return;
    }

    const from = node.state;
    node.transition("running", "Dependencies completed");
    options.onEvent?.({ type: "node.transition", nodeId: node.id, from, to: "running", reason: "ready" });

    let lastError: unknown;
    const attempts = node.retryPolicy.maxRetries + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (options.signal?.aborted === true) throw new AelvoError("EXECUTION_ABORTED", "Graph execution cancelled");
      try {
        const result = await this.runner.runNode(node, context);
        const output = isRecord(result) && "output" in result ? result.output : result;
        if (isRecord(output)) {
          const validation = node.outputContract.validate(output);
          if (!validation.ok) throw new AelvoError("VERIFICATION_FAILED", validation.detail);
        }
        node.result = result;
        node.retryCount = attempt;
        node.transition("completed", attempt === 0 ? "Runner completed" : `Completed after ${attempt} retries`);
        completed.add(node.id);
        options.onEvent?.({ type: "node.transition", nodeId: node.id, from: "running", to: "completed", reason: "completed" });
        return;
      } catch (error) {
        lastError = error;
        node.retryCount = attempt + 1;
        const message = error instanceof Error ? error.message : String(error);
        const canRetry = attempt < attempts - 1 && node.retryPolicy.isRetryable(message);
        if (!canRetry) break;
        node.transition("retrying", message);
        options.onEvent?.({ type: "node.transition", nodeId: node.id, from: "running", to: "retrying", reason: message });
        await sleep(node.retryPolicy.computeDelayMs(attempt), options.signal);
        node.transition("running", "Retry");
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    node.error = message;
    node.transition("failed", message);
    failed.add(node.id);
    options.onEvent?.({ type: "node.transition", nodeId: node.id, from: "running", to: "failed", reason: message });

  }
}
