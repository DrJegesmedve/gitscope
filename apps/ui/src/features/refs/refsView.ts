// apps/ui/src/features/refs/refsView.ts
// =============================================================================
// GitScope UI — Refs View (Phase 1)
// - Displays HEAD + refs (branches/tags/remotes/special/other)
// - Provides local search and copy actions
// - Self-mounting into panel: [data-view-panel="refs"]
// - No framework; safe DOM guards; XSS-safe output
// =============================================================================

import type { Store, UIState, Action, GitHead } from "../../app/store";
import { actions } from "../../app/store";

export interface RefsViewDeps {
  store: Store<UIState, Action>;
}

export interface RefsViewController {
  mount(): void;
  unmount(): void;
}

type RefGroupId = "branches" | "tags" | "remotes" | "special" | "other";

interface RefRow {
  ref: string;
  sha: string;
  group: RefGroupId;
}

export function createRefsView(deps: RefsViewDeps): RefsViewController {
  const { store } = deps;

  let root: HTMLElement | null = null;
  let unsub: (() => void) | null = null;

  // local search (Phase 1: keep store clean)
  let searchText = "";

  function mount(): void {
    if (root) return;

    const panel = document.querySelector<HTMLElement>('[data-view-panel="refs"]');
    if (!panel) return;

    root = document.createElement("div");
    root.id = "refsRoot";
    root.className = "refs-root";
    panel.appendChild(root);

    renderSkeleton(root);
    wireUI(root);

    unsub = store.subscribe(
      (s) => ({
        status: s.status,
        head: s.repo?.head ?? null,
        refs: s.repo?.refs ?? null,
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
    searchText = "";
  }

  return { mount, unmount };

  /* ------------------------------------------------------------------------ */
  /* UI Skeleton                                                               */
  /* ------------------------------------------------------------------------ */

  function renderSkeleton(rootEl: HTMLElement): void {
    rootEl.innerHTML = "";

    const top = document.createElement("div");
    top.className = "card refs-controls";
    top.appendChild(h2("Refs"));

    const row = document.createElement("div");
    row.className = "refs-row";

    const searchWrap = document.createElement("label");
    searchWrap.className = "refs-field";

    const l = document.createElement("div");
    l.className = "label";
    l.textContent = "Keresés";

    const input = document.createElement("input");
    input.id = "refsSearch";
    input.className = "input";
    input.type = "text";
    input.placeholder = "Pl. refs/heads/main, tags, origin, HEAD…";

    searchWrap.appendChild(l);
    searchWrap.appendChild(input);

    const headCard = document.createElement("div");
    headCard.className = "refs-head";
    headCard.innerHTML = `
      <div class="label">HEAD</div>
      <div id="refsHeadValue" class="value mono">—</div>
      <div class="refs-head-actions">
        <button id="refsCopyHeadBtn" class="btn btn-ghost" type="button" disabled>Copy HEAD</button>
        <button id="refsCopyHeadShaBtn" class="btn btn-ghost" type="button" disabled>Copy SHA</button>
      </div>
      <div id="refsHeadSha" class="muted mono"></div>
    `;

    row.appendChild(searchWrap);
    row.appendChild(headCard);
    top.appendChild(row);

    const meta = document.createElement("div");
    meta.id = "refsMeta";
    meta.className = "muted";
    meta.style.marginTop = "10px";
    meta.textContent = "—";
    top.appendChild(meta);

    const listWrap = document.createElement("div");
    listWrap.className = "refs-groups";
    listWrap.id = "refsGroups";

    rootEl.appendChild(top);
    rootEl.appendChild(listWrap);

    ensureRefsStyles();
  }

  /* ------------------------------------------------------------------------ */
  /* Render                                                                     */
  /* ------------------------------------------------------------------------ */

  function render(rootEl: HTMLElement, state: Readonly<UIState>): void {
    // Sync input
    const input = rootEl.querySelector<HTMLInputElement>("#refsSearch");
    if (input && input.value !== searchText) input.value = searchText;

    const refsMap = state.repo?.refs ?? null;
    const head = state.repo?.head ?? null;

    // HEAD display
    renderHead(rootEl, head, refsMap);

    // refs grouping
    const rows = refsMap ? mapToRows(refsMap) : [];
    const filtered = filterRows(rows, searchText);

    const meta = rootEl.querySelector<HTMLElement>("#refsMeta");
    if (meta) {
      const total = rows.length;
      const shown = filtered.length;
      const counts = countGroups(filtered);
      meta.textContent =
        `Összes ref: ${total} • Megjelenítve: ${shown}` +
        ` • branches: ${counts.branches}` +
        ` • tags: ${counts.tags}` +
        ` • remotes: ${counts.remotes}` +
        ` • special: ${counts.special}` +
        ` • other: ${counts.other}`;
    }

    const groups = rootEl.querySelector<HTMLElement>("#refsGroups");
    if (!groups) return;

    groups.innerHTML = "";

    if (!refsMap || rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "card muted";
      empty.textContent = "Nincs ref adat (betöltött repo hiányzik, vagy üres).";
      groups.appendChild(empty);
      return;
    }

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "card muted";
      empty.textContent = "Nincs találat a keresésre.";
      groups.appendChild(empty);
      return;
    }

    // Render in stable group order
    for (const groupId of ["branches", "tags", "remotes", "special", "other"] as const) {
      const groupRows = filtered.filter((r) => r.group === groupId);
      if (groupRows.length === 0) continue;

      groups.appendChild(renderGroup(groupId, groupRows));
    }
  }

  function renderHead(rootEl: HTMLElement, head: GitHead | null, refs: Map<string, string> | null): void {
    const headValue = rootEl.querySelector<HTMLElement>("#refsHeadValue");
    const headShaEl = rootEl.querySelector<HTMLElement>("#refsHeadSha");
    const copyHeadBtn = rootEl.querySelector<HTMLButtonElement>("#refsCopyHeadBtn");
    const copyShaBtn = rootEl.querySelector<HTMLButtonElement>("#refsCopyHeadShaBtn");

    const headText = formatHead(head);
    const headSha = resolveHeadSha(head, refs);

    if (headValue) headValue.textContent = headText;
    if (headShaEl) headShaEl.textContent = headSha ? `SHA: ${headSha}` : "";

    if (copyHeadBtn) copyHeadBtn.disabled = !head;
    if (copyShaBtn) copyShaBtn.disabled = !headSha;

    // Store on dataset for buttons to read (safe string)
    if (copyHeadBtn) copyHeadBtn.dataset.copyValue = headText;
    if (copyShaBtn) copyShaBtn.dataset.copyValue = headSha ?? "";
  }

  /* ------------------------------------------------------------------------ */
  /* UI events                                                                  */
  /* ------------------------------------------------------------------------ */

  function wireUI(rootEl: HTMLElement): void {
    // Search (debounced)
    bindDebouncedInput(rootEl, "#refsSearch", (v) => {
      searchText = v;
      render(rootEl, store.getState());
    });

    // Copy buttons (delegation)
    rootEl.addEventListener("click", async (ev) => {
      const t = ev.target as HTMLElement | null;
      if (!t) return;

      const btn = t.closest<HTMLButtonElement>("button");
      if (!btn) return;

      if (btn.id === "refsCopyHeadBtn" || btn.id === "refsCopyHeadShaBtn") {
        const val = btn.dataset.copyValue || "";
        if (!val) return;
        await copyToClipboard(val, store);
        return;
      }

      if (btn.dataset.action === "copy-ref") {
        const val = btn.dataset.value || "";
        if (!val) return;
        await copyToClipboard(val, store);
        return;
      }

      if (btn.dataset.action === "copy-sha") {
        const val = btn.dataset.value || "";
        if (!val) return;
        await copyToClipboard(val, store);
        return;
      }
    });
  }
}

/* =============================================================================
 * Group rendering
 * ========================================================================== */

function renderGroup(groupId: RefGroupId, rows: RefRow[]): HTMLElement {
  const card = document.createElement("div");
  card.className = "card refs-group";

  const title = document.createElement("div");
  title.className = "refs-group-title";
  title.textContent = `${groupLabel(groupId)} (${rows.length})`;
  card.appendChild(title);

  const tableWrap = document.createElement("div");
  tableWrap.className = "table-wrap";

  const table = document.createElement("table");
  table.className = "table refs-table";

  const thead = document.createElement("thead");
  thead.innerHTML = `
    <tr>
      <th>Ref</th>
      <th>SHA</th>
      <th>Actions</th>
    </tr>
  `;
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const r of rowsSorted(rows)) {
    tbody.appendChild(renderRefRow(r));
  }
  table.appendChild(tbody);

  tableWrap.appendChild(table);
  card.appendChild(tableWrap);

  return card;
}

function renderRefRow(r: RefRow): HTMLTableRowElement {
  const tr = document.createElement("tr");

  const refTd = document.createElement("td");
  refTd.className = "mono";
  refTd.textContent = r.ref;

  const shaTd = document.createElement("td");
  shaTd.className = "mono";
  shaTd.textContent = r.sha.slice(0, 12);

  const actTd = document.createElement("td");
  actTd.className = "refs-actions";

  const copyRef = document.createElement("button");
  copyRef.type = "button";
  copyRef.className = "btn btn-ghost";
  copyRef.textContent = "Copy ref";
  copyRef.dataset.action = "copy-ref";
  copyRef.dataset.value = r.ref;

  const copySha = document.createElement("button");
  copySha.type = "button";
  copySha.className = "btn btn-ghost";
  copySha.textContent = "Copy sha";
  copySha.dataset.action = "copy-sha";
  copySha.dataset.value = r.sha;

  actTd.appendChild(copyRef);
  actTd.appendChild(copySha);

  tr.appendChild(refTd);
  tr.appendChild(shaTd);
  tr.appendChild(actTd);

  return tr;
}

/* =============================================================================
 * Mapping & filtering
 * ========================================================================== */

function mapToRows(refs: Map<string, string>): RefRow[] {
  const rows: RefRow[] = [];
  for (const [ref, sha] of refs.entries()) {
    if (!ref || !sha) continue;
    rows.push({ ref, sha, group: classifyRef(ref) });
  }
  return rows;
}

function filterRows(rows: RefRow[], search: string): RefRow[] {
  const q = (search || "").trim().toLowerCase();
  if (!q) return rows;

  return rows.filter((r) => {
    const blob = `${r.ref} ${r.sha}`.toLowerCase();
    return blob.includes(q);
  });
}

function classifyRef(ref: string): RefGroupId {
  if (ref.startsWith("refs/heads/")) return "branches";
  if (ref.startsWith("refs/tags/")) return "tags";
  if (ref.startsWith("refs/remotes/")) return "remotes";

  // common "special" refs
  if (
    ref === "HEAD" ||
    ref === "ORIG_HEAD" ||
    ref === "FETCH_HEAD" ||
    ref === "MERGE_HEAD" ||
    ref === "CHERRY_PICK_HEAD" ||
    ref === "REBASE_HEAD"
  ) {
    return "special";
  }

  return "other";
}

function countGroups(rows: RefRow[]): Record<RefGroupId, number> {
  const c: Record<RefGroupId, number> = {
    branches: 0,
    tags: 0,
    remotes: 0,
    special: 0,
    other: 0,
  };
  for (const r of rows) c[r.group]++;
  return c;
}

function rowsSorted(rows: RefRow[]): RefRow[] {
  // stable sort by ref
  return rows.slice().sort((a, b) => a.ref.localeCompare(b.ref));
}

function groupLabel(g: RefGroupId): string {
  switch (g) {
    case "branches":
      return "Branches";
    case "tags":
      return "Tags";
    case "remotes":
      return "Remotes";
    case "special":
      return "Special";
    case "other":
      return "Other";
  }
}

/* =============================================================================
 * HEAD helpers
 * ========================================================================== */

function formatHead(head: GitHead | null): string {
  if (!head) return "—";
  if (head.type === "ref") return `ref: ${head.value}`;
  return `detached: ${head.value}`;
}

function resolveHeadSha(head: GitHead | null, refs: Map<string, string> | null): string | null {
  if (!head) return null;
  if (head.type === "detached") return head.value;

  if (!refs) return null;
  // HEAD ref value looks like "refs/heads/main"
  return refs.get(head.value) ?? null;
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
 * Clipboard (safe)
 * ========================================================================== */

async function copyToClipboard(value: string, store: Store<UIState, Action>): Promise<void> {
  const text = value ?? "";
  if (!text) return;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      store.dispatch(actions.setMessage({ kind: "ok", text: "Másolva a vágólapra." }));
      return;
    }
  } catch {
    // fallback below
  }

  // Fallback: execCommand (legacy)
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "true");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();

    store.dispatch(
      actions.setMessage({
        kind: ok ? "ok" : "warn",
        text: ok ? "Másolva a vágólapra." : "Nem sikerült másolni.",
      })
    );
  } catch {
    store.dispatch(actions.setMessage({ kind: "warn", text: "Nem sikerült másolni." }));
  }
}

/* =============================================================================
 * Styles injection
 * ========================================================================== */

let refsStylesInjected = false;

function ensureRefsStyles(): void {
  if (refsStylesInjected) return;
  refsStylesInjected = true;

  const style = document.createElement("style");
  style.textContent = `
    .refs-controls { margin-bottom: 12px; }
    .refs-row {
      display: grid;
      grid-template-columns: 1fr 360px;
      gap: 12px;
      align-items: start;
    }
    .refs-field { display: grid; gap: 6px; }
    .refs-head {
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 10px;
      background: color-mix(in srgb, var(--panel) 88%, transparent);
    }
    .refs-head-actions {
      display: flex;
      gap: 10px;
      align-items: center;
      justify-content: flex-start;
      margin-top: 10px;
      flex-wrap: wrap;
    }

    .refs-groups { display: grid; gap: 12px; }
    .refs-group-title {
      font-size: 13px;
      color: var(--muted);
      letter-spacing: 0.02em;
      text-transform: uppercase;
      font-weight: 700;
      margin-bottom: 10px;
    }

    .table-wrap { overflow: auto; }
    .refs-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .refs-table th, .refs-table td {
      border-bottom: 1px solid var(--border);
      padding: 10px 8px;
      vertical-align: top;
      white-space: nowrap;
    }
    .refs-table th {
      text-align: left;
      color: var(--muted);
      font-weight: 700;
      font-size: 12px;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }
    .refs-actions { display: flex; gap: 10px; justify-content: flex-end; }
    .mono { font-family: var(--mono); }

    @media (max-width: 980px) {
      .refs-row { grid-template-columns: 1fr; }
      .refs-actions { justify-content: flex-start; flex-wrap: wrap; }
    }
  `;
  document.head.appendChild(style);
}