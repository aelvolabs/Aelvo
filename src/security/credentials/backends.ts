import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AelvoError } from "../../shared/errors/index.js";
import { assertCredentialName } from "./validation.js";

export { assertCredentialName } from "./validation.js";

export type CredentialBackendKind = "dpapi" | "keychain" | "secret-service" | "memory";

export interface CredentialBackend {
  readonly kind: CredentialBackendKind;
  available(): Promise<boolean>;
  read(name: string): Promise<string | undefined>;
  write(name: string, secret: string): Promise<void>;
  remove(name: string): Promise<void>;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn without a shell; secrets travel on stdin, never in argv. */
function run(command: string, args: string[], stdin?: string, timeoutMs = 15_000): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: -1, stdout, stderr: stderr + "\ncommand timed out" });
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ code: -2, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ code: code ?? -3, stdout, stderr });
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

/**
 * Windows DPAPI (current-user scope) with the ciphertext kept in the data
 * directory. Encryption happens in PowerShell; the plaintext never appears in
 * argv, process listings or on disk.
 */
export class DpapiCredentialBackend implements CredentialBackend {
  readonly kind = "dpapi" as const;
  private readonly directory: string;
  private shell: string | undefined;

  constructor(directory: string) {
    this.directory = directory;
  }

  private async powershell(): Promise<string | undefined> {
    if (this.shell !== undefined) return this.shell;
    for (const candidate of ["powershell.exe", "powershell", "pwsh.exe", "pwsh"]) {
      const result = await run(candidate, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], undefined, 5_000);
      if (result.code === 0) {
        this.shell = candidate;
        return candidate;
      }
    }
    return undefined;
  }

  async available(): Promise<boolean> {
    return process.platform === "win32" && (await this.powershell()) !== undefined;
  }

  private file(name: string): string {
    assertCredentialName(name);
    return join(this.directory, `${name}.dpapi`);
  }

  async read(name: string): Promise<string | undefined> {
    const path = this.file(name);
    if (!existsSync(path)) return undefined;
    const shell = await this.powershell();
    if (shell === undefined) {
      throw new AelvoError("CREDENTIAL_STORE_UNAVAILABLE", "Windows DPAPI is unavailable");
    }
    const encrypted = readFileSync(path, "utf8").trim();
    const script = [
      "$ErrorActionPreference='Stop'",
      "$c=[Console]::In.ReadToEnd()",
      "$s=ConvertTo-SecureString -String $c",
      "$b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)",
      "try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }",
    ].join("; ");
    const result = await run(shell, ["-NoProfile", "-NonInteractive", "-Command", script], encrypted);
    if (result.code !== 0) {
      throw new AelvoError("CREDENTIAL_STORE_UNAVAILABLE", "DPAPI decryption failed", {
        details: { stderr: result.stderr.trim().slice(0, 500) },
      });
    }
    return result.stdout.replace(/\r?\n$/, "");
  }

  async write(name: string, secret: string): Promise<void> {
    const shell = await this.powershell();
    if (shell === undefined) {
      throw new AelvoError("CREDENTIAL_STORE_UNAVAILABLE", "Windows DPAPI is unavailable");
    }
    const script = [
      "$ErrorActionPreference='Stop'",
      "$p=[Console]::In.ReadToEnd()",
      "$s=ConvertTo-SecureString -String $p -AsPlainText -Force",
      "ConvertFrom-SecureString -SecureString $s",
    ].join("; ");
    const result = await run(shell, ["-NoProfile", "-NonInteractive", "-Command", script], secret);
    if (result.code !== 0 || result.stdout.trim().length === 0) {
      throw new AelvoError("CREDENTIAL_STORE_UNAVAILABLE", "DPAPI encryption failed", {
        details: { stderr: result.stderr.trim().slice(0, 500) },
      });
    }
    mkdirSync(this.directory, { recursive: true });
    const path = this.file(name);
    writeFileSync(path, result.stdout.trim(), { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows ACLs do not map to POSIX modes; the DPAPI blob is the barrier.
    }
  }

  async remove(name: string): Promise<void> {
    rmSync(this.file(name), { force: true });
  }
}

/** macOS Keychain; the secret is fed through `security -i` on stdin. */
export class KeychainCredentialBackend implements CredentialBackend {
  readonly kind = "keychain" as const;
  private readonly service = "com.aelvolabs.aelvo";

  async available(): Promise<boolean> {
    if (process.platform !== "darwin") return false;
    return existsSync("/usr/bin/security");
  }

  async read(name: string): Promise<string | undefined> {
    assertCredentialName(name);
    const result = await run("/usr/bin/security", ["find-generic-password", "-s", this.service, "-a", name, "-w"]);
    if (result.code === 44 || result.code === 1) return undefined;
    if (result.code !== 0) {
      throw new AelvoError("CREDENTIAL_STORE_UNAVAILABLE", "Keychain read failed", {
        details: { stderr: result.stderr.trim().slice(0, 500) },
      });
    }
    return result.stdout.replace(/\r?\n$/, "");
  }

  async write(name: string, secret: string): Promise<void> {
    assertCredentialName(name);
    const quotedName = name.replaceAll('"', "");
    const quotedSecret = secret.replaceAll('"', '\\"').replaceAll("\n", "");
    const command = `add-generic-password -U -s "${this.service}" -a "${quotedName}" -w "${quotedSecret}"\n`;
    const result = await run("/usr/bin/security", ["-i"], command);
    if (result.code !== 0) {
      throw new AelvoError("CREDENTIAL_STORE_UNAVAILABLE", "Keychain write failed", {
        details: { stderr: result.stderr.trim().slice(0, 500) },
      });
    }
  }

  async remove(name: string): Promise<void> {
    assertCredentialName(name);
    await run("/usr/bin/security", ["delete-generic-password", "-s", this.service, "-a", name]);
  }
}

/** Linux Secret Service via libsecret; secret is written to stdin. */
export class SecretServiceCredentialBackend implements CredentialBackend {
  readonly kind = "secret-service" as const;

  async available(): Promise<boolean> {
    if (process.platform !== "linux") return false;
    const result = await run("secret-tool", ["--version"], undefined, 5_000);
    return result.code === 0;
  }

  async read(name: string): Promise<string | undefined> {
    assertCredentialName(name);
    const result = await run("secret-tool", ["lookup", "service", "aelvo", "account", name]);
    if (result.code !== 0) return undefined;
    const value = result.stdout.replace(/\r?\n$/, "");
    return value.length === 0 ? undefined : value;
  }

  async write(name: string, secret: string): Promise<void> {
    assertCredentialName(name);
    const result = await run(
      "secret-tool",
      ["store", "--label", `AELVO ${name}`, "service", "aelvo", "account", name],
      secret,
    );
    if (result.code !== 0) {
      throw new AelvoError("CREDENTIAL_STORE_UNAVAILABLE", "Secret Service write failed", {
        details: { stderr: result.stderr.trim().slice(0, 500) },
      });
    }
  }

  async remove(name: string): Promise<void> {
    assertCredentialName(name);
    await run("secret-tool", ["clear", "service", "aelvo", "account", name]);
  }
}

/** Test double. Never selected by the platform factory. */
export class MemoryCredentialBackend implements CredentialBackend {
  readonly kind = "memory" as const;
  private readonly values = new Map<string, string>();

  async available(): Promise<boolean> {
    return true;
  }

  async read(name: string): Promise<string | undefined> {
    return this.values.get(name);
  }

  async write(name: string, secret: string): Promise<void> {
    this.values.set(name, secret);
  }

  async remove(name: string): Promise<void> {
    this.values.delete(name);
  }
}
