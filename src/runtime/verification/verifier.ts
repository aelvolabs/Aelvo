import type { ToolExecutionRecord } from "../../shared/contracts/index.js";
import { AelvoError } from "../../shared/errors/index.js";

export interface CompletionClaim {
  output: string;
  toolExecutions: ToolExecutionRecord[];
}

/**
 * Independent completion check. The executor already verifies each tool, but a
 * run may only be reported complete when it produced an answer and every
 * claimed success carries evidence.
 */
export class RunVerifier {
  verifyCompletion(claim: CompletionClaim): void {
    if (claim.output.trim().length === 0) {
      throw new AelvoError("VERIFICATION_FAILED", "Run produced no answer text");
    }
    for (const record of claim.toolExecutions) {
      if (record.status !== "succeeded") continue;
      if (record.outcome === undefined || record.outcome.evidence.length === 0) {
        throw new AelvoError("EVIDENCE_MISSING", "A tool was reported successful without evidence", {
          details: { tool: record.call.name },
        });
      }
    }
  }
}
