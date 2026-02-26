// apps/ui/src/git/analyzer.ts
// =============================================================================
// GitScope UI — Git Analyzer (Phase 1)
// - Input: in-memory FileIndex (Map<path, File> + totalBytes)
// - Output: RepoSnapshot (head/refs/reflogs/config/commits/stats)
// - Pure & deterministic: no DOM, no UI dependencies
//
// Notes:
// - Phase 1 parses only what we can access from .git directory selection.
// - Phase 2 (Agent) will replace/augment this with actual `git` command outputs.
// =============================================================================

import type {
  FileIndex,
  RepoSnapshot,
  RepoIdentity,
  GitHead,
  GitConfigSnapshot,
  ReflogEntry,
  RepoStats,
} from "../app/store";

export class GitAnalyzeError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "GitAnalyzeError";
  }
}

export interface AnalyzeOptions {
  /**
   * When true, include raw config content in snapshot (debug UI).
   * Default: false (keeps memory smaller).
   */
  includeRawConfig?: boolean;

  /**
   * Limit reflog entries per ref to avoid huge memory usage for very large reflogs.
   * Default: 10_000
   */
  maxReflogEntriesPerRef?: number;
}

export interface AnalyzeInput {
  index: FileIndex;
  identity: RepoIdentity;
  options?: AnalyzeOptions;
}

/**
 * Main entry point: parse .git contents into a strongly typed snapshot.
 */
export async function analyzeGitIndex(input: AnalyzeInput): Promise<RepoSnapshot> {
  const { index, identity } = input;
  const options: Required<AnalyzeOptions> = {
    includeRawConfig: Boolean(input.options?.includeRawConfig ?? false),
    maxReflogEntriesPerRef: clampInt(input.options?.maxReflogEntriesPerRef ?? 10_000, 100, 200_000),
  };

  try {
    // Normalize incoming paths so we can rely on consistent keys.
    const files = normalizeIndex(index);

    // Parse HEAD
    const head = await parseHead(files);

    // Parse refs: packed + loose
    const refs = await parseRefs(files);

    // Parse config (remotes)
    const config = await parseConfig(files, options.includeRawConfig);

    // Parse reflogs (logs/HEAD, logs/refs/**)
    const reflogs = await parseReflogs(files, options.maxReflogEntriesPerRef);

    // Build commit/event list (dedup + sorted)
    const commits = buildCommitList(reflogs);

    // Compute stats
    const stats = computeStats({
      totalFiles: files.byPath.size,
      totalBytes: files.totalBytes,
      refs,
      reflogs,
      commits,
    });

    return {
      identity,
      head,
      refs,
      reflogs,
      config,
      commits,
      stats,
    };
  } catch (err) {
    throw new GitAnalyzeError("Failed to analyze .git index.", err);
  }
}

/* =============================================================================
 * Index normalization
 * ========================================================================== */

function normalizeIndex(index: FileIndex): FileIndex {
  const byPath = new Map<string, File>();
  let totalBytes = 0;

  for (const [rawPath, file] of index.byPath.entries()) {
    const p = normalizeGitPath(rawPath);
    if (!p) continue;
    byPath.set(p, file);
    totalBytes += file.size || 0;
  }

  return { byPath, totalBytes };
}

/**
 * Normalizes paths inside `.git`:
 * - unify separators to "/"
 * - trim leading "./" and leading slashes
 * - collapse multiple slashes
 * - remove trailing slash
 */
export function normalizeGitPath(path: string): string {
  if (!path) return "";
  let p = path.replace(/\\/g, "/");

  // drop any leading "./"
  p = p.replace(/^\.\//, "");

  // drop leading slashes
  p = p.replace(/^\/+/, "");

  // collapse multiple slashes
  p = p.replace(/\/{2,}/g, "/");

  // remove trailing slash
  p = p.replace(/\/+$/, "");

  // Some directory pickers may include ".git/" prefix; accept both.
  if (p.startsWith(".git/")) p = p.slice(".git/".length);

  return p.trim();
}

/* =============================================================================
 * Readers
 * ========================================================================== */

async function readText(file: File): Promise<string> {
  // File.text() is widely supported in modern browsers.
  return await file.text();
}

function getFile(files: FileIndex, path: string): File | null {
  return files.byPath.get(normalizeGitPath(path)) ?? null;
}

function listPaths(files: FileIndex, prefix: string): string[] {
  const pfx = normalizeGitPath(prefix);
  const out: string[] = [];
  for (const key of files.byPath.keys()) {
    if (key === pfx || key.startsWith(pfx + "/")) out.push(key);
  }
  return out;
}

/* =============================================================================
 * HEAD parsing
 * ========================================================================== */

export async function parseHead(files: FileIndex): Promise<GitHead | null> {
  const f = getFile(files, "HEAD");
  if (!f) return null;

  const txt = (await readText(f)).trim();

  // Typical: "ref: refs/heads/main"
  const m = /^ref:\s+(.+)\s*$/i.exec(txt);
  if (m) {
    return { type: "ref", value: m[1].trim() };
  }

  // Detached head: a SHA
  const sha = txt.split(/\s+/)[0]?.trim();
  if (isSha(sha)) return { type: "detached", value: sha };

  return null;
}

/* =============================================================================
 * Refs parsing (packed-refs + loose refs)
 * ========================================================================== */

export async function parseRefs(files: FileIndex): Promise<Map<string, string>> {
  const refs = new Map<string, string>();

  // 1) packed-refs (optional)
  const packed = getFile(files, "packed-refs");
  if (packed) {
    const txt = await readText(packed);
    for (const [ref, sha] of parsePackedRefs(txt)) {
      refs.set(ref, sha);
    }
  }

  // 2) loose refs inside refs/** (and a few special ones if present)
  for (const path of files.byPath.keys()) {
    // Loose refs are usually plain text SHA files under refs/
    if (!path.startsWith("refs/")) continue;

    const f = files.byPath.get(path);
    if (!f) continue;

    const txt = (await readText(f)).trim();
    const sha = txt.split(/\s+/)[0]?.trim();
    if (isSha(sha)) refs.set(path, sha);
  }

  // 3) Some repos may have "ORIG_HEAD", "FETCH_HEAD", etc.
  // We include a small set of commonly useful special refs if present.
  const specials = ["ORIG_HEAD", "FETCH_HEAD", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REBASE_HEAD"];
  for (const sp of specials) {
    const f = getFile(files, sp);
    if (!f) continue;
    const txt = (await readText(f)).trim();
    const sha = txt.split(/\s+/)[0]?.trim();
    if (isSha(sha)) refs.set(sp, sha);
  }

  return refs;
}

/**
 * Parse packed-refs file content.
 * Format:
 *   # pack-refs with: peeled fully-peeled
 *   <sha> <ref>
 *   ^<peeledSha>   (optional line for annotated tags)
 */
export function parsePackedRefs(text: string): Array<[ref: string, sha: string]> {
  const out: Array<[string, string]> = [];
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    if (s.startsWith("^")) continue; // peeled line (tag peeled target)
    const parts = s.split(/\s+/);
    if (parts.length < 2) continue;
    const sha = parts[0];
    const ref = parts[1];
    if (isSha(sha) && ref) out.push([ref, sha]);
  }

  return out;
}

/* =============================================================================
 * Config parsing (only remotes for Phase 1)
 * ========================================================================== */

export async function parseConfig(
  files: FileIndex,
  includeRaw: boolean
): Promise<GitConfigSnapshot | null> {
  const f = getFile(files, "config");
  if (!f) return null;

  const raw = await readText(f);
  const remotes = parseGitConfigRemotes(raw);

  const snap: GitConfigSnapshot = { remotes };
  if (includeRaw) snap.raw = raw;
  return snap;
}

/**
 * Minimal INI-like parser for:
 *   [remote "origin"]
 *     url = ...
 *     fetch = ...
 *     pushurl = ...
 */
export function parseGitConfigRemotes(raw: string): Array<{ name: string; fetch?: string; push?: string }> {
  const remotes: Array<{ name: string; fetch?: string; push?: string }> = [];
  const lines = raw.split(/\r?\n/);

  let currentRemote: { name: string; fetch?: string; push?: string } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(";") || trimmed.startsWith("#")) continue;

    // Section header
    const sec = /^\[(.+?)\]$/.exec(trimmed);
    if (sec) {
      // commit previous remote
      if (currentRemote) remotes.push(currentRemote);
      currentRemote = null;

      const sectionName = sec[1]; // e.g. remote "origin"
      const remoteMatch = /^remote\s+"([^"]+)"$/i.exec(sectionName);
      if (remoteMatch) {
        currentRemote = { name: remoteMatch[1] };
      }
      continue;
    }

    // Key/value lines inside a remote section
    if (currentRemote) {
      const kv = /^([A-Za-z0-9.\-]+)\s*=\s*(.*)$/.exec(trimmed);
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      const value = kv[2];

      if (key === "url" || key === "fetch") currentRemote.fetch = value;
      if (key === "pushurl") currentRemote.push = value;
    }
  }

  if (currentRemote) remotes.push(currentRemote);

  // Deduplicate by name (keep last seen)
  const byName = new Map<string, { name: string; fetch?: string; push?: string }>();
  for (const r of remotes) byName.set(r.name, r);
  return [...byName.values()];
}

/* =============================================================================
 * Reflogs parsing
 * ========================================================================== */

export async function parseReflogs(
  files: FileIndex,
  maxEntriesPerRef: number
): Promise<Map<string, ReflogEntry[]>> {
  const out = new Map<string, ReflogEntry[]>();

  // logs/HEAD
  const headLog = getFile(files, "logs/HEAD");
  if (headLog) {
    const txt = await readText(headLog);
    out.set("HEAD", parseReflogText("HEAD", txt, maxEntriesPerRef));
  }

  // logs/refs/**
  const logPaths = listPaths(files, "logs/refs");
  for (const path of logPaths) {
    const f = files.byPath.get(path);
    if (!f) continue;
    const txt = await readText(f);

    // reflog ref name: path without "logs/" prefix -> "refs/heads/main" etc.
    const ref = path.startsWith("logs/") ? path.slice("logs/".length) : path;
    out.set(ref, parseReflogText(ref, txt, maxEntriesPerRef));
  }

  return out;
}

/**
 * Parse reflog content.
 * Line format (canonical):
 *   oldsha newsha Name <email> timestamp tz \t message
 *
 * Example:
 *   a.. b.. John Doe <john@x> 1700000000 +0100\tcheckout: moving from main to dev
 */
export function parseReflogText(ref: string, text: string, limit: number): ReflogEntry[] {
  const lines = text.split(/\r?\n/);
  const entries: ReflogEntry[] = [];

  for (const line of lines) {
    if (!line) continue;

    // Split at the first tab for message
    const tabIdx = line.indexOf("\t");
    const left = tabIdx >= 0 ? line.slice(0, tabIdx) : line;
    const msg = tabIdx >= 0 ? line.slice(tabIdx + 1) : "";

    // left should contain:
    // oldsha newsha Name <email> timestamp tz
    // Name can contain spaces, so we parse via regex.
    const re =
      /^([0-9a-f]{7,40})\s+([0-9a-f]{7,40})\s+(.+)\s+<([^>]+)>\s+(\d+)\s+([+-]\d{4})\s*$/i;
    const m = re.exec(left.trim());
    if (!m) continue;

    const oldSha = m[1];
    const newSha = m[2];
    const authorName = m[3].trim();
    const authorEmail = m[4].trim();
    const tsSeconds = safeInt(m[5]);
    const tz = m[6];

    if (!isSha(oldSha) || !isSha(newSha) || !tsSeconds) continue;

    entries.push({
      oldSha,
      newSha,
      authorName,
      authorEmail,
      ts: tsSeconds * 1000,
      tz,
      msg: msg.trim(),
      ref,
    });

    if (entries.length >= limit) break;
  }

  return entries;
}

/* =============================================================================
 * Commit/event list + stats
 * ========================================================================== */

export function buildCommitList(reflogs: Map<string, ReflogEntry[]>): ReflogEntry[] {
  // Flatten all entries and deduplicate “events”.
  // Phase 1 has only reflog; we treat each reflog line as an “event”.
  // We dedupe across refs by stable key: newSha + ts + msg + authorEmail.
  const seen = new Set<string>();
  const out: ReflogEntry[] = [];

  for (const entries of reflogs.values()) {
    for (const e of entries) {
      const key = `${e.newSha}|${e.ts}|${e.authorEmail}|${e.msg}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }

  // Sort by time (desc)
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

export function computeStats(input: {
  totalFiles: number;
  totalBytes: number;
  refs: Map<string, string>;
  reflogs: Map<string, ReflogEntry[]>;
  commits: ReflogEntry[];
}): RepoStats {
  const { totalFiles, totalBytes, refs, reflogs, commits } = input;

  let branches = 0;
  let tags = 0;
  let remotes = 0;

  for (const ref of refs.keys()) {
    if (ref.startsWith("refs/heads/")) branches++;
    else if (ref.startsWith("refs/tags/")) tags++;
    else if (ref.startsWith("refs/remotes/")) remotes++;
  }

  const authors: Record<string, number> = {};
  const eventTypes: Record<string, number> = {};

  let firstActivityTs: number | undefined = undefined;
  let lastActivityTs: number | undefined = undefined;

  for (const e of commits) {
    lastActivityTs = lastActivityTs === undefined ? e.ts : Math.max(lastActivityTs, e.ts);
    firstActivityTs = firstActivityTs === undefined ? e.ts : Math.min(firstActivityTs, e.ts);

    const authorKey = formatAuthorKey(e.authorName, e.authorEmail);
    authors[authorKey] = (authors[authorKey] ?? 0) + 1;

    const t = classifyReflogMessage(e.msg);
    eventTypes[t] = (eventTypes[t] ?? 0) + 1;
  }

  const activeDays = computeActiveDays(commits);
  const avgEventsPerDay =
    activeDays && activeDays > 0 ? round2(commits.length / activeDays) : undefined;

  // Total reflog events (before dedupe) can be used later if desired:
  // const rawEvents = [...reflogs.values()].reduce((acc, arr) => acc + arr.length, 0);

  return {
    totalFiles,
    totalBytes,

    totalRefs: refs.size,
    branches,
    tags,
    remotes,

    events: commits.length,

    firstActivityTs,
    lastActivityTs,
    activeDays,
    avgEventsPerDay,

    authors,
    eventTypes,
  };
}

function computeActiveDays(events: ReflogEntry[]): number | undefined {
  if (!events.length) return undefined;

  const days = new Set<number>();
  for (const e of events) {
    const d = new Date(e.ts);
    // Normalize to UTC date boundary for stable counting
    const key = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    days.add(key);
  }
  return days.size;
}

/**
 * Classify reflog message into a stable set of event “types”.
 * This enables Phase 1 charts (donut/heatmap) without heavy parsing.
 */
export function classifyReflogMessage(msg: string): string {
  const s = (msg || "").trim().toLowerCase();

  // Common prefixes (git uses "action:" frequently)
  if (s.startsWith("commit")) return "commit";
  if (s.startsWith("checkout")) return "checkout";
  if (s.startsWith("merge")) return "merge";
  if (s.startsWith("rebase")) return "rebase";
  if (s.startsWith("reset")) return "reset";
  if (s.startsWith("pull")) return "pull";
  if (s.startsWith("fetch")) return "fetch";
  if (s.startsWith("cherry-pick") || s.startsWith("cherrypick")) return "cherry-pick";
  if (s.startsWith("amend")) return "amend";

  // Fallback: attempt to capture "<word>:"
  const m = /^([a-z0-9\-]+)\s*:/.exec(s);
  if (m) return m[1];

  return s ? "other" : "unknown";
}

/* =============================================================================
 * Utilities
 * ========================================================================== */

function isSha(s: string | undefined | null): s is string {
  if (!s) return false;
  return /^[0-9a-f]{7,40}$/i.test(s.trim());
}

function safeInt(s: string): number {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

function clampInt(n: number, min: number, max: number): number {
  const x = Number.isFinite(n) ? Math.trunc(n) : min;
  return Math.min(max, Math.max(min, x));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatAuthorKey(name: string, email: string): string {
  const n = (name || "").trim();
  const e = (email || "").trim().toLowerCase();
  return n ? `${n} <${e}>` : `<${e}>`;
}