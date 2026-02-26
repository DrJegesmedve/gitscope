// apps/ui/src/git/indexBuilder.ts
// =============================================================================
// GitScope UI — FileIndex Builder (Phase 1)
// - Builds an in-memory FileIndex (Map<path, File>) from:
//   1) FileList / File[]  (e.g. <input webkitdirectory>, drag&drop)
//   2) FileSystemDirectoryHandle (File System Access API) for directory picking
//
// Design goals:
// - Robust path normalization (supports inputs containing ".git/" prefix)
// - Safe limits to avoid UI freezes on huge selections
// - Deterministic output ordering
//
// References (official):
// - File System Access API (MDN): https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API
// - File and FileList (MDN): https://developer.mozilla.org/en-US/docs/Web/API/File
// =============================================================================

import type { FileIndex } from "../app/store";
import { normalizeGitPath } from "./analyzer";

export class IndexBuildError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "IndexBuildError";
  }
}

export interface BuildLimits {
  /** Hard cap on number of files indexed. Default: 50_000 */
  maxFiles?: number;
  /** Hard cap on total bytes indexed. Default: 1_000_000_000 (1 GB) */
  maxTotalBytes?: number;
  /**
   * If true, accept non-.git content but still try to locate ".git/" within it.
   * This is useful if user selects a whole repo root via directory picker.
   * Default: true
   */
  allowProjectRoot?: boolean;
}

const DEFAULT_LIMITS: Required<BuildLimits> = {
  maxFiles: 50_000,
  maxTotalBytes: 1_000_000_000,
  allowProjectRoot: true,
};

/* =============================================================================
 * Public API
 * ========================================================================== */

/**
 * Build a FileIndex from a FileList or File[].
 *
 * Typical sources:
 * - <input type="file" webkitdirectory multiple>
 * - drag&drop DataTransfer.files
 *
 * We rely on webkitRelativePath when available to preserve directory structure.
 */
export function buildIndexFromFiles(
  files: FileList | File[],
  limits?: BuildLimits
): FileIndex {
  const lim = withDefaults(limits);
  const byPath = new Map<string, File>();

  // Normalize and sort for deterministic results
  const list = toArray(files).slice();
  list.sort((a, b) => getRelPath(a).localeCompare(getRelPath(b)));

  let totalBytes = 0;
  let count = 0;

  for (const f of list) {
    if (count >= lim.maxFiles) break;

    const rawRel = getRelPath(f);
    const normalized = normalizeToGitInternalPath(rawRel);
    if (!normalized) continue;

    const nextTotal = totalBytes + (f.size || 0);
    if (nextTotal > lim.maxTotalBytes) break;

    // Keep the last seen if duplicates occur (rare but possible)
    byPath.set(normalized, f);

    totalBytes = nextTotal;
    count++;
  }

  return { byPath, totalBytes };
}

/**
 * Build a FileIndex from a directory handle (File System Access API).
 *
 * Supports:
 * - Picking the `.git` directory directly (best)
 * - Picking the repo root directory (if allowProjectRoot=true),
 *   in which case we attempt to locate a ".git" child folder first.
 */
export async function buildIndexFromDirectoryHandle(
  handle: FileSystemDirectoryHandle,
  limits?: BuildLimits
): Promise<FileIndex> {
  const lim = withDefaults(limits);

  try {
    const gitHandle = lim.allowProjectRoot ? await locateGitDir(handle) : handle;
    if (!gitHandle) {
      throw new IndexBuildError(
        'No ".git" directory found. Please select the ".git" folder.'
      );
    }

    const byPath = new Map<string, File>();
    let totalBytes = 0;
    let count = 0;

    // Collect file entries in a stable order (deterministic)
    const allFiles: Array<{ path: string; file: File }> = [];
    await walkDir(gitHandle, "", async (path, file) => {
      allFiles.push({ path, file });
    });

    allFiles.sort((a, b) => a.path.localeCompare(b.path));

    for (const item of allFiles) {
      if (count >= lim.maxFiles) break;

      // item.path is relative to selected git dir handle already
      const normalized = normalizeGitPath(item.path);
      if (!normalized) continue;

      const nextTotal = totalBytes + (item.file.size || 0);
      if (nextTotal > lim.maxTotalBytes) break;

      byPath.set(normalized, item.file);
      totalBytes = nextTotal;
      count++;
    }

    return { byPath, totalBytes };
  } catch (err) {
    if (err instanceof IndexBuildError) throw err;
    throw new IndexBuildError("Failed to build FileIndex from directory handle.", err);
  }
}

/* =============================================================================
 * Internal helpers
 * ========================================================================== */

function withDefaults(limits?: BuildLimits): Required<BuildLimits> {
  return {
    maxFiles: limits?.maxFiles ?? DEFAULT_LIMITS.maxFiles,
    maxTotalBytes: limits?.maxTotalBytes ?? DEFAULT_LIMITS.maxTotalBytes,
    allowProjectRoot: limits?.allowProjectRoot ?? DEFAULT_LIMITS.allowProjectRoot,
  };
}

function toArray(files: FileList | File[]): File[] {
  // FileList is array-like but not an array.
  if (Array.isArray(files)) return files;
  const out: File[] = [];
  for (let i = 0; i < files.length; i++) out.push(files.item(i) as File);
  return out;
}

function getRelPath(f: File): string {
  // webkitRelativePath exists in Chromium-based browsers for directory uploads
  const anyFile = f as unknown as { webkitRelativePath?: string; name: string };
  return (anyFile.webkitRelativePath && anyFile.webkitRelativePath.trim()) || f.name;
}

/**
 * Convert an arbitrary relative path (from file input) into a `.git`-internal path:
 * - If path contains "/.git/" or starts with ".git/", strip prefix up to ".git/"
 * - Otherwise assume it is already relative to `.git/`
 * - Then normalize with normalizeGitPath()
 */
function normalizeToGitInternalPath(relPath: string): string {
  if (!relPath) return "";

  const p = relPath.replace(/\\/g, "/");

  // Common cases:
  // - ".git/HEAD"
  // - "my-repo/.git/HEAD"
  // - "HEAD" (if user selected .git directly somehow)
  const marker = "/.git/";
  const idx = p.indexOf(marker);
  let sliced = p;

  if (idx >= 0) {
    sliced = p.slice(idx + marker.length); // after "/.git/"
  } else if (p.startsWith(".git/")) {
    sliced = p.slice(".git/".length);
  }

  return normalizeGitPath(sliced);
}

/**
 * Attempt to locate the `.git` directory.
 * - If selected handle is already ".git" => return it
 * - Otherwise find a child directory named ".git"
 */
async function locateGitDir(
  root: FileSystemDirectoryHandle
): Promise<FileSystemDirectoryHandle | null> {
  // If the handle itself is ".git"
  if ((root as unknown as { name?: string }).name === ".git") return root;

  // Try to find child ".git"
  try {
    // `getDirectoryHandle` throws if not found unless create:true
    const git = await root.getDirectoryHandle(".git", { create: false });
    return git;
  } catch {
    return null;
  }
}

/**
 * Recursively walk a directory handle and call `onFile` for each file.
 * `basePath` is a relative path prefix within that directory.
 */
async function walkDir(
  dir: FileSystemDirectoryHandle,
  basePath: string,
  onFile: (relativePath: string, file: File) => Promise<void>
): Promise<void> {
  // Directory iteration is async iterable in modern browsers
  // We keep this guarded to prevent TS lib mismatches from breaking builds.
  const entries = dir.entries?.bind(dir);
  if (!entries) {
    throw new IndexBuildError(
      "Directory iteration is not supported in this browser environment."
    );
  }

  for await (const [name, handle] of entries() as AsyncIterable<
    [string, FileSystemHandle]
  >) {
    const rel = basePath ? `${basePath}/${name}` : name;

    if (handle.kind === "file") {
      const fileHandle = handle as FileSystemFileHandle;
      const file = await fileHandle.getFile();
      await onFile(rel, file);
    } else if (handle.kind === "directory") {
      const subDir = handle as FileSystemDirectoryHandle;
      await walkDir(subDir, rel, onFile);
    }
  }
}