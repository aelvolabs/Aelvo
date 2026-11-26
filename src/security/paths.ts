import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AelvoError } from "../shared/errors/index.js";

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Secret-bearing filenames are denied to every tool, even inside the
 * workspace, so a model cannot exfiltrate local credentials through the
 * provider context or a tool result.
 */
const PROTECTED_NAMES = [
  /^\.env(\..*)?$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.git-credentials$/i,
  /^bridge-token$/i,
  /^aelvo\.db(-(wal|shm|journal))?$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
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
  /** Additional pre-authorized directories outside workspaceRoot. */
  approvedDirectories?: string[];
  /** Disallow existing regular files with multiple hard links. */
  rejectHardLinks?: boolean;
}

function validateWindowsLexicalPath(requested: string): void {
  if (/^\\\\[?.]\\/.test(requested) || requested.startsWith("\\\\")) {
    throw new AelvoError("PATH_INVALID", "UNC and Windows device paths are not permitted");
  }
  // Strip ONLY an explicit leading single drive prefix like `C:` before scanning for `:`,
  // so NTFS Alternate Data Streams such as `C:\dir\file.txt:stream` cannot bypass check.
  const withoutDrive = /^[a-zA-Z]:/.test(requested) ? requested.slice(2) : requested;
  if (withoutDrive.includes(":")) {
    throw new AelvoError("PATH_INVALID", "Alternate data streams are not supported");
  }
}

function validatePathSegments(rawPath: string): void {
  const segments = rawPath.split(/[\\/]+/).filter((seg) => seg.length > 0);
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]!;
    if (i === 0 && /^[a-zA-Z]:$/.test(seg)) continue;
    if (seg === "." || seg === "..") continue;
    if (process.platform === "win32") {
      if (WINDOWS_RESERVED.test(seg)) {
        throw new AelvoError("PATH_INVALID", `Reserved Windows device name: ${seg}`);
      }
      if (/[\s.]$/.test(seg)) {
        throw new AelvoError("PATH_INVALID", `Invalid trailing space or dot in path segment: ${seg}`);
      }
    }
  }
}

/**
 * Inspect existing filesystem entries along `unresolvedTarget` for symbolic links /
 * junctions whose real target crosses protected boundaries or escapes `workspaceRoot`,
 * and optionally reject hard-linked files.
 */
function checkFilesystemLinks(
  unresolvedTarget: string,
  canonicalTarget: string,
  policy: PathPolicy,
): void {
  const rootCanonical = canonicalize(policy.workspaceRoot);
  const startInsideWorkspace = comparable(resolve(unresolvedTarget)).startsWith(
    comparable(resolve(policy.workspaceRoot)),
  );

  // Walk ancestors up to root to catch symlinked or junctioned directories cleanly.
  let cursor = resolve(unresolvedTarget);
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const lst = lstatSync(cursor);
      if (lst.isSymbolicLink()) {
        const resolvedLink = realpathOrSelf(cursor);
        for (const protectedPath of policy.protectedPaths) {
          if (isWithin(protectedPath, resolvedLink)) {
            throw new AelvoError("PATH_PROTECTED", "Symbolic link resolves into a protected path", {
              details: { path: unresolvedTarget, resolved: resolvedLink },
            });
          }
        }
        if (startInsideWorkspace && !isWithin(rootCanonical, resolvedLink)) {
          throw new AelvoError("PATH_OUTSIDE_WORKSPACE", "Symbolic link escapes the authorized workspace", {
            details: { path: unresolvedTarget, resolved: resolvedLink },
          });
        }
      }
      if (
        policy.rejectHardLinks === true &&
        cursor === resolve(unresolvedTarget) &&
        lst.isFile() &&
        lst.nlink > 1
      ) {
        throw new AelvoError("PATH_INVALID", "Hard-linked files are rejected by path policy", {
          details: { path: canonicalTarget, nlink: lst.nlink },
        });
      }
    } catch (error) {
      if (error instanceof AelvoError) throw error;
      // Path component does not exist yet — safe to continue climbing toward ancestor.
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

export function assertSafePath(requested: string, policy: PathPolicy): string {
  if (typeof requested !== "string" || requested.trim().length === 0) {
    throw new AelvoError("PATH_INVALID", "Path must be a non-empty string");
  }
  if (CONTROL_CHARS.test(requested)) {
    throw new AelvoError("PATH_INVALID", "Path contains invalid control characters or null byte");
  }
  if (process.platform === "win32") {
    validateWindowsLexicalPath(requested);
  }
  validatePathSegments(requested);

  const unresolvedTarget = isAbsolute(requested) ? resolve(requested) : join(policy.workspaceRoot, requested);
  const canonical = canonicalize(unresolvedTarget);

  validatePathSegments(canonical);
  checkFilesystemLinks(unresolvedTarget, canonical, policy);

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
  const allowedRoots = [policy.workspaceRoot, ...(policy.approvedDirectories ?? [])];
  if (!allowedRoots.some((root) => isWithin(root, canonical))) {
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
