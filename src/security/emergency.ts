import type { RuntimeEvent } from "../shared/contracts/index.js";
import { AelvoError } from "../shared/errors/index.js";
import type { ApprovalService } from "./approvals/service.js";
import type { AuditLog } from "./audit/log.js";
import type { PolicyService } from "./policies/policy.js";

export type EmergencyActor = "user" | "cli" | "bridge" | "system" | "model";

export interface EmergencyStopTargets {
  policy: PolicyService;
  approvals: ApprovalService;
  audit: AuditLog;
  cancelAllRuns: () => number;
  invalidateLiveSessions: (reason: string) => void;
  invalidateToolCache: () => number;
  publishEvent: (event: RuntimeEvent) => void;
}

export interface EmergencyStopReceipt {
  active: boolean;
  cancelledRuns: number;
  revokedApprovals: number;
  clearedCacheEntries: number;
  policyEpoch: number;
}

/**
 * Centralized emergency stop coordinator.
 *
 * Activating emergency stop prevents new privileged actions across text, Live,
 * background tasks and bridge, revokes unconsumed approvals, invalidates cached
 * reads and active Live sessions, and requests cancellation of running actions.
 * It never claims already-completed external effects were undone.
 */
export class EmergencyStopController {
  private readonly targets: EmergencyStopTargets;

  constructor(targets: EmergencyStopTargets) {
    this.targets = targets;
  }

  activate(actor: EmergencyActor, reason = "Emergency stop activated by user"): EmergencyStopReceipt {
    if (actor === "model") {
      this.targets.audit.record({
        actor: "model",
        action: "security.emergency_stop",
        decision: "deny",
        decisionReason: "Model is forbidden from toggling emergency stop",
      });
      throw new AelvoError("TOOL_DENIED", "The model cannot alter emergency stop state");
    }

    const preCleared = this.targets.invalidateToolCache();
    this.targets.policy.setEmergencyStop(true, actor);
    const revokedApprovals = this.targets.approvals.revokeAll(`Emergency stop: ${reason}`);
    const cancelledRuns = this.targets.cancelAllRuns();
    this.targets.invalidateLiveSessions(`Emergency stop: ${reason}`);
    const clearedCacheEntries = preCleared + this.targets.invalidateToolCache();

    this.targets.audit.record({
      actor,
      action: "security.emergency_stop",
      decision: "emergency_stop",
      decisionReason: reason,
      detail: {
        revokedApprovals,
        cancelledRuns,
        clearedCacheEntries,
        policyEpoch: this.targets.policy.policyEpoch,
      },
    });
    this.targets.publishEvent({ type: "security.emergency_stop", active: true });

    return {
      active: true,
      cancelledRuns,
      revokedApprovals,
      clearedCacheEntries,
      policyEpoch: this.targets.policy.policyEpoch,
    };
  }

  resume(actor: EmergencyActor, reason = "Authorized operator resumed execution"): EmergencyStopReceipt {
    if (actor === "model") {
      this.targets.audit.record({
        actor: "model",
        action: "security.emergency_resume",
        decision: "deny",
        decisionReason: "Model is forbidden from disabling emergency stop",
      });
      throw new AelvoError("TOOL_DENIED", "The model cannot disable emergency stop");
    }

    this.targets.policy.setEmergencyStop(false, actor);
    const clearedCacheEntries = this.targets.invalidateToolCache();

    this.targets.audit.record({
      actor,
      action: "security.emergency_resume",
      decision: "emergency_resume",
      decisionReason: reason,
      detail: { policyEpoch: this.targets.policy.policyEpoch },
    });
    this.targets.publishEvent({ type: "security.emergency_stop", active: false });

    return {
      active: false,
      cancelledRuns: 0,
      revokedApprovals: 0,
      clearedCacheEntries,
      policyEpoch: this.targets.policy.policyEpoch,
    };
  }
}
