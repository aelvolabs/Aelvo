import { existsSync } from "node:fs";
import { join } from "node:path";
import { AelvoError } from "../../shared/errors/index.js";

export interface SandboxStatus {
  available: boolean;
  binaryPath: string;
  reason: string;
}

/**
 * Bridge to the Rust security primitives.
 *
 * The Rust component is the only thing allowed to claim filesystem or process
 * containment. When it is missing, privileged execution fails closed instead of
 * silently falling back to an unconfined child process.
 */
export class SandboxBridge {
  private readonly packageRoot: string;

  constructor(packageRoot: string) {
    this.packageRoot = packageRoot;
  }

  private candidatePaths(): string[] {
    const exe = process.platform === "win32" ? "sandbox_core.exe" : "sandbox_core";
    return [
      join(this.packageRoot, "sandbox_core", "target", "release", exe),
      join(this.packageRoot, "sandbox_core", "target", "debug", exe),
      join(this.packageRoot, "bin", exe),
    ];
  }

  status(): SandboxStatus {
    for (const candidate of this.candidatePaths()) {
      if (existsSync(candidate)) {
        return { available: true, binaryPath: candidate, reason: "Rust sandbox binary present" };
      }
    }
    return {
      available: false,
      binaryPath: "",
      reason: "Rust sandbox binary not built (cargo build --release in sandbox_core)",
    };
  }

  /** Guard called before any process execution or containment claim. */
  assertAvailable(): string {
    const status = this.status();
    if (!status.available) {
      throw new AelvoError("SANDBOX_UNAVAILABLE", status.reason);
    }
    return status.binaryPath;
  }
}
