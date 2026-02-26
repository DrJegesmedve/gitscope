// apps/ui/src/main.ts
// =============================================================================
// GitScope UI — App Entry (Phase 1)
// - Creates store
// - Wires DOM events (file input, directory picker, view navigation)
// - Initializes live tracking controller
// - Minimal rendering layer (no framework)
// =============================================================================

import { createStore, actions, selectors, type UIState } from "./app/store";
import { loadFromFiles, loadFromDirectoryHandle, unloadProject } from "./app/loaders";
import { createLiveTrackingController } from "./features/live/liveTracking";
import { bootstrapViews } from "./app/bootstrapViews";

// -----------------------------
// Bootstrap
// -----------------------------

const store = createStore();

bootstrapViews(store);

(window as any).__gitscopeStore = store;

// We keep the directory handle in memory only (NOT in store).
let activeDirHandle: FileSystemDirectoryHandle | null = null;

// Live tracking controller (polling loop)
const live = createLiveTrackingController({
  store,
  getDirectoryHandle: () => activeDirHandle,
});

// Start observing store changes for live control
live.start();

// Wire DOM
wireDom();

// Initial render
renderApp(store.getState());

// Subscribe to changes for rendering (selector-based)
store.subscribe(
  (s) => ({
    theme: selectors.theme(s),
    view: selectors.view(s),
    status: selectors.status(s),
    message: selectors.message(s),
    repoStats: selectors.repoStats(s),
    filesCount: selectors.filesCount(s),
    filesBytes: selectors.filesBytes(s),
    liveEnabled: selectors.liveEnabled(s),
    livePollMs: selectors.livePollMs(s),
  }),
  () => renderApp(store.getState()),
  { fireImmediately: false }
);

// -----------------------------
// DOM Wiring
// -----------------------------

function wireDom(): void {
  // File input (webkitdirectory)
  const fileInput = byId<HTMLInputElement>("gitFilesInput");
  if (fileInput) {
    fileInput.addEventListener("change", async () => {
      const files = fileInput.files;
      if (!files || files.length === 0) return;

      // Loading from file input means no directory handle => disable live source
      activeDirHandle = null;
      store.dispatch(actions.setLiveEnabled(false));

      await loadFromFiles({ store }, files, { displayName: ".git (files)" });

      // Reset input so re-selecting same dir triggers change again
      fileInput.value = "";
    });
  }

  // Directory picker (File System Access API)
  const pickDirBtn = byId<HTMLButtonElement>("pickGitDirBtn");
  if (pickDirBtn) {
    pickDirBtn.addEventListener("click", async () => {
      try {
        const dir = await pickDirectoryHandle();
        if (!dir) return;

        activeDirHandle = dir;

        // Load from directory handle
        await loadFromDirectoryHandle({ store }, dir, {
          displayName: dir.name === ".git" ? ".git" : `${dir.name} (dir)`,
        });

        // If user enabled live, controller will start via subscription logic.
      } catch (err) {
        const msg = formatDomError(err);
        store.dispatch(actions.setStatus("error"));
        store.dispatch(actions.setMessage({ kind: "error", text: msg }));
      }
    });
  }

  // Unload project
  const unloadBtn = byId<HTMLButtonElement>("unloadBtn");
  if (unloadBtn) {
    unloadBtn.addEventListener("click", () => {
      activeDirHandle = null;
      store.dispatch(actions.setLiveEnabled(false));
      unloadProject({ store });
    });
  }

  // Live toggle
  const liveToggle = byId<HTMLInputElement>("liveToggle");
  if (liveToggle) {
    liveToggle.addEventListener("change", () => {
      store.dispatch(actions.setLiveEnabled(Boolean(liveToggle.checked)));
    });

    // Keep toggle in sync if state changes elsewhere
    store.subscribe(
      (s) => selectors.liveEnabled(s),
      (enabled) => {
        liveToggle.checked = enabled;
      },
      { fireImmediately: true }
    );
  }

  // Live interval input
  const pollInput = byId<HTMLInputElement>("livePollMs");
  if (pollInput) {
    pollInput.addEventListener("change", () => {
      const n = Number.parseInt(pollInput.value, 10);
      if (!Number.isFinite(n)) return;
      store.dispatch(actions.setLivePollInterval(n));
    });

    store.subscribe(
      (s) => selectors.livePollMs(s),
      (ms) => {
        // avoid cursor jump if user is typing: only set if different
        if (pollInput.value !== String(ms)) pollInput.value = String(ms);
      },
      { fireImmediately: true }
    );
  }

  // Theme toggle (optional)
  const themeToggle = byId<HTMLInputElement>("themeToggle");
  if (themeToggle) {
    themeToggle.addEventListener("change", () => {
      store.dispatch(actions.setTheme(themeToggle.checked ? "light" : "dark"));
    });

    store.subscribe(
      (s) => selectors.theme(s),
      (theme) => {
        themeToggle.checked = theme === "light";
      },
      { fireImmediately: true }
    );
  }

  // View navigation buttons: [data-view="dashboard"] etc.
  document.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;

    const btn = target.closest<HTMLElement>("[data-view]");
    if (!btn) return;

    const view = btn.getAttribute("data-view");
    if (!view) return;

    // Type-safe check: only accept known view ids
    if (isViewId(view)) store.dispatch(actions.setView(view));
  });
}

// -----------------------------
// Rendering (minimal, safe)
// -----------------------------

function renderApp(state: Readonly<UIState>): void {
  applyTheme(state.theme);

  // Status message/banner
  const msgEl = byId<HTMLElement>("statusMessage");
  if (msgEl) {
    const m = state.message;
    msgEl.textContent = m?.text ?? "";
    msgEl.dataset.kind = m?.kind ?? "muted";
  }

  // Basic stats
  setText("repoName", state.repo?.identity.displayName ?? "—");
  setText("repoStatus", state.status);
  setText("filesCount", String(state.files.byPath.size));
  setText("filesBytes", formatBytes(state.files.totalBytes));

  const stats = state.repo?.stats ?? null;
  setText("eventsCount", stats ? String(stats.events) : "—");
  setText("refsCount", stats ? String(stats.totalRefs) : "—");
  setText("branchesCount", stats ? String(stats.branches) : "—");
  setText("tagsCount", stats ? String(stats.tags) : "—");
  setText("remotesCount", stats ? String(stats.remotes) : "—");

  // View switching: elements like <section data-view-panel="dashboard">
  const panels = document.querySelectorAll<HTMLElement>("[data-view-panel]");
  for (const p of panels) {
    const id = p.getAttribute("data-view-panel");
    p.hidden = id !== state.view;
  }

  // Enable/disable live controls based on source availability
  const liveSupported = Boolean(activeDirHandle) && state.repo?.identity.source === "dir-handle";
  const liveToggle = byId<HTMLInputElement>("liveToggle");
  if (liveToggle) {
    liveToggle.disabled = !liveSupported;
    if (!liveSupported && liveToggle.checked) {
      // keep UI consistent if user loaded via files
      liveToggle.checked = false;
    }
  }
  const pollInput = byId<HTMLInputElement>("livePollMs");
  if (pollInput) pollInput.disabled = !liveSupported;

  // Optional: highlight active nav button
  const navButtons = document.querySelectorAll<HTMLElement>("[data-view]");
  for (const b of navButtons) {
    const v = b.getAttribute("data-view");
    b.toggleAttribute("data-active", v === state.view);
  }
}

// -----------------------------
// Helpers
// -----------------------------

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function setText(id: string, text: string): void {
  const el = byId<HTMLElement>(id);
  if (el) el.textContent = text;
}

function applyTheme(theme: "dark" | "light"): void {
  document.documentElement.dataset.theme = theme;
}

function formatBytes(bytes: number): string {
  const n = Number.isFinite(bytes) ? bytes : 0;
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

function formatDomError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError") return "A mappa kiválasztása el lett utasítva (NotAllowedError).";
    if (err.name === "AbortError") return "A mappa kiválasztása megszakadt (AbortError).";
    return `${err.name}: ${err.message}`;
  }
  if (err instanceof Error) return err.message || "Ismeretlen hiba.";
  return "Ismeretlen hiba.";
}

/**
 * Safe directory picker wrapper.
 * - Requires secure context (https) and supported browsers.
 */
async function pickDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  const anyWindow = window as unknown as {
    showDirectoryPicker?: (options?: { id?: string; mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
  };

  if (typeof anyWindow.showDirectoryPicker !== "function") {
    store.dispatch(actions.setMessage({ kind: "error", text: "A böngésző nem támogatja a mappaválasztót (showDirectoryPicker)." }));
    return null;
  }

  // Phase 1: read-only is enough. Later editor needs readwrite.
  return await anyWindow.showDirectoryPicker({ id: "gitscope-pick", mode: "read" });
}

function isViewId(v: string): v is UIState["view"] {
  // Keep in sync with store.ts ViewId union
  return (
    v === "dashboard" ||
    v === "timeline" ||
    v === "graph" ||
    v === "stats" ||
    v === "files" ||
    v === "refs" ||
    v === "objects" ||
    v === "config" ||
    v === "commands" ||
    v === "groups"
  );
}