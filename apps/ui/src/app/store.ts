// apps/ui/src/app/store.ts
// =============================================================================
// GitScope UI — Core Store (Phase 1)
// - Central, typed, immutable state container
// - Selector-based subscriptions to avoid unnecessary re-renders
// - Action creators for consistent state transitions
// =============================================================================

export type Theme = "dark" | "light";

export type ViewId =
  | "dashboard"
  | "timeline"
  | "graph"
  | "stats"
  | "files"
  | "refs"
  | "objects"
  | "config"
  | "commands"
  | "groups";

export type LoadStatus = "idle" | "loading" | "ready" | "error";

/** Minimal identity; in Phase 2 the Agent will provide absolute paths & repo roots. */
export interface RepoIdentity {
  /** UI display name (e.g. ".git", "my-repo/.git") */
  displayName: string;
  /** Whether data comes from file input or directory handle polling */
  source: "file-input" | "dir-handle";
  /** When last refresh happened */
  refreshedAt: number;
}

export interface GitHeadRef {
  type: "ref";
  value: string; // e.g. "refs/heads/main"
}
export interface GitHeadDetached {
  type: "detached";
  value: string; // SHA
}
export type GitHead = GitHeadRef | GitHeadDetached;

export interface GitRemote {
  name: string; // origin
  fetch?: string; // url
  push?: string; // url
}

export interface GitConfigSnapshot {
  remotes: GitRemote[];
  raw?: string; // optional, for display/debug
}

/**
 * A single entry from reflog parsing.
 * Mirrors the concept of:
 *   <oldsha> <newsha> <author> <timestamp> <tz>\t<msg>
 */
export interface ReflogEntry {
  oldSha: string;
  newSha: string;
  authorName: string;
  authorEmail: string;
  ts: number; // epoch millis
  tz: string; // "+0100"
  msg: string;
  /** Which reflog the entry belongs to (e.g. "HEAD" or "refs/heads/main") */
  ref: string;
}

export interface RepoStats {
  totalFiles: number;
  totalBytes: number;

  totalRefs: number;
  branches: number;
  tags: number;
  remotes: number;

  /** number of deduplicated reflog events */
  events: number;

  /** derived */
  firstActivityTs?: number;
  lastActivityTs?: number;
  activeDays?: number;
  avgEventsPerDay?: number;

  /** maps for UI */
  authors: Record<string, number>;
  eventTypes: Record<string, number>;
}

export interface RepoSnapshot {
  identity: RepoIdentity;

  // Raw Git-ish signals
  head: GitHead | null;
  refs: Map<string, string>; // ref path -> sha
  reflogs: Map<string, ReflogEntry[]>; // ref -> entries
  config: GitConfigSnapshot | null;

  // Derived
  commits: ReflogEntry[]; // deduplicated + sorted desc by ts
  stats: RepoStats;
}

/**
 * Files are *not* serializable and should stay in-memory only.
 * Phase 1 UI parses .git from FileList / directory handle.
 */
export interface FileIndex {
  /** normalized path within .git (e.g. "HEAD", "refs/heads/main") */
  byPath: Map<string, File>;
  totalBytes: number;
}

export interface LiveTrackingState {
  enabled: boolean;
  /** UI-only indicator; in Phase 1 we poll from directory handle */
  pollIntervalMs: number;
  lastTickAt?: number;
}

export interface UIState {
  theme: Theme;
  view: ViewId;
  status: LoadStatus;

  /** For status banner / toasts */
  message?: { kind: "muted" | "ok" | "warn" | "error"; text: string };

  /** Current search/filter inputs (Phase 1 UI-only) */
  query: {
    timelineSearch: string;
    timelineAuthor: string;
    timelineAction: string;
    timelineRef: string;

    fileSearch: string;
  };

  /** Pagination */
  timeline: {
    page: number;
    perPage: number;
  };

  /** In-memory artifacts */
  files: FileIndex;

  /** Parsed snapshot; null until loaded */
  repo: RepoSnapshot | null;

  /** Live tracking UI state (directory handle polling in Phase 1) */
  live: LiveTrackingState;
}

export type Action =
  | { type: "ui/setTheme"; theme: Theme }
  | { type: "ui/setView"; view: ViewId }
  | { type: "ui/setStatus"; status: LoadStatus }
  | { type: "ui/setMessage"; message?: UIState["message"] }
  | { type: "ui/setQuery"; patch: Partial<UIState["query"]> }
  | { type: "ui/setTimelinePage"; page: number }
  | { type: "ui/setTimelinePerPage"; perPage: number }
  | { type: "files/setIndex"; index: FileIndex }
  | { type: "repo/setSnapshot"; snapshot: RepoSnapshot | null }
  | { type: "live/setEnabled"; enabled: boolean }
  | { type: "live/setPollInterval"; pollIntervalMs: number }
  | { type: "live/tick"; at: number };

export interface Store<TState, TAction> {
  getState(): Readonly<TState>;
  dispatch(action: TAction): void;

  /**
   * Subscribe to a slice of state.
   * - selector decides what the subscriber cares about
   * - equality decides whether to notify
   */
  subscribe<TSel>(
    selector: (s: Readonly<TState>) => TSel,
    onChange: (selected: TSel, prev: TSel) => void,
    options?: {
      equality?: (a: TSel, b: TSel) => boolean;
      fireImmediately?: boolean;
    }
  ): () => void;
}

/** -------------------------------------------------------------------------- */
/** Defaults                                                                   */
/** -------------------------------------------------------------------------- */

export function createInitialState(): UIState {
  return {
    theme: "dark",
    view: "dashboard",
    status: "idle",
    message: { kind: "muted", text: "Válassz egy .git mappát az elemzéshez." },

    query: {
      timelineSearch: "",
      timelineAuthor: "",
      timelineAction: "",
      timelineRef: "",
      fileSearch: "",
    },

    timeline: {
      page: 0,
      perPage: 25,
    },

    files: {
      byPath: new Map<string, File>(),
      totalBytes: 0,
    },

    repo: null,

    live: {
      enabled: false,
      pollIntervalMs: 3000,
    },
  };
}

/** -------------------------------------------------------------------------- */
/** Reducer                                                                    */
/** -------------------------------------------------------------------------- */

export function reducer(state: UIState, action: Action): UIState {
  switch (action.type) {
    case "ui/setTheme":
      return { ...state, theme: action.theme };

    case "ui/setView":
      return { ...state, view: action.view };

    case "ui/setStatus":
      return { ...state, status: action.status };

    case "ui/setMessage":
      return { ...state, message: action.message };

    case "ui/setQuery":
      return { ...state, query: { ...state.query, ...action.patch } };

    case "ui/setTimelinePage":
      return { ...state, timeline: { ...state.timeline, page: Math.max(0, action.page) } };

    case "ui/setTimelinePerPage":
      return {
        ...state,
        timeline: { ...state.timeline, perPage: clampInt(action.perPage, 5, 250), page: 0 },
      };

    case "files/setIndex":
      // keep repo snapshot intact, but update derived stats can be done elsewhere
      return { ...state, files: action.index };

    case "repo/setSnapshot":
      return { ...state, repo: action.snapshot };

    case "live/setEnabled":
      return { ...state, live: { ...state.live, enabled: action.enabled } };

    case "live/setPollInterval":
      return {
        ...state,
        live: { ...state.live, pollIntervalMs: clampInt(action.pollIntervalMs, 500, 60_000) },
      };

    case "live/tick":
      return { ...state, live: { ...state.live, lastTickAt: action.at } };

    default: {
      // Exhaustiveness guard:
      const _never: never = action;
      return state;
    }
  }
}

/** -------------------------------------------------------------------------- */
/** Store implementation                                                       */
/** -------------------------------------------------------------------------- */

export function createStore(
  initial: UIState = createInitialState(),
  reduce: (s: UIState, a: Action) => UIState = reducer
): Store<UIState, Action> {
  let state: UIState = initial;

  type Sub = {
    selector: (s: Readonly<UIState>) => unknown;
    onChange: (selected: unknown, prev: unknown) => void;
    equality: (a: unknown, b: unknown) => boolean;
    lastSelected: unknown;
  };

  const subs = new Set<Sub>();

  function getState(): Readonly<UIState> {
    return state;
  }

  function dispatch(action: Action): void {
    const prevState = state;
    const nextState = reduce(prevState, action);

    // If nothing changed (reference equality), skip notifications.
    if (nextState === prevState) return;

    state = nextState;

    // Notify subscribers based on selector+equality.
    for (const sub of subs) {
      const nextSel = sub.selector(state);
      if (!sub.equality(nextSel, sub.lastSelected)) {
        const prevSel = sub.lastSelected;
        sub.lastSelected = safeClone(nextSel);
        sub.onChange(nextSel, prevSel);
      }
    }
  }

  function subscribe<TSel>(
    selector: (s: Readonly<UIState>) => TSel,
    onChange: (selected: TSel, prev: TSel) => void,
    options?: {
      equality?: (a: TSel, b: TSel) => boolean;
      fireImmediately?: boolean;
    }
  ): () => void {
    const equality = (options?.equality ?? Object.is) as (a: unknown, b: unknown) => boolean;

    const initialSelected = selector(state);
    const sub: Sub = {
      selector: selector as (s: Readonly<UIState>) => unknown,
      onChange: onChange as (selected: unknown, prev: unknown) => void,
      equality,
      lastSelected: safeClone(initialSelected),
    };

    subs.add(sub);

    if (options?.fireImmediately) {
      onChange(initialSelected, initialSelected);
    }

    return () => {
      subs.delete(sub);
    };
  }

  return { getState, dispatch, subscribe };
}

/** -------------------------------------------------------------------------- */
/** Action creators (single source of truth)                                   */
/** -------------------------------------------------------------------------- */

export const actions = {
  setTheme: (theme: Theme): Action => ({ type: "ui/setTheme", theme }),
  setView: (view: ViewId): Action => ({ type: "ui/setView", view }),
  setStatus: (status: LoadStatus): Action => ({ type: "ui/setStatus", status }),
  setMessage: (message?: UIState["message"]): Action => ({ type: "ui/setMessage", message }),
  patchQuery: (patch: Partial<UIState["query"]>): Action => ({ type: "ui/setQuery", patch }),

  setTimelinePage: (page: number): Action => ({ type: "ui/setTimelinePage", page }),
  setTimelinePerPage: (perPage: number): Action => ({ type: "ui/setTimelinePerPage", perPage }),

  setFilesIndex: (index: FileIndex): Action => ({ type: "files/setIndex", index }),
  setRepoSnapshot: (snapshot: RepoSnapshot | null): Action => ({ type: "repo/setSnapshot", snapshot }),

  setLiveEnabled: (enabled: boolean): Action => ({ type: "live/setEnabled", enabled }),
  setLivePollInterval: (pollIntervalMs: number): Action => ({
    type: "live/setPollInterval",
    pollIntervalMs,
  }),
  liveTick: (at: number): Action => ({ type: "live/tick", at }),
} as const;

/** -------------------------------------------------------------------------- */
/** Selectors (keep UI modules clean)                                           */
/** -------------------------------------------------------------------------- */

export const selectors = {
  theme: (s: Readonly<UIState>) => s.theme,
  view: (s: Readonly<UIState>) => s.view,
  status: (s: Readonly<UIState>) => s.status,
  message: (s: Readonly<UIState>) => s.message,

  repo: (s: Readonly<UIState>) => s.repo,
  repoStats: (s: Readonly<UIState>) => s.repo?.stats ?? null,
  commits: (s: Readonly<UIState>) => s.repo?.commits ?? [],
  refs: (s: Readonly<UIState>) => s.repo?.refs ?? null,

  filesCount: (s: Readonly<UIState>) => s.files.byPath.size,
  filesBytes: (s: Readonly<UIState>) => s.files.totalBytes,

  liveEnabled: (s: Readonly<UIState>) => s.live.enabled,
  livePollMs: (s: Readonly<UIState>) => s.live.pollIntervalMs,

  query: (s: Readonly<UIState>) => s.query,
  timelinePaging: (s: Readonly<UIState>) => s.timeline,
} as const;

/** -------------------------------------------------------------------------- */
/** Helpers                                                                     */
/** -------------------------------------------------------------------------- */

function clampInt(n: number, min: number, max: number): number {
  const x = Number.isFinite(n) ? Math.trunc(n) : min;
  return Math.min(max, Math.max(min, x));
}

/**
 * We clone selected values stored in subscription slots to avoid accidental
 * external mutation breaking equality checks.
 *
 * NOTE: Files, Maps, Sets, DOM nodes are not clonable by structuredClone;
 * we fall back to identity for those.
 */
function safeClone<T>(value: T): T {
  try {
    // @ts-ignore - lib.dom includes structuredClone in modern TS configs
    if (typeof structuredClone === "function") return structuredClone(value);
  } catch {
    // ignore
  }
  return value;
}