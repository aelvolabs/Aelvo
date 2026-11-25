import type { Capability } from "../../shared/contracts/index.js";
import { AelvoError } from "../../shared/errors/index.js";
import { isWithin, type PathPolicy } from "../paths.js";

export interface PolicyRequest {
  capability: Capability;
  resource: string;
  /** Absolute paths the action would touch, already canonicalized by the tool. */
  paths: string[];
  destructive: boolean;
  runId: string;
  actor: "model" | "user" | "system";
  /** Set by a trusted in-process caller (CLI user action), never by the model. */
  userInitiated: boolean;
}

export type PolicyVerdict = "allow" | "deny" | "approval";

export interface PolicyDecision {
  verdict: PolicyVerdict;
  capability: Capability;
  resource: string;
  reason: string;
}

export interface PolicyOptions {
  paths: PathPolicy;
  allowProcessExec: boolean;
  allowNetwork: boolean;
}

/**
 * One authoritative capability policy. It has no model input, no network
 * input and no plugin registry: a request either matches a rule or is denied.
 */
export class PolicyService {
  private readonly options: PolicyOptions;
  private emergencyStopActive = false;

  constructor(options: PolicyOptions) {
    this.options = options;
  }

  setEmergencyStop(active: boolean): void {
    this.emergencyStopActive = active;
  }

  isEmergencyStopActive(): boolean {
    return this.emergencyStopActive;
  }

  evaluate(request: PolicyRequest): PolicyDecision {
    const base = { capability: request.capability, resource: request.resource };
    if (this.emergencyStopActive) {
      return { ...base, verdict: "deny", reason: "Emergency stop is active" };
    }
    if (request.capability === "credentials") {
      return { ...base, verdict: "deny", reason: "Tools may never read or write credentials" };
    }
    for (const path of request.paths) {
      for (const protectedPath of this.options.paths.protectedPaths) {
        if (isWithin(protectedPath, path)) {
          return { ...base, verdict: "deny", reason: "Resource is protected by policy" };
        }
      }
    }

    switch (request.capability) {
      case "fs.read": {
        const inside = request.paths.every((path) => isWithin(this.options.paths.workspaceRoot, path));
        return inside
          ? { ...base, verdict: "allow", reason: "Read inside the authorized workspace" }
          : { ...base, verdict: "approval", reason: "Read outside the authorized workspace" };
      }
      case "fs.write": {
        const inside = request.paths.every((path) => isWithin(this.options.paths.workspaceRoot, path));
        return inside
          ? { ...base, verdict: "allow", reason: "Write inside the authorized workspace" }
          : { ...base, verdict: "approval", reason: "Write outside the authorized workspace" };
      }
      case "fs.delete":
        return { ...base, verdict: "approval", reason: "Deletion requires explicit approval" };
      case "process.exec":
        if (!this.options.allowProcessExec) {
          return { ...base, verdict: "deny", reason: "Process execution is disabled by configuration" };
        }
        return { ...base, verdict: "approval", reason: "Process execution requires explicit approval" };
      case "network":
        if (!this.options.allowNetwork) {
          return { ...base, verdict: "deny", reason: "Network tools are disabled by configuration" };
        }
        return { ...base, verdict: "approval", reason: "Network access requires explicit approval" };
      case "app.control":
      case "destructive":
      case "data.sensitive":
        return { ...base, verdict: "approval", reason: "Privileged operation requires explicit approval" };
      case "integration":
        return request.userInitiated && !request.destructive
          ? { ...base, verdict: "allow", reason: "User-initiated integration call" }
          : { ...base, verdict: "approval", reason: "Integration call requires explicit approval" };
      default:
        return { ...base, verdict: "deny", reason: "No policy rule authorizes this capability" };
    }
  }

  assertAllowed(decision: PolicyDecision): void {
    if (decision.verdict === "deny") {
      throw new AelvoError("TOOL_DENIED", decision.reason, {
        details: { capability: decision.capability, resource: decision.resource },
      });
    }
  }
}
