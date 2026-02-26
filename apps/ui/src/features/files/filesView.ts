// apps/ui/src/features/files/filesView.ts
// =============================================================================
// GitScope UI — Files View (Phase 1)
// - Lists files from FileIndex (.git internal paths)
// - Search/filter (store.query.fileSearch)
// - Raw preview with safety limits (size cap + binary detection)
// - Self-mounting into panel: [data-view-panel="files"]
// - No framework; safe DOM guards; XSS-safe output
// =============================================================================

import type { Store, UIState, Action, FileIndex } from "../../app/store";
import { actions } from "../../app/store";

export interface FilesViewDeps {
  store: Store<UIState, Action>;
}

export interface FilesViewController {
  mount(): void;
  unmount(): void;
}

export function createFilesView(deps: FilesViewDeps): FilesViewController {
  const { store } = deps;

  let root: HTMLElement | null = null;
  let unsub: (() => void) | null = null;

  // Local (view-only) selection state (Phase 1)
  let selectedPath: string | null = null;

  function mount(): void {
    if (root) return;

    const panel = document.querySelector<HTMLElement>('[data-view-panel="files"]');
    if (!panel) return;

    root = document.createElement("div");
    root.id = "filesRoot";
    root.className = "files-root";
    panel.appendChild(root);

    renderSkeleton(root);
    wireUI(root);

    unsub = store.subscribe(
      (s) => ({
        files: s.files,
        search: s.query.fileSearch,
        status: s.status,
        repoName: s.repo?.identity.displayName ?? "",
      }),
      () => render(root!, store.getState()),
      { fireImmediately: true }
    );
  }

  function unmount(): void {
    if (unsub) {
      unsub();
      unsub = null;
    }
    if (root) {
      root.remove();
      root = null;
    }
    selectedPath = null;
  }

  /* ------------------------------------------------------------------------ */
  /* UI rendering                                                              */
  /* ------------------------------------------------------------------------ */

  function renderSkeleton(rootEl: HTMLElement): void {
    rootEl.innerHTML = "";

    const top = document.createElement("div");
    top.className = "card files-controls";
    top.appendChild(h2("Git fájlok"));

    const row = document.createElement("div");
    row.className = "files-row";

    // Search
    const searchWrap = document.createElement("label");
    searchWrap.className = "files-field";
    const searchLabel = document.createElement("div");
    searchLabel.className = "label";
    searchLabel.textContent = "Keresés";
    const searchInput = document.createElement("input");
    searchInput.id = "filesSearch";
    searchInput.className = "input";
    searchInput.type = "text";
    searchInput.placeholder = "Pl. HEAD, packed-refs, logs/HEAD, refs/heads…";
    searchWrap.appendChild(searchLabel);
    searchWrap.appendChild(searchInput);

    // Selected file info
    const info = document.createElement("div");
    info.className = "files-info";
    info.innerHTML = `
      <div class="label">Kijelölve</div>
      <div id="filesSelected" class="value mono">—</div>
      <div class="label" style="margin-top:8px;">Méret</div>
      <div id="filesSelectedSize" class="value mono">—</div>
    `;

    row.appendChild(searchWrap);
    row.appendChild(info);
    top.appendChild(row);

    const body = document.createElement("div");
    body.className = "files-split";

    // Left list
    const listCard = document.createElement("div");
    listCard.className = "card";
    listCard.appendChild(h2("Lista"));

    const listMeta = document.createElement("div");
    listMeta.id = "filesMeta";
    listMeta.className = "muted";
    listMeta.textContent = "—";
    listCard.appendChild(listMeta);

    const list = document.createElement("div");
    list.id = "filesList";
    list.className = "files-list";
    listCard.appendChild(list);

    // Right preview
    const previewCard = document.createElement("div");
    previewCard.className = "card";
    previewCard.appendChild(h2("Tartalom"));

    const previewActions = document.createElement("div");
    previewActions.className = "files-preview-actions";

    const copyBtn = button("Copy", "filesCopyBtn", "btn btn-ghost");
    const downloadBtn = button("Download", "filesDownloadBtn", "btn btn-ghost");
    copyBtn.disabled = true;
    downloadBtn.disabled = true;

    previewActions.appendChild(copyBtn);
    previewActions.appendChild(downloadBtn);

    const previewHint = document.createElement("div");
    previewHint.id = "filesPreviewHint";
    previewHint.className = "muted";
    previewHint.textContent = "Válassz egy fájlt a listából.";

    const pre = document.createElement("pre");
    pre.id = "filesPreview";
    pre.className = "files-pre mono";
    pre.textContent = "";

    previewCard.appendChild(previewActions);
    previewCard.appendChild(previewHint);
    previewCard.appendChild(pre);

    body.appendChild(listCard);
    body.appendChild(previewCard);

    rootEl.appendChild(top);
    rootEl.appendChild(body);

    ensureFilesStyles();
  }

  function render(rootEl: HTMLElement, state: Readonly<UIState>): void {
    // Sync search input value
    const searchInput = rootEl.querySelector<HTMLInputElement>("#filesSearch");
    if (searchInput && searchInput.value !== state.query.fileSearch) {
      searchInput.value = state.query.fileSearch;
    }

    // Build filtered list
    const listEl = rootEl.querySelector<HTMLElement>("#filesList");
    const metaEl = rootEl.querySelector<HTMLElement>("#filesMeta");
    if (!listEl || !metaEl) return;

    const allPaths = listPathsStable(state.files);
    const filtered = filterPaths(allPaths, state.query.fileSearch);

    metaEl.textContent = `Összes: ${allPaths.length} • Szűrt: ${filtered.length}`;

    // If selected path no longer exists, clear selection
    if (selectedPath && !state.files.byPath.has(selectedPath)) {
      selectedPath = null;
      clearPreview(rootEl);
    }

    // Render list (fast)
    listEl.innerHTML = "";
    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.textContent = "Nincs találat.";
      listEl.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const p of filtered) {
      frag.appendChild(renderListItem(p, p === selectedPath));
    }
    listEl.appendChild(frag);

    // Update selected info
    updateSelectedInfo(rootEl, state.files, selectedPath);

    // Update buttons state
    const copyBtn = rootEl.querySelector<HTMLButtonElement>("#filesCopyBtn");
    const downloadBtn = rootEl.querySelector<HTMLButtonElement>("#filesDownloadBtn");
    const hasSelection = Boolean(selectedPath);
    if (copyBtn) copyBtn.disabled = !hasSelection;
    if (downloadBtn) downloadBtn.disabled = !hasSelection;
  }

  /* ------------------------------------------------------------------------ */
  /* UI events                                                                 */
  /* ------------------------------------------------------------------------ */

  function wireUI(rootEl: HTMLElement): void {
    // Search input (debounced)
    bindDebouncedInput(rootEl, "#filesSearch", (v) => {
      store.dispatch(actions.patchQuery({ fileSearch: v }));
    });

    // List click (event delegation)
    const listEl = rootEl.querySelector<HTMLElement>("#filesList");
    if (listEl) {
      listEl.addEventListener("click", async (ev) => {
        const target = ev.target as HTMLElement | null;
        if (!target) return;

        const item = target.closest<HTMLElement>("[data-file-path]");
        if (!item) return;

        const path = item.getAttribute("data-file-path");
        if (!path) return;

        selectedPath = path;
        await loadPreview(rootEl, store.getState().files, path);
        // Re-render to update highlight + buttons
        render(rootEl, store.getState());
      });
    }

    // Copy
    const copyBtn = rootEl.querySelector<HTMLButtonElement>("#filesCopyBtn");
    if (copyBtn) {
      copyBtn.addEventListener("click", async () => {
        if (!selectedPath) return;
        const pre = rootEl.querySelector<HTMLElement>("#filesPreview");
        if (!pre) return;

        const text = pre.textContent ?? "";
        try {
          await navigator.clipboard.writeText(text);
          store.dispatch(actions.setMessage({ kind: "ok", text: "Másolva a vágólapra." }));
        } catch {
          store.dispatch(actions.setMessage({ kind: "warn", text: "Nem sikerült másolni (clipboard tiltás?)." }));
        }
      });
    }

    // Download
    const downloadBtn = rootEl.querySelector<HTMLButtonElement>("#filesDownloadBtn");
    if (downloadBtn) {
      downloadBtn.addEventListener("click", async () => {
        if (!selectedPath) return;

        const file = store.getState().files.byPath.get(selectedPath);
        if (!file) return;

        // download raw file as-is
        const blob = file.slice(0, file.size, file.type || "application/octet-stream");
        const url = URL.createObjectURL(blob);
        try {
          const a = document.createElement("a");
          a.href = url;
          a.download = safeFilename(selectedPath);
          document.body.appendChild(a);
          a.click();
          a.remove();
          store.dispatch(actions.setMessage({ kind: "ok", text: "Letöltés elindítva." }));
        } finally {
          URL.revokeObjectURL(url);
        }
      });
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Preview loader                                                            */
  /* ------------------------------------------------------------------------ */

  async function loadPreview(rootEl: HTMLElement, files: FileIndex, path: string): Promise<void> {
    const file = files.byPath.get(path);
    if (!file) {
      clearPreview(rootEl);
      setHint(rootEl, "A kijelölt fájl nem található.");
      return;
    }

    updateSelectedInfo(rootEl, files, path);

    // Safety limits (Phase 1)
    const MAX_PREVIEW_BYTES = 2 * 1024 * 1024; // 2 MB
    const hintParts: string[] = [];

    if (file.size > MAX_PREVIEW_BYTES) {
      hintParts.push(`A fájl túl nagy preview-hoz (${formatBytes(file.size)}).`);
      hintParts.push(`Limit: ${formatBytes(MAX_PREVIEW_BYTES)}.`);
      setHint(rootEl, hintParts.join(" "));
      setPreviewText(rootEl, "");
      return;
    }

    // Read small chunk first to detect binary
    const headChunk = await file.slice(0, Math.min(file.size, 64 * 1024)).arrayBuffer();
    if (looksBinary(headChunk)) {
      setHint(rootEl, "Bináris fájl — szöveges megjelenítés kihagyva.");
      setPreviewText(rootEl, "");
      return;
    }

    // Read full text safely
    try {
      const text = await file.text();
      setHint(rootEl, "");
      setPreviewText(rootEl, text);
    } catch {
      setHint(rootEl, "Nem sikerült beolvasni a fájlt szövegként.");
      setPreviewText(rootEl, "");
    }
  }

  function clearPreview(rootEl: HTMLElement): void {
    setHint(rootEl, "Válassz egy fájlt a listából.");
    setPreviewText(rootEl, "");
    const sel = rootEl.querySelector<HTMLElement>("#filesSelected");
    const size = rootEl.querySelector<HTMLElement>("#filesSelectedSize");
    if (sel) sel.textContent = "—";
    if (size) size.textContent = "—";
  }

  function setHint(rootEl: HTMLElement, text: string): void {
    const hint = rootEl.querySelector<HTMLElement>("#filesPreviewHint");
    if (!hint) return;
    hint.textContent = text || "";
    hint.hidden = !text;
  }

  function setPreviewText(rootEl: HTMLElement, text: string): void {
    const pre = rootEl.querySelector<HTMLElement>("#filesPreview");
    if (!pre) return;
    pre.textContent = text;
  }

  function updateSelectedInfo(rootEl: HTMLElement, files: FileIndex, path: string | null): void {
    const sel = rootEl.querySelector<HTMLElement>("#filesSelected");
    const size = rootEl.querySelector<HTMLElement>("#filesSelectedSize");
    if (!sel || !size) return;

    if (!path) {
      sel.textContent = "—";
      size.textContent = "—";
      return;
    }

    const file = files.byPath.get(path);
    sel.textContent = path;
    size.textContent = file ? formatBytes(file.size || 0) : "—";
  }

  return { mount, unmount };
}

/* =============================================================================
 * Pure helpers
 * ========================================================================== */

function listPathsStable(files: FileIndex): string[] {
  const arr = Array.from(files.byPath.keys());
  arr.sort((a, b) => a.localeCompare(b));
  return arr;
}

function filterPaths(paths: string[], query: string): string[] {
  const q = (query || "").trim().toLowerCase();
  if (!q) return paths;
  return paths.filter((p) => p.toLowerCase().includes(q));
}

function looksBinary(buf: ArrayBuffer): boolean {
  // Heuristic: if contains NUL or too many control chars
  const u8 = new Uint8Array(buf);
  let control = 0;
  for (let i = 0; i < u8.length; i++) {
    const c = u8[i];
    if (c === 0) return true;
    // count control chars excluding \n \r \t
    if (c < 9 || (c > 13 && c < 32)) control++;
  }
  return u8.length > 0 && control / u8.length > 0.15;
}

function safeFilename(path: string): string {
  // Convert "logs/refs/heads/main" -> "logs_refs_heads_main.txt"
  const base = (path || "file").replace(/[\/\\]/g, "_").replace(/[^a-zA-Z0-9._-]/g, "_");
  // If no extension, add .txt for text-ish readability
  return /\.[a-z0-9]{1,6}$/i.test(base) ? base : `${base}.txt`;
}

/* =============================================================================
 * DOM helpers
 * ========================================================================== */

function h2(text: string): HTMLElement {
  const h = document.createElement("h2");
  h.className = "card-title";
  h.textContent = text;
  return h;
}

function button(text: string, id: string, className: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.id = id;
  b.className = className;
  b.textContent = text;
  return b;
}

function bindDebouncedInput(
  root: HTMLElement,
  selector: string,
  onValue: (value: string) => void,
  delayMs = 150
): void {
  const el = root.querySelector<HTMLInputElement>(selector);
  if (!el) return;

  let t: number | null = null;
  el.addEventListener("input", () => {
    if (t !== null) window.clearTimeout(t);
    t = window.setTimeout(() => {
      t = null;
      onValue(el.value);
    }, delayMs);
  });
}

/* =============================================================================
 * Rendering list items
 * ========================================================================== */

function renderListItem(path: string, selected: boolean): HTMLElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "files-item";
  row.setAttribute("data-file-path", path);
  if (selected) row.setAttribute("data-selected", "true");

  // Split "folder/file" so UI looks nicer
  const parts = path.split("/");
  const name = parts.pop() ?? path;
  const dir = parts.join("/");

  const left = document.createElement("div");
  left.className = "files-item-left";

  const title = document.createElement("div");
  title.className = "files-item-name mono";
  title.textContent = name;

  const sub = document.createElement("div");
  sub.className = "files-item-dir";
  sub.textContent = dir || "—";

  left.appendChild(title);
  left.appendChild(sub);

  row.appendChild(left);
  return row;
}

/* =============================================================================
 * Formatting
 * ========================================================================== */

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

/* =============================================================================
 * Styles injection (scoped)
 * ========================================================================== */

let filesStylesInjected = false;

function ensureFilesStyles(): void {
  if (filesStylesInjected) return;
  filesStylesInjected = true;

  const style = document.createElement("style");
  style.textContent = `
    .files-controls { margin-bottom: 12px; }
    .files-row {
      display: grid;
      grid-template-columns: 1fr 220px;
      gap: 12px;
      align-items: start;
    }
    .files-field { display: grid; gap: 6px; }
    .files-info { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px; background: color-mix(in srgb, var(--panel) 88%, transparent); }
    .files-split {
      display: grid;
      grid-template-columns: 360px 1fr;
      gap: 12px;
      align-items: start;
      min-width: 0;
    }
    .files-list {
      display: grid;
      gap: 8px;
      max-height: 62vh;
      overflow: auto;
      padding-right: 4px;
    }
    .files-item {
      width: 100%;
      text-align: left;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--text);
      padding: 10px;
      cursor: pointer;
    }
    .files-item:hover {
      border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
    }
    .files-item[data-selected="true"] {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent);
    }
    .files-item-left { display: grid; gap: 4px; }
    .files-item-name { font-weight: 700; }
    .files-item-dir { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .files-preview-actions {
      display: flex;
      gap: 10px;
      align-items: center;
      justify-content: flex-end;
      margin-bottom: 10px;
    }
    .files-pre {
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 12px;
      background: color-mix(in srgb, var(--panel) 88%, transparent);
      overflow: auto;
      max-height: 62vh;
      white-space: pre;
      line-height: 1.35;
      font-size: 12px;
    }
    .mono { font-family: var(--mono); }

    @media (max-width: 980px) {
      .files-row { grid-template-columns: 1fr; }
      .files-split { grid-template-columns: 1fr; }
      .files-list, .files-pre { max-height: 42vh; }
    }
  `;
  document.head.appendChild(style);
}