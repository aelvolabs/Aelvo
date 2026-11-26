import type { AutonomyLevel, Capability, RequestOrigin, RiskLevel } from "../../shared/contracts/index.js";
import { CapabilitySchema } from "../../shared/contracts/index.js";
import { AelvoError } from "../../shared/errors/index.js";
import { newId } from "../../shared/ids.js";
import { isWithin, type PathPolicy } from "../paths.js";

export interface PolicyRequest {
  capability: Capability;
  resource: string;
  /** Absolute paths the action would touch, already canonicalized by the tool. */
  paths: string[];
  destructive: boolean;
  runId: string;
  actor: "model" | "user" | "system" | "bridge" | "cli";
  /** Set by a trusted in-process caller (CLI user action), never by the model. */
  userInitiated: boolean;
  toolName?: string;
  sessionId?: string;
  taskId?: string;
  origin?: RequestOrigin;
  destination?: string;
}

export type PolicyVerdict = "allow" | "deny" | "approval";

export interface PolicyDecision {
  verdict: PolicyVerdict;
  capability: Capability;
  resource: string;
  reason: string;
  riskLevel: RiskLevel;
  scope: string;
  policyEpoch: number;
}

export interface PermissionGrant {
  id?: string;
  capabilities: Capability[];
  tools?: string[];
  directories?: string[];
  files?: string[];
  integrations?: string[];
  networkDestinations?: string[];
  sessionId?: string;
  taskId?: string;
  expiresAtMs?: number;
  allowDestructive?: boolean;
  reason: string;
}

export interface StoredPermissionGrant extends PermissionGrant {
  id: string;
  createdAtMs: number;
}

export interface PolicyOptions {
  paths: PathPolicy;
  allowProcessExec: boolean;
  allowNetwork: boolean;
  autonomy?: AutonomyLevel;
  availableCapabilities?: Capability[];
}

/**
 * Capabilities implemented cleanly in the active TypeScript runtime.
 * Unimplemented native capabilities (screen, microphone, clipboard, etc.)
 * remain explicitly unavailable and fail closed regardless of autonomy.
 */
export const DEFAULT_AVAILABLE_CAPABILITIES: readonly Capability[] = [
  "fs.read",
  "fs.write",
  "fs.delete",
  "fs.move",
  "process.exec",
  "app.control",
  "network",
  "integration",
  "credentials",
  "data.sensitive",
  "destructive",
  "memory",
  "schedule",
];

export const FUTURE_UNAVAILABLE_CAPABILITIES: readonly Capability[] = [
  "process.inspect",
  "clipboard",
  "notification",
  "screen",
  "microphone",
];

function isAuthorizedActor(actor: string): boolean {
  return actor !== "model";
}

function classifyRisk(request: PolicyRequest, allInsideWorkspace: boolean, touchesProtected: boolean): RiskLevel {
  if (request.capability === "credentials" || touchesProtected) {
    return "critical";
  }
  if (
    request.capability === "process.exec" ||
    request.capability === "fs.delete" ||
    request.capability === "destructive" ||
    request.capability === "data.sensitive" ||
    request.capability === "app.control" ||
    request.capability === "screen" ||
    request.capability === "microphone"
  ) {
    return request.destructive ? "high" : "high";
  }
  if (
    request.capability === "network" ||
    request.capability === "integration" ||
    request.capability === "fs.move" ||
    request.capability === "clipboard" ||
    !allInsideWorkspace
  ) {
    return request.destructive ? "high" : "moderate";
  }
  if (request.capability === "fs.write" || request.capability === "schedule") {
    return request.destructive ? "high" : "moderate";
  }
  if (request.capability === "fs.read" || request.capability === "memory" || request.capability === "notification") {
    return allInsideWorkspace ? "low" : "moderate";
  }
  return "high";
}

/**
 * Authoritative runtime capability and risk policy service.
 *
 * Separates capability availability from authorization, evaluates deterministic
 * risk levels independent of model claims, supports restricted/balanced/high
 * autonomy with explicit scoped grants, and versions every policy mutation via
 * `policyEpoch` so stale approvals and caches invalidate cleanly.
 */
export class PolicyService {
  private readonly options: PolicyOptions;
  private readonly availableCapabilities: Set<Capability>;
  private readonly grants = new Map<string, StoredPermissionGrant>();
  private readonly changeListeners = new Set<(epoch: number) => void>();
  private emergencyStopActive = false;
  private autonomyLevel: AutonomyLevel;
  private epoch = 1;

  constructor(options: PolicyOptions) {
    this.options = options;
    this.autonomyLevel = options.autonomy ?? "balanced";
    this.availableCapabilities = new Set(options.availableCapabilities ?? DEFAULT_AVAILABLE_CAPABILITIES);
  }

  get policyEpoch(): number {
    return this.epoch;
  }

  get autonomy(): AutonomyLevel {
    return this.autonomyLevel;
  }

  onChange(listener: (epoch: number) => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private bumpEpoch(): void {
    this.epoch += 1;
    for (const listener of this.changeListeners) {
      listener(this.epoch);
    }
  }

  setEmergencyStop(active: boolean, actor: "user" | "cli" | "bridge" | "system" | "model" = "user"): void {
    if (!isAuthorizedActor(actor)) {
      throw new AelvoError("TOOL_DENIED", "The model cannot modify emergency stop state");
    }
    if (this.emergencyStopActive !== active) {
      this.emergencyStopActive = active;
      this.bumpEpoch();
    } else {
      // Even redundant stop calls invalidate stale approvals/caches via epoch bump.
      this.bumpEpoch();
    }
  }

  isEmergencyStopActive(): boolean {
    return this.emergencyStopActive;
  }

  setAutonomy(level: AutonomyLevel, actor: "user" | "cli" | "bridge" | "system" | "model" = "user"): void {
    if (!isAuthorizedActor(actor)) {
      throw new AelvoError("TOOL_DENIED", "The model cannot change autonomy level");
    }
    this.autonomyLevel = level;
    this.bumpEpoch();
  }

  grantPermission(
    grant: PermissionGrant,
    actor: "user" | "cli" | "bridge" | "system" | "model" = "user",
  ): StoredPermissionGrant {
    if (!isAuthorizedActor(actor)) {
      throw new AelvoError("TOOL_DENIED", "Untrusted or model actors cannot grant permissions");
    }
    const id = grant.id ?? newId("prm");
    const stored: StoredPermissionGrant = {
      ...grant,
      id,
      createdAtMs: Date.now(),
    };
    this.grants.set(id, stored);
    this.bumpEpoch();
    return stored;
  }

  revokePermission(
    grantId: string,
    actor: "user" | "cli" | "bridge" | "system" | "model" = "user",
  ): boolean {
    if (!isAuthorizedActor(actor)) {
      throw new AelvoError("TOOL_DENIED", "The model cannot revoke security grants");
    }
    const deleted = this.grants.delete(grantId);
    if (deleted) this.bumpEpoch();
    return deleted;
  }

  listGrants(): StoredPermissionGrant[] {
    this.pruneExpiredGrants();
    return [...this.grants.values()];
  }

  private pruneExpiredGrants(): void {
    const now = Date.now();
    for (const [id, grant] of this.grants) {
      if (grant.expiresAtMs !== undefined && now > grant.expiresAtMs) {
        this.grants.delete(id);
      }
    }
  }

  isCapabilityAvailable(capability: Capability): boolean {
    return this.availableCapabilities.has(capability);
  }

  private matchesGrant(request: PolicyRequest): StoredPermissionGrant | undefined {
    this.pruneExpiredGrants();
    for (const grant of this.grants.values()) {
      if (!grant.capabilities.includes(request.capability)) continue;
      if (request.destructive && grant.allowDestructive !== true) continue;
      if (grant.sessionId !== undefined && grant.sessionId !== request.sessionId) continue;
      if (grant.taskId !== undefined && grant.taskId !== request.taskId && grant.taskId !== request.runId) {
        continue;
      }
      if (grant.tools !== undefined && (request.toolName === undefined || !grant.tools.includes(request.toolName))) {
        continue;
      }
      if (grant.directories !== undefined || grant.files !== undefined) {
        if (request.paths.length === 0) continue;
        const okPaths = request.paths.every((target) => {
          const inDir = grant.directories?.some((dir) => isWithin(dir, target)) ?? false;
          const exactFile = grant.files?.some((f) => isWithin(f, target) && isWithin(target, f)) ?? false;
          return inDir || exactFile;
        });
        if (!okPaths) continue;
      }
      if (grant.integrations !== undefined) {
        const match = grant.integrations.some(
          (prefix) => request.resource === prefix || request.resource.startsWith(`mcp://${prefix}/`),
        );
        if (!match) continue;
      }
      if (grant.networkDestinations !== undefined) {
        const dest = request.destination ?? request.resource;
        const match = grant.networkDestinations.some(
          (host) => dest === host || dest.startsWith(`https://${host}`) || dest.startsWith(`http://${host}`),
        );
        if (!match) continue;
      }
      return grant;
    }
    return undefined;
  }

  evaluate(request: PolicyRequest): PolicyDecision {
    const knownCapability = CapabilitySchema.safeParse(request.capability).success;
    const allAllowedRoots = [this.options.paths.workspaceRoot, ...(this.options.paths.approvedDirectories ?? [])];
    const allInsideWorkspace = request.paths.every((path) =>
      allAllowedRoots.some((root) => isWithin(root, path)),
    );
    const touchesProtected = request.paths.some((path) =>
      this.options.paths.protectedPaths.some((protectedPath) => isWithin(protectedPath, path)),
    );
    const riskLevel = classifyRisk(request, allInsideWorkspace, touchesProtected);
    const scope = allInsideWorkspace ? "workspace" : "external";
    const base = {
      capability: request.capability,
      resource: request.resource,
      riskLevel,
      scope,
      policyEpoch: this.epoch,
    };

    if (!knownCapability) {
      return {
        ...base,
        verdict: "deny",
        riskLevel: "critical",
        reason: `Unknown capability "${String(request.capability)}" denied by default`,
      };
    }

    if (this.emergencyStopActive) {
      return { ...base, verdict: "deny", reason: "Emergency stop is active" };
    }

    if (request.capability === "credentials") {
      return { ...base, verdict: "deny", riskLevel: "critical", reason: "Tools may never read or write credentials" };
    }

    if (touchesProtected) {
      return { ...base, verdict: "deny", riskLevel: "critical", reason: "Resource is protected by policy" };
    }

    if (!this.availableCapabilities.has(request.capability)) {
      return {
        ...base,
        verdict: "deny",
        reason: `Capability "${request.capability}" is not implemented or unavailable on this runtime`,
      };
    }

    if (request.capability === "process.exec" && !this.options.allowProcessExec) {
      return { ...base, verdict: "deny", reason: "Process execution is disabled by configuration" };
    }

    if (request.capability === "network" && !this.options.allowNetwork) {
      return { ...base, verdict: "deny", reason: "Network tools are disabled by configuration" };
    }

    const activeGrant = this.matchesGrant(request);

    switch (request.capability) {
      case "fs.read": {
        if (allInsideWorkspace) {
          return { ...base, verdict: "allow", reason: "Read inside the authorized workspace" };
        }
        if (this.autonomyLevel === "high" && activeGrant !== undefined) {
          return { ...base, scope: `grant:${activeGrant.id}`, verdict: "allow", reason: activeGrant.reason };
        }
        return { ...base, verdict: "approval", reason: "Read outside the authorized workspace requires approval" };
      }

      case "fs.write": {
        if (this.autonomyLevel === "restricted") {
          return { ...base, verdict: "approval", reason: "Restricted autonomy requires approval for writes" };
        }
        if (allInsideWorkspace && !request.destructive) {
          return { ...base, verdict: "allow", reason: "Write inside the authorized workspace" };
        }
        if (allInsideWorkspace && request.destructive && this.autonomyLevel === "balanced") {
          return { ...base, verdict: "allow", reason: "Workspace file update under balanced autonomy" };
        }
        if (this.autonomyLevel === "high" && activeGrant !== undefined) {
          return { ...base, scope: `grant:${activeGrant.id}`, verdict: "allow", reason: activeGrant.reason };
        }
        return { ...base, verdict: "approval", reason: "Write outside the authorized workspace requires approval" };
      }

      case "fs.delete":
      case "fs.move": {
        if (this.autonomyLevel === "high" && activeGrant !== undefined && allInsideWorkspace) {
          return { ...base, scope: `grant:${activeGrant.id}`, verdict: "allow", reason: activeGrant.reason };
        }
        return {
          ...base,
          verdict: "approval",
          reason: `${request.capability === "fs.delete" ? "Deletion" : "Move"} requires explicit approval`,
        };
      }

      case "memory":
      case "schedule": {
        if (this.autonomyLevel === "restricted" && request.destructive) {
          return { ...base, verdict: "approval", reason: "Restricted autonomy requires approval for state mutation" };
        }
        return request.destructive
          ? { ...base, verdict: "approval", reason: "Destructive memory/schedule mutation requires approval" }
          : { ...base, verdict: "allow", reason: "Scoped internal runtime operation allowed" };
      }

      case "process.exec":
        if (this.autonomyLevel === "high" && activeGrant !== undefined) {
          return { ...base, scope: `grant:${activeGrant.id}`, verdict: "allow", reason: activeGrant.reason };
        }
        return { ...base, verdict: "approval", reason: "Process execution requires explicit approval" };

      case "network":
        if (this.autonomyLevel === "high" && activeGrant !== undefined) {
          return { ...base, scope: `grant:${activeGrant.id}`, verdict: "allow", reason: activeGrant.reason };
        }
        return { ...base, verdict: "approval", reason: "Network access requires explicit approval" };

      case "integration":
        if (request.userInitiated && !request.destructive) {
          return { ...base, verdict: "allow", reason: "User-initiated integration call" };
        }
        if (this.autonomyLevel === "high" && activeGrant !== undefined) {
          return { ...base, scope: `grant:${activeGrant.id}`, verdict: "allow", reason: activeGrant.reason };
        }
        return { ...base, verdict: "approval", reason: "Integration call requires explicit approval" };

      case "app.control":
      case "destructive":
      case "data.sensitive":
        return { ...base, verdict: "approval", reason: "Privileged operation requires explicit approval" };

      default:
        return { ...base, verdict: "deny", reason: "No policy rule authorizes this capability" };
    }
  }

  assertAllowed(decision: PolicyDecision): void {
    if (decision.verdict === "deny") {
      throw new AelvoError("TOOL_DENIED", decision.reason, {
        details: {
          capability: decision.capability,
          resource: decision.resource,
          riskLevel: decision.riskLevel,
        },
      });
    }
  }
}
