import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AelvoApplication } from "../../src/app.js";
import type { AelvoConfig } from "../../src/config/index.js";
import { silentLogger } from "../../src/observability/logger.js";
import { MockGateway, type ScriptedTurn } from "../../src/intelligence/providers/mock/gateway.js";

export interface TestApp {
  app: AelvoApplication;
  workspace: string;
  dataDir: string;
  gateway: MockGateway;
  cleanup: () => void;
}

export function testConfig(workspace: string, dataDir: string): AelvoConfig {
  return {
    dataDir,
    dbPath: join(dataDir, "aelvo.db"),
    workspaceRoot: workspace,
    model: "mock-model",
    apiKey: undefined,
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, allowedOrigins: ["http://127.0.0.1:5173"] },
    approvals: { ttlSeconds: 60 },
    tools: {
      timeoutMs: 5_000,
      maxOutputBytes: 64_000,
      allowProcessExec: false,
      allowNetwork: false,
    },
    runtime: { maxRunSteps: 6 },
  };
}

export async function createTestApp(turns: ScriptedTurn[] = []): Promise<TestApp> {
  const root = mkdtempSync(join(tmpdir(), "aelvo-test-"));
  const workspace = join(root, "workspace");
  const dataDir = join(root, "data");
  const gateway = new MockGateway(turns);
  const app = await AelvoApplication.create({
    config: testConfig(workspace, dataDir),
    logger: silentLogger,
    gateway,
    packageRoot: root,
  });
  return {
    app,
    workspace,
    dataDir,
    gateway,
    cleanup: () => {
      try {
        app.close();
      } catch {
        // The DB may already be closed by a test.
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
