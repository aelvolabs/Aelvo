import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AelvoError } from "../shared/errors/index.js";

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Secret-bearing filenames are denied to every tool, even inside the
 * workspace, so a model cannot exfiltrate local credentials through the
 * provider context or a tool result.
 */
const PROTECTED_NAMES = [
  /^\.env(\..*)?$/i,
  /^\.npmrc$/i,
  /^\.git-credentials$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)$/i,
  /\.(pem|key|pfx|p12|dpapi)$/i,
];

export function isProtectedName(name: string): boolean {
  return PROTECTED_NAMES.some((pattern) => pattern.test(name));
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * Resolve the real location of a path whose leaf may not exist yet.
 *
 * Non-existent leaves are resolved against the deepest existing ancestor, so
 * `workspace/new/dir/file.txt` cannot escape through a symlinked or junctioned
 * parent that only appears after creation.
 */
export function canonicalize(path: string): string {
  const absolute = resolve(path);
  let current = absolute;
  const missing: string[] = [];
  for (;;) {
    const real = realpathOrSelf(current);
    if (real !== current || exists(current)) {
      return resolve(real, ...missing.reverse());
    }
    const parent = dirname(current);
    if (parent === current) return absolute;
    missing.push(basename(current));
    current = parent;
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function comparable(path: string): string {
  const normalized = path.replaceAll("/", sep);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** True when `target` is `root` itself or lives underneath it. */
export function isWithin(root: string, target: string): boolean {
  const from = comparable(canonicalize(root));
  const to = comparable(canonicalize(target));
  if (from === to) return true;
  const prefix = from.endsWith(sep) ? from : from + sep;
  return to.startsWith(prefix);
}

export interface PathPolicy {
  workspaceRoot: string;
  /** Never readable or writable by the model, regardless of workspace. */
  protectedPaths: string[];
}

export function assertSafePath(requested: string, policy: PathPolicy): string {
  if (requested.includes("\0")) {
    throw new AelvoError("PATH_INVALID", "Path contains a null byte");
  }
  // NTFS alternate data streams: "file.txt:secret" or "C:evil".
  if (process.platform === "win32" && /^[a-zA-Z]:/.test(requested) === false && requested.includes(":")) {
    throw new AelvoError("PATH_INVALID", "Alternate data streams are not supported");
  }
  const target = isAbsolute(requested) ? resolve(requested) : join(policy.workspaceRoot, requested);
  const canonical = canonicalize(target);
  if (process.platform === "win32" && WINDOWS_RESERVED.test(basename(canonical))) {
    throw new AelvoError("PATH_INVALID", "Reserved Windows device name");
  }
  if (isProtectedName(basename(canonical))) {
    throw new AelvoError("PATH_PROTECTED", "Path holds credentials and is not tool-accessible", {
      details: { path: canonical },
    });
  }
  for (const protectedPath of policy.protectedPaths) {
    if (isWithin(protectedPath, canonical)) {
      throw new AelvoError("PATH_PROTECTED", "Path is protected by policy", {
        details: { path: canonical },
      });
    }
  }
  return canonical;
}

export function assertInsideWorkspace(requested: string, policy: PathPolicy): string {
  const canonical = assertSafePath(requested, policy);
  if (!isWithin(policy.workspaceRoot, canonical)) {
    throw new AelvoError("PATH_OUTSIDE_WORKSPACE", "Path is outside the authorized workspace", {
      details: { path: canonical, workspaceRoot: canonicalize(policy.workspaceRoot) },
    });
  }
  return canonical;
}

/** Workspace-relative POSIX-style path for display and audit records. */
export function displayPath(root: string, target: string): string {
  const rel = relative(canonicalize(root), canonicalize(target));
  return (rel === "" ? "." : rel).split(sep).join("/");
}
