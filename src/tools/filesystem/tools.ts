import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, opendir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AelvoError } from "../../shared/errors/index.js";
import { displayPath, assertSafePath, type PathPolicy } from "../../security/paths.js";
import type { ToolOutcome } from "../../shared/contracts/index.js";
import { defineTool, type AnyTool } from "../registry/types.js";

const SKIP_DIRECTORIES = new Set([".git", "node_modules", ".venv", "__pycache__", "dist", ".pytest_cache"]);

export interface FilesystemToolOptions {
  paths: PathPolicy;
  maxOutputBytes: number;
}

function hashBuffer(buffer: Buffer | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function fileStat(path: string): Promise<{ size: number; mtimeMs: number; mode: number }> {
  const info = await stat(path);
  return { size: info.size, mtimeMs: info.mtimeMs, mode: info.mode };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function truncate(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) return { text, truncated: false };
  return { text: buffer.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = join(dirname(path), `.aelvo-tmp-${randomUUID()}`);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new AelvoError("EXECUTION_FAILED", "Atomic write failed", { cause: error });
  }
}

const ReadFileInput = z
  .object({
    path: z.string().min(1).max(4_096),
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
  })
  .refine(
    (value) => value.startLine === undefined || value.endLine === undefined || value.endLine >= value.startLine,
    { message: "endLine must be greater than or equal to startLine" },
  );

const ListInput = z.object({
  path: z.string().min(1).max(4_096).default("."),
  depth: z.number().int().min(1).max(4).default(1),
});

const SearchInput = z.object({
  query: z.string().min(1).max(200),
  path: z.string().min(1).max(4_096).default("."),
  maxResults: z.number().int().min(1).max(200).default(50),
});

const WriteInput = z.object({
  path: z.string().min(1).max(4_096),
  content: z.string().max(1_000_000),
  overwrite: z.boolean().default(false),
});

const EditInput = z.object({
  path: z.string().min(1).max(4_096),
  find: z.string().min(1).max(100_000),
  replace: z.string().max(1_000_000),
  replaceAll: z.boolean().default(false),
});

const MkdirInput = z.object({
  path: z.string().min(1).max(4_096),
});

const DeleteInput = z.object({
  path: z.string().min(1).max(4_096),
  recursive: z.boolean().default(false),
});

export function createFilesystemTools(options: FilesystemToolOptions): AnyTool[] {
  const { paths, maxOutputBytes } = options;

  const readTool = defineTool({
    name: "read_file",
    description: "Read a UTF-8 text file from the workspace, optionally a line range.",
    capability: "fs.read",
    destructive: false,
    idempotent: true,
    cacheTtlMs: 2_000,
    inputSchema: ReadFileInput,
    resource: (input) => displayPath(paths.workspaceRoot, assertSafePath(input.path, paths)),
    paths: (input) => [assertSafePath(input.path, paths)],
    summary: (input) => `Read ${input.path}`,
    async execute(input): Promise<ToolOutcome> {
      const absolute = assertSafePath(input.path, paths);
      const raw = await readFile(absolute, "utf8");
      const lines = raw.split(/\r?\n/);
      let selected = raw;
      if (input.startLine !== undefined || input.endLine !== undefined) {
        const start = (input.startLine ?? 1) - 1;
        const end = input.endLine ?? lines.length;
        selected = lines.slice(start, end).join("\n");
      }
      const { text, truncated } = truncate(selected, maxOutputBytes);
      return {
        summary: `Read ${displayPath(paths.workspaceRoot, absolute)} (${lines.length} lines)`,
        data: {
          path: displayPath(paths.workspaceRoot, absolute),
          content: text,
          totalLines: lines.length,
          truncated,
        },
        evidence: [
          { kind: "file_stat", detail: { path: absolute, ...(await fileStat(absolute)) } },
          { kind: "file_hash", detail: { path: absolute, sha256: hashBuffer(raw), fullContent: !truncated } },
        ],
      };
    },
    async verify(input, outcome) {
      const absolute = assertSafePath(input.path, paths);
      const hash = await hashFile(absolute);
      const recorded = outcome.evidence.find((item) => item.kind === "file_hash")?.detail["sha256"];
      return {
        ok: hash === recorded,
        detail: hash === recorded ? "content hash matches" : "file changed during read",
      };
    },
  });

  const listTool = defineTool({
    name: "list_directory",
    description: "List directory entries up to a bounded depth.",
    capability: "fs.read",
    destructive: false,
    idempotent: true,
    cacheTtlMs: 2_000,
    inputSchema: ListInput,
    resource: (input) => displayPath(paths.workspaceRoot, assertSafePath(input.path, paths)),
    paths: (input) => [assertSafePath(input.path, paths)],
    summary: (input) => `List ${input.path}`,
    async execute(input): Promise<ToolOutcome> {
      const absolute = assertSafePath(input.path, paths);
      const entries: Array<{ path: string; type: "file" | "directory" | "other"; size: number }> = [];
      const walk = async (directory: string, depth: number): Promise<void> => {
        const handle = await opendir(directory);
        for await (const entry of handle) {
          if (entry.name.startsWith(".aelvo-tmp-")) continue;
          const child = join(directory, entry.name);
          const isDirectory = entry.isDirectory();
          const info = await stat(child);
          entries.push({
            path: displayPath(paths.workspaceRoot, child),
            type: isDirectory ? "directory" : entry.isFile() ? "file" : "other",
            size: info.size,
          });
          if (isDirectory && depth > 1 && !SKIP_DIRECTORIES.has(entry.name)) {
            await walk(child, depth - 1);
          }
        }
      };
      await walk(absolute, input.depth);
      return {
        summary: `Listed ${entries.length} entries in ${displayPath(paths.workspaceRoot, absolute)}`,
        data: { path: displayPath(paths.workspaceRoot, absolute), entries },
        evidence: [{ kind: "directory_listing", detail: { path: absolute, count: entries.length } }],
      };
    },
  });

  const searchTool = defineTool({
    name: "search_files",
    description: "Search file contents for a literal string within a bounded directory walk.",
    capability: "fs.read",
    destructive: false,
    idempotent: true,
    cacheTtlMs: 2_000,
    inputSchema: SearchInput,
    resource: (input) => displayPath(paths.workspaceRoot, assertSafePath(input.path, paths)),
    paths: (input) => [assertSafePath(input.path, paths)],
    summary: (input) => `Search for "${input.query}" in ${input.path}`,
    async execute(input): Promise<ToolOutcome> {
      const root = assertSafePath(input.path, paths);
      const matches: Array<{ path: string; line: number; text: string }> = [];
      let scanned = 0;
      const walk = async (directory: string, depth: number): Promise<void> => {
        if (matches.length >= input.maxResults) return;
        const handle = await opendir(directory);
        for await (const entry of handle) {
          if (matches.length >= input.maxResults) break;
          if (entry.name.startsWith(".aelvo-tmp-")) continue;
          const child = join(directory, entry.name);
          if (entry.isDirectory()) {
            if (depth < 12 && !SKIP_DIRECTORIES.has(entry.name)) await walk(child, depth + 1);
            continue;
          }
          if (!entry.isFile()) continue;
          const info = await stat(child);
          if (info.size > 512 * 1024) continue;
          const content = await readFile(child, "utf8").catch(() => undefined);
          if (content === undefined || content.includes("\0")) continue;
          scanned += 1;
          const lines = content.split(/\r?\n/);
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index] ?? "";
            if (line.includes(input.query)) {
              matches.push({
                path: displayPath(paths.workspaceRoot, child),
                line: index + 1,
                text: truncate(line, 500).text,
              });
              if (matches.length >= input.maxResults) break;
            }
          }
        }
      };
      await walk(root, 0);
      return {
        summary: `Found ${matches.length} matches in ${scanned} files`,
        data: { query: input.query, matches, filesScanned: scanned, limited: matches.length >= input.maxResults },
        evidence: [{ kind: "search_results", detail: { root, filesScanned: scanned, matches: matches.length } }],
      };
    },
  });

  const writeTool = defineTool({
    name: "write_file",
    description: "Create or overwrite a UTF-8 text file in the workspace.",
    capability: "fs.write",
    destructive: false,
    idempotent: false,
    inputSchema: WriteInput,
    resource: (input) => displayPath(paths.workspaceRoot, assertSafePath(input.path, paths)),
    paths: (input) => [assertSafePath(input.path, paths)],
    summary: (input) => `${input.overwrite ? "Overwrite" : "Create"} ${input.path}`,
    async execute(input): Promise<ToolOutcome> {
      const absolute = assertSafePath(input.path, paths);
      if (!input.overwrite && (await exists(absolute))) {
        throw new AelvoError("EXECUTION_FAILED", "File already exists; pass overwrite=true to replace it");
      }
      await atomicWrite(absolute, input.content);
      const info = await fileStat(absolute);
      return {
        summary: `Wrote ${Buffer.byteLength(input.content)} bytes to ${displayPath(paths.workspaceRoot, absolute)}`,
        data: { path: displayPath(paths.workspaceRoot, absolute), bytes: info.size },
        evidence: [
          { kind: "file_stat", detail: { path: absolute, ...info } },
          { kind: "file_hash", detail: { path: absolute, sha256: hashBuffer(input.content) } },
        ],
      };
    },
    async verify(input, outcome) {
      const absolute = assertSafePath(input.path, paths);
      const hash = await hashFile(absolute);
      const recorded = outcome.evidence.find((item) => item.kind === "file_hash")?.detail["sha256"];
      if (hash !== recorded) return { ok: false, detail: "written content does not match intended content" };
      const readBack = await readFile(absolute, "utf8");
      return {
        ok: readBack === input.content,
        detail: readBack === input.content ? "read-back content matches" : "read-back content differs",
      };
    },
  });

  const editTool = defineTool({
    name: "edit_file",
    description: "Replace an exact string in a file. Fails unless the match is unambiguous.",
    capability: "fs.write",
    destructive: false,
    idempotent: false,
    inputSchema: EditInput,
    resource: (input) => displayPath(paths.workspaceRoot, assertSafePath(input.path, paths)),
    paths: (input) => [assertSafePath(input.path, paths)],
    summary: (input) => `Edit ${input.path}`,
    async execute(input): Promise<ToolOutcome> {
      const absolute = assertSafePath(input.path, paths);
      const original = await readFile(absolute, "utf8");
      const occurrences = original.split(input.find).length - 1;
      if (occurrences === 0) {
        throw new AelvoError("EXECUTION_FAILED", "Search text not found in file");
      }
      if (occurrences > 1 && !input.replaceAll) {
        throw new AelvoError("EXECUTION_FAILED", `Search text matches ${occurrences} times; set replaceAll=true`);
      }
      const updated = input.replaceAll
        ? original.split(input.find).join(input.replace)
        : original.replace(input.find, input.replace);
      await atomicWrite(absolute, updated);
      const info = await fileStat(absolute);
      return {
        summary: `Replaced ${occurrences} occurrence(s) in ${displayPath(paths.workspaceRoot, absolute)}`,
        data: { path: displayPath(paths.workspaceRoot, absolute), replacements: occurrences },
        evidence: [
          { kind: "file_stat", detail: { path: absolute, ...info } },
          { kind: "file_hash", detail: { path: absolute, sha256: hashBuffer(updated) } },
        ],
      };
    },
    async verify(input, outcome) {
      const absolute = assertSafePath(input.path, paths);
      const hash = await hashFile(absolute);
      const recorded = outcome.evidence.find((item) => item.kind === "file_hash")?.detail["sha256"];
      if (hash !== recorded) return { ok: false, detail: "edited file hash mismatch" };
      const content = await readFile(absolute, "utf8");
      return {
        ok: content.includes(input.replace),
        detail: content.includes(input.replace) ? "replacement present" : "replacement missing after write",
      };
    },
  });

  const mkdirTool = defineTool({
    name: "create_directory",
    description: "Create a directory (and parents) inside the workspace.",
    capability: "fs.write",
    destructive: false,
    idempotent: true,
    inputSchema: MkdirInput,
    resource: (input) => displayPath(paths.workspaceRoot, assertSafePath(input.path, paths)),
    paths: (input) => [assertSafePath(input.path, paths)],
    summary: (input) => `Create directory ${input.path}`,
    async execute(input): Promise<ToolOutcome> {
      const absolute = assertSafePath(input.path, paths);
      await mkdir(absolute, { recursive: true });
      const info = await stat(absolute);
      return {
        summary: `Created ${displayPath(paths.workspaceRoot, absolute)}`,
        data: { path: displayPath(paths.workspaceRoot, absolute) },
        evidence: [{ kind: "file_stat", detail: { path: absolute, size: info.size, isDirectory: info.isDirectory() } }],
      };
    },
    async verify(input) {
      const absolute = assertSafePath(input.path, paths);
      const info = await stat(absolute).catch(() => undefined);
      return { ok: info?.isDirectory() === true, detail: info?.isDirectory() === true ? "directory exists" : "missing" };
    },
  });

  const deleteTool = defineTool({
    name: "delete_path",
    description: "Delete a file or directory. Always requires explicit approval.",
    capability: "fs.delete",
    destructive: true,
    idempotent: false,
    inputSchema: DeleteInput,
    resource: (input) => displayPath(paths.workspaceRoot, assertSafePath(input.path, paths)),
    paths: (input) => [assertSafePath(input.path, paths)],
    summary: (input) => `Delete ${input.path}`,
    async execute(input): Promise<ToolOutcome> {
      const absolute = assertSafePath(input.path, paths);
      if (absolute === paths.workspaceRoot) {
        throw new AelvoError("PATH_PROTECTED", "Refusing to delete the workspace root");
      }
      const before = await stat(absolute);
      await rm(absolute, { recursive: input.recursive, force: false });
      return {
        summary: `Deleted ${displayPath(paths.workspaceRoot, absolute)}`,
        data: { path: displayPath(paths.workspaceRoot, absolute), wasDirectory: before.isDirectory() },
        evidence: [{ kind: "file_stat", detail: { path: absolute, existed: true, wasDirectory: before.isDirectory() } }],
      };
    },
    async verify(input) {
      const absolute = assertSafePath(input.path, paths);
      const present = await exists(absolute);
      return { ok: !present, detail: present ? "path still exists" : "path removed" };
    },
  });

  const infoTool = defineTool({
    name: "file_info",
    description: "Return metadata for a path in the workspace.",
    capability: "fs.read",
    destructive: false,
    idempotent: true,
    cacheTtlMs: 2_000,
    inputSchema: MkdirInput,
    resource: (input) => displayPath(paths.workspaceRoot, assertSafePath(input.path, paths)),
    paths: (input) => [assertSafePath(input.path, paths)],
    summary: (input) => `Inspect ${input.path}`,
    async execute(input): Promise<ToolOutcome> {
      const absolute = assertSafePath(input.path, paths);
      const info = await stat(absolute);
      return {
        summary: `Inspected ${displayPath(paths.workspaceRoot, absolute)}`,
        data: {
          path: displayPath(paths.workspaceRoot, absolute),
          type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
          size: info.size,
          mtime: info.mtime.toISOString(),
        },
        evidence: [{ kind: "file_stat", detail: { path: absolute, size: info.size, mode: info.mode } }],
      };
    },
  });

  return [readTool, listTool, searchTool, writeTool, editTool, mkdirTool, deleteTool, infoTool];
}
