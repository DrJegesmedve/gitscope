// apps/ui/src/app/loaders.ts
// =============================================================================
// GitScope UI — Loaders (Phase 1)
// - Orchestrates loading from:
//   1) FileList/File[] (webkitdirectory, drag&drop)
//   2) FileSystemDirectoryHandle (File System Access API)
// - Builds FileIndex, analyzes it into RepoSnapshot, and updates the store
// - Centralized error handling & UX-friendly status messaging
//
// Official references:
// - File System Access API (MDN): https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API
// - DataTransfer / FileList (MDN): https://developer.mozilla.org/en-US/docs/Web/API/DataTransfer/files
// =============================================================================

import type { Store, UIState, Action, RepoIdentity } from "./store";
import { actions } from "./store";
import { analyzeGitIndex, GitAnalyzeError } from "../git/analyzer";
import {
  buildIndexFromFiles,
  buildIndexFromDirectoryHandle,
  IndexBuildError,
  type BuildLimits,
} from "../git/indexBuilder";

export interface LoaderDeps {
  store: Store<UIState, Action>;
}

export interface LoadResult {
  ok: boolean;
  /** present only when ok=true */
  repoDisplayName?: string;
  /** present only when ok=false */
  errorMessage?: string;
}

/**
 * Defaults tuned for Phase 1 (browser-only).
 * You can override per call.
 */
export const DEFAULT_BUILD_LIMITS: Required<BuildLimits> = {
  maxFiles: 50_000,
  maxTotalBytes: 1_000_000_000,
  allowProjectRoot: true,
};

/* =============================================================================
 * Public API
 * ========================================================================== */

/**
 * Load from FileList / File[] selection.
 * Typical: <input type="file" webkitdirectory multiple />
 */
export async function loadFromFiles(
  deps: LoaderDeps,
  files: FileList | File[],
  opts?: {
    displayName?: string;
    limits?: BuildLimits;
    includeRawConfig?: boolean;
  }
): Promise<LoadResult> {
  const { store } = deps;
  const limits = { ...DEFAULT_BUILD_LIMITS, ...(opts?.limits ?? {}) };

  try {
    beginLoading(store, "Fájlok beolvasása…");

    const index = buildIndexFromFiles(files, limits);
    if (index.byPath.size === 0) {
      failLoading(store, "Nem találtam beolvasható .git fájlokat.");
      return { ok: false, errorMessage: "No .git files found." };
    }

    store.dispatch(actions.setFilesIndex(index));

    const identity: RepoIdentity = {
      displayName: opts?.displayName ?? guessDisplayNameFromFiles(files) ?? ".git (files)",
      source: "file-input",
      refreshedAt: Date.now(),
    };

    store.dispatch(actions.setMessage({ kind: "muted", text: "Elemzés folyamatban…" }));

    const snapshot = await analyzeGitIndex({
      index,
      identity,
      options: { includeRawConfig: Boolean(opts?.includeRawConfig ?? false) },
    });

    store.dispatch(actions.setRepoSnapshot(snapshot));
    store.dispatch(actions.setStatus("ready"));
    store.dispatch(
      actions.setMessage({
        kind: "ok",
        text: `Kész. ${snapshot.stats.totalFiles} fájl, ${snapshot.stats.events} esemény.`,
      })
    );

    // Optional UX: if user is on empty view, jump to dashboard
    store.dispatch(actions.setView("dashboard"));

    return { ok: true, repoDisplayName: identity.displayName };
  } catch (err) {
    const msg = formatLoaderError(err);
    failLoading(store, msg);
    return { ok: false, errorMessage: msg };
  }
}

/**
 * Load from a directory handle (recommended for Phase 1 live tracking).
 *
 * If the user selected repo root, we attempt to locate ".git" inside (allowProjectRoot=true).
 * If they selected ".git" directly, it works as-is.
 */
export async function loadFromDirectoryHandle(
  deps: LoaderDeps,
  handle: FileSystemDirectoryHandle,
  opts?: {
    displayName?: string;
    limits?: BuildLimits;
    includeRawConfig?: boolean;
  }
): Promise<LoadResult> {
  const { store } = deps;
  const limits = { ...DEFAULT_BUILD_LIMITS, ...(opts?.limits ?? {}) };

  try {
    beginLoading(store, "Mappa beolvasása…");

    const index = await buildIndexFromDirectoryHandle(handle, limits);
    if (index.byPath.size === 0) {
      failLoading(store, "Nem találtam beolvasható .git fájlokat ebben a mappában.");
      return { ok: false, errorMessage: "No .git files found in directory handle." };
    }

    store.dispatch(actions.setFilesIndex(index));

    const identity: RepoIdentity = {
      displayName: opts?.displayName ?? guessDisplayNameFromHandle(handle) ?? ".git (dir)",
      source: "dir-handle",
      refreshedAt: Date.now(),
    };

    store.dispatch(actions.setMessage({ kind: "muted", text: "Elemzés folyamatban…" }));

    const snapshot = await analyzeGitIndex({
      index,
      identity,
      options: { includeRawConfig: Boolean(opts?.includeRawConfig ?? false) },
    });

    store.dispatch(actions.setRepoSnapshot(snapshot));
    store.dispatch(actions.setStatus("ready"));
    store.dispatch(
      actions.setMessage({
        kind: "ok",
        text: `Kész. ${snapshot.stats.totalFiles} fájl, ${snapshot.stats.events} esemény.`,
      })
    );

    store.dispatch(actions.setView("dashboard"));

    return { ok: true, repoDisplayName: identity.displayName };
  } catch (err) {
    const msg = formatLoaderError(err);
    failLoading(store, msg);
    return { ok: false, errorMessage: msg };
  }
}

/**
 * Phase 1 "live refresh" tick:
 * - Only intended when repo source is "dir-handle"
 * - Rebuild index from the same handle and re-analyze
 *
 * You call this from a polling loop in `features/live/liveTracking.ts`.
 */
export async function refreshFromDirectoryHandle(
  deps: LoaderDeps,
  handle: FileSystemDirectoryHandle,
  opts?: {
    limits?: BuildLimits;
    includeRawConfig?: boolean;
    /** if true, keep user's status message unless error occurs */
    silent?: boolean;
  }
): Promise<LoadResult> {
  const { store } = deps;
  const limits = { ...DEFAULT_BUILD_LIMITS, ...(opts?.limits ?? {}) };
  const silent = Boolean(opts?.silent ?? true);

  try {
    if (!silent) {
      store.dispatch(actions.setStatus("loading"));
      store.dispatch(actions.setMessage({ kind: "muted", text: "Frissítés…" }));
    }

    const index = await buildIndexFromDirectoryHandle(handle, limits);
    store.dispatch(actions.setFilesIndex(index));

    const prev = store.getState().repo;
    const identity: RepoIdentity = {
      displayName: prev?.identity.displayName ?? guessDisplayNameFromHandle(handle) ?? ".git (dir)",
      source: "dir-handle",
      refreshedAt: Date.now(),
    };

    const snapshot = await analyzeGitIndex({
      index,
      identity,
      options: { includeRawConfig: Boolean(opts?.includeRawConfig ?? false) },
    });

    store.dispatch(actions.setRepoSnapshot(snapshot));
    store.dispatch(actions.setStatus("ready"));
    store.dispatch(actions.liveTick(Date.now()));

    if (!silent) {
      store.dispatch(
        actions.setMessage({
          kind: "ok",
          text: `Frissítve. ${snapshot.stats.totalFiles} fájl, ${snapshot.stats.events} esemény.`,
        })
      );
    }

    return { ok: true, repoDisplayName: identity.displayName };
  } catch (err) {
    // On live refresh error, do not destroy existing snapshot; just report.
    const msg = formatLoaderError(err);
    store.dispatch(actions.setStatus("error"));
    store.dispatch(actions.setMessage({ kind: "error", text: `Frissítés hiba: ${msg}` }));
    return { ok: false, errorMessage: msg };
  }
}

/**
 * Reset UI state to "idle", clearing snapshot + file index.
 * Useful for "Unload project" button.
 */
export function unloadProject(deps: LoaderDeps): void {
  const { store } = deps;
  store.dispatch(actions.setRepoSnapshot(null));
  store.dispatch(actions.setFilesIndex({ byPath: new Map(), totalBytes: 0 }));
  store.dispatch(actions.setStatus("idle"));
  store.dispatch(actions.setMessage({ kind: "muted", text: "Projekt kiürítve." }));
}

/* =============================================================================
 * Internal helpers
 * ========================================================================== */

function beginLoading(store: Store<UIState, Action>, text: string): void {
  store.dispatch(actions.setStatus("loading"));
  store.dispatch(actions.setMessage({ kind: "muted", text }));
}

function failLoading(store: Store<UIState, Action>, msg: string): void {
  store.dispatch(actions.setStatus("error"));
  store.dispatch(actions.setMessage({ kind: "error", text: msg }));
}

/**
 * Error → user-facing text (hungarian UI).
 * Keeps messages short and actionable.
 */
function formatLoaderError(err: unknown): string {
  if (err instanceof IndexBuildError) return err.message;
  if (err instanceof GitAnalyzeError) return err.message;

  if (err instanceof DOMException) {
    // Common FS Access errors: NotAllowedError, SecurityError, AbortError
    if (err.name === "NotAllowedError") return "A hozzáférés meg lett tagadva (NotAllowedError).";
    if (err.name === "SecurityError") return "Biztonsági hiba (SecurityError).";
    if (err.name === "AbortError") return "A művelet megszakítva (AbortError).";
    return `${err.name}: ${err.message}`;
  }

  if (err instanceof Error) return err.message || "Ismeretlen hiba.";
  return "Ismeretlen hiba.";
}

function guessDisplayNameFromFiles(files: FileList | File[]): string | null {
  const arr = Array.isArray(files) ? files : fileListToArray(files);
  // Try to extract repo name from webkitRelativePath: "<repo>/.git/HEAD"
  for (const f of arr) {
    const anyFile = f as unknown as { webkitRelativePath?: string };
    const rel = anyFile.webkitRelativePath || "";
    const norm = rel.replace(/\\/g, "/");
    const marker = "/.git/";
    const idx = norm.indexOf(marker);
    if (idx > 0) {
      const prefix = norm.slice(0, idx);
      const last = prefix.split("/").filter(Boolean).pop();
      if (last) return `${last}/.git`;
    }
  }
  return null;
}

function guessDisplayNameFromHandle(handle: FileSystemDirectoryHandle): string | null {
  // If user selects ".git", handle.name is ".git". If they select repo root, it's repo name.
  const name = (handle as unknown as { name?: string }).name;
  if (!name) return null;
  return name === ".git" ? ".git" : `${name} (dir)`;
}

function fileListToArray(list: FileList): File[] {
  const out: File[] = [];
  for (let i = 0; i < list.length; i++) {
    const f = list.item(i);
    if (f) out.push(f);
  }
  return out;
}

function clampInt(n: number, min: number, max: number): number {
  const x = Number.isFinite(n) ? Math.trunc(n) : min;
  return Math.min(max, Math.max(min, x));
}