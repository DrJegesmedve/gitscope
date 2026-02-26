// apps/ui/src/features/timeline/timelineView.ts
// =============================================================================
// GitScope UI — Timeline View (Phase 1)
// - Renders reflog-derived events (RepoSnapshot.commits)
// - Provides filters + pagination + lightweight rendering
// - Self-mounting into panel: [data-view-panel="timeline"]
// - No framework; safe DOM guards; XSS-safe output
// =============================================================================

import type { Store, UIState, Action, ReflogEntry } from "../../app/store";
import { actions, selectors } from "../../app/store";
import { classifyReflogMessage } from "../../git/analyzer";

export interface TimelineViewDeps {
  store: Store<UIState, Action>;
}

export interface TimelineViewController {
  mount(): void;
  unmount(): void;
}

export function createTimelineView(deps: TimelineViewDeps): TimelineViewController {
  const { store } = deps;

  let root: HTMLElement | null = null;
  let unsub: (() => void) | null = null;

  function mount(): void {
    if (root) return;

    const panel = document.querySelector<HTMLElement>('[data-view-panel="timeline"]');
    if (!panel) return;

    // Build root container
    root = document.createElement("div");
    root.id = "timelineRoot";
    root.className = "timeline-root";
    panel.appendChild(root);

    // Initial skeleton
    renderSkeleton(root);

    // Wire UI events (delegation-safe)
    wireUI(root);

    // Subscribe to the minimal slice needed for rendering
    unsub = store.subscribe(
      (s) => ({
        commits: selectors.commits(s),
        q: selectors.query(s),
        paging: selectors.timelinePaging(s),
        status: selectors.status(s),
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
  }

  return { mount, unmount };
}

/* =============================================================================
 * Rendering
 * ========================================================================== */

function renderSkeleton(root: HTMLElement): void {
  root.innerHTML = "";

  const controls = document.createElement("div");
  controls.className = "card timeline-controls";
  controls.appendChild(h2("Szűrők"));

  const grid = document.createElement("div");
  grid.className = "timeline-grid";

  // Search text
  grid.appendChild(labeledInput("Szöveg", "timelineSearch", "Keress üzenetben / authorban / ref-ben…"));
  // Author
  grid.appendChild(labeledInput("Author", "timelineAuthor", "Pl. John Doe vagy email"));
  // Action
  grid.appendChild(labeledInput("Action", "timelineAction", "Pl. checkout / commit / merge…"));
  // Ref
  grid.appendChild(labeledInput("Ref", "timelineRef", "Pl. HEAD vagy refs/heads/main"));

  controls.appendChild(grid);

  const paging = document.createElement("div");
  paging.className = "timeline-paging";

  const perPage = document.createElement("select");
  perPage.id = "timelinePerPage";
  perPage.className = "input";
  for (const n of [10, 25, 50, 100, 200]) {
    const opt = document.createElement("option");
    opt.value = String(n);
    opt.textContent = `${n} / oldal`;
    perPage.appendChild(opt);
  }

  const prevBtn = button("Előző", "timelinePrev", "btn btn-ghost");
  const nextBtn = button("Következő", "timelineNext", "btn btn-ghost");

  const pageInfo = document.createElement("div");
  pageInfo.id = "timelinePageInfo";
  pageInfo.className = "muted";
  pageInfo.textContent = "—";

  paging.appendChild(prevBtn);
  paging.appendChild(nextBtn);
  paging.appendChild(perPage);
  paging.appendChild(pageInfo);

  root.appendChild(controls);
  root.appendChild(paging);

  const tableCard = document.createElement("div");
  tableCard.className = "card";
  tableCard.appendChild(h2("Események"));

  const tableWrap = document.createElement("div");
  tableWrap.className = "table-wrap";

  const table = document.createElement("table");
  table.className = "table";
  table.id = "timelineTable";

  const thead = document.createElement("thead");
  thead.innerHTML = `
    <tr>
      <th>Idő</th>
      <th>Action</th>
      <th>Author</th>
      <th>Ref</th>
      <th>SHA</th>
      <th>Üzenet</th>
    </tr>
  `;

  const tbody = document.createElement("tbody");
  tbody.id = "timelineTbody";

  table.appendChild(thead);
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  tableCard.appendChild(tableWrap);

  const empty = document.createElement("div");
  empty.id = "timelineEmpty";
  empty.className = "muted";
  empty.style.marginTop = "10px";
  empty.textContent = "Nincs megjeleníthető esemény.";
  empty.hidden = true;

  tableCard.appendChild(empty);

  root.appendChild(tableCard);

  // Minimal inline styles hook (you already have styles.css; this is safe)
  ensureTimelineStyles();
}

function render(root: HTMLElement, state: Readonly<UIState>): void {
  // Sync perPage select value
  const perPageSel = root.querySelector<HTMLSelectElement>("#timelinePerPage");
  if (perPageSel) {
    const pp = state.timeline.perPage;
    if (perPageSel.value !== String(pp)) perPageSel.value = String(pp);
  }

  const commits = state.repo?.commits ?? [];
  const filtered = filterEvents(commits, state.query);

  const perPage = state.timeline.perPage;
  const page = clampInt(state.timeline.page, 0, Math.max(0, Math.ceil(filtered.length / perPage) - 1));
  const start = page * perPage;
  const end = Math.min(filtered.length, start + perPage);
  const slice = filtered.slice(start, end);

  // Update page info + buttons
  const pageInfo = root.querySelector<HTMLElement>("#timelinePageInfo");
  if (pageInfo) {
    const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
    pageInfo.textContent = `Oldal: ${page + 1}/${totalPages} • Találat: ${filtered.length}`;
  }

  const prevBtn = root.querySelector<HTMLButtonElement>("#timelinePrev");
  const nextBtn = root.querySelector<HTMLButtonElement>("#timelineNext");
  if (prevBtn) prevBtn.disabled = page <= 0;
  if (nextBtn) nextBtn.disabled = end >= filtered.length;

  // Render table body (fast)
  const tbody = root.querySelector<HTMLTableSectionElement>("#timelineTbody");
  const empty = root.querySelector<HTMLElement>("#timelineEmpty");
  if (!tbody || !empty) return;

  tbody.innerHTML = "";
  if (slice.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const frag = document.createDocumentFragment();
  for (const e of slice) {
    frag.appendChild(renderRow(e));
  }
  tbody.appendChild(frag);

  // If state page was out of range, normalize it (without loops)
  if (page !== state.timeline.page) {
    // Avoid infinite dispatch loop: only dispatch when necessary
    state.timeline.page !== page && state.timeline.page >= 0 && storeSafeDispatch(state, page);
  }

  function storeSafeDispatch(s: Readonly<UIState>, normalizedPage: number) {
    // Using global store is not accessible here. We normalize by UI event flow instead.
    // To keep this file pure-ish, we DON'T dispatch here.
    // The page normalization happens via Prev/Next handlers which clamp.
    void s; void normalizedPage;
  }
}

function renderRow(e: ReflogEntry): HTMLTableRowElement {
  const tr = document.createElement("tr");

  const action = classifyReflogMessage(e.msg);
  const author = formatAuthor(e.authorName, e.authorEmail);
  const ref = e.ref || "—";
  const sha = (e.newSha || "").slice(0, 10);

  tr.appendChild(td(formatTime(e.ts)));
  tr.appendChild(td(action));
  tr.appendChild(td(author));
  tr.appendChild(td(ref));
  tr.appendChild(td(sha, "mono"));
  tr.appendChild(td(e.msg || "—"));

  return tr;
}

/* =============================================================================
 * Wiring
 * ========================================================================== */

function wireUI(root: HTMLElement): void {
  const store = getStoreFromGlobal();
  // We avoid leaking store via globals normally, but main.ts can set it.
  // If not set, controls won't dispatch (still safe).
  // Recommended: set window.__gitscopeStore = store in main.ts later.
  // For now we also support a local closure via dataset binding if needed.
  void store;

  // Input handlers (debounced)
  bindDebouncedInput(root, "#timelineSearch", (v) => safeDispatch(actions.patchQuery({ timelineSearch: v })));
  bindDebouncedInput(root, "#timelineAuthor", (v) => safeDispatch(actions.patchQuery({ timelineAuthor: v })));
  bindDebouncedInput(root, "#timelineAction", (v) => safeDispatch(actions.patchQuery({ timelineAction: v })));
  bindDebouncedInput(root, "#timelineRef", (v) => safeDispatch(actions.patchQuery({ timelineRef: v })));

  // Paging
  const prevBtn = root.querySelector<HTMLButtonElement>("#timelinePrev");
  const nextBtn = root.querySelector<HTMLButtonElement>("#timelineNext");
  const perPageSel = root.querySelector<HTMLSelectElement>("#timelinePerPage");

  if (prevBtn) {
    prevBtn.addEventListener("click", () => {
      const s = safeGetState();
      if (!s) return;
      safeDispatch(actions.setTimelinePage(Math.max(0, s.timeline.page - 1)));
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      const s = safeGetState();
      if (!s) return;
      safeDispatch(actions.setTimelinePage(s.timeline.page + 1));
    });
  }

  if (perPageSel) {
    perPageSel.addEventListener("change", () => {
      const n = Number.parseInt(perPageSel.value, 10);
      if (!Number.isFinite(n)) return;
      safeDispatch(actions.setTimelinePerPage(n));
    });
  }

  // Initial fill inputs from state (best effort)
  const s = safeGetState();
  if (s) {
    setInputValue(root, "#timelineSearch", s.query.timelineSearch);
    setInputValue(root, "#timelineAuthor", s.query.timelineAuthor);
    setInputValue(root, "#timelineAction", s.query.timelineAction);
    setInputValue(root, "#timelineRef", s.query.timelineRef);
  }

  function safeDispatch(a: Action): void {
    const st = getStoreFromGlobal();
    if (!st) return;
    st.dispatch(a);
  }

  function safeGetState(): Readonly<UIState> | null {
    const st = getStoreFromGlobal();
    return st ? st.getState() : null;
  }
}

/**
 * Optional global store hookup:
 * In main.ts you can set: (window as any).__gitscopeStore = store;
 * This keeps view modules decoupled from app bootstrap order.
 */
function getStoreFromGlobal(): Store<UIState, Action> | null {
  const anyWin = window as unknown as { __gitscopeStore?: Store<UIState, Action> };
  return anyWin.__gitscopeStore ?? null;
}

/* =============================================================================
 * Filtering
 * ========================================================================== */

function filterEvents(
  events: ReflogEntry[],
  q: UIState["query"]
): ReflogEntry[] {
  const search = norm(q.timelineSearch);
  const author = norm(q.timelineAuthor);
  const action = norm(q.timelineAction);
  const ref = norm(q.timelineRef);

  if (!search && !author && !action && !ref) return events;

  return events.filter((e) => {
    const msg = norm(e.msg);
    const a = norm(`${e.authorName} ${e.authorEmail}`);
    const r = norm(e.ref);
    const act = norm(classifyReflogMessage(e.msg));

    if (author && !a.includes(author)) return false;
    if (action && !act.includes(action)) return false;
    if (ref && !r.includes(ref)) return false;

    if (search) {
      const blob = `${msg} ${a} ${r} ${act} ${e.newSha} ${e.oldSha}`.toLowerCase();
      if (!blob.includes(search)) return false;
    }

    return true;
  });
}

function norm(s: string): string {
  return (s || "").trim().toLowerCase();
}

/* =============================================================================
 * Tiny DOM helpers
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

function labeledInput(label: string, id: string, placeholder: string): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "timeline-field";

  const l = document.createElement("div");
  l.className = "label";
  l.textContent = label;

  const input = document.createElement("input");
  input.className = "input";
  input.id = id;
  input.type = "text";
  input.placeholder = placeholder;

  wrap.appendChild(l);
  wrap.appendChild(input);
  return wrap;
}

function setInputValue(root: HTMLElement, selector: string, value: string): void {
  const el = root.querySelector<HTMLInputElement>(selector);
  if (!el) return;
  if (el.value !== value) el.value = value;
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

function td(text: string, cls?: string): HTMLTableCellElement {
  const cell = document.createElement("td");
  if (cls) cell.className = cls;
  cell.textContent = text;
  return cell;
}

/* =============================================================================
 * Formatting
 * ========================================================================== */

function formatTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "—";
  const d = new Date(ts);
  // YYYY-MM-DD HH:mm
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatAuthor(name: string, email: string): string {
  const n = (name || "").trim();
  const e = (email || "").trim();
  if (n && e) return `${n} <${e}>`;
  if (n) return n;
  if (e) return `<${e}>`;
  return "—";
}

function clampInt(n: number, min: number, max: number): number {
  const x = Number.isFinite(n) ? Math.trunc(n) : min;
  return Math.min(max, Math.max(min, x));
}

/* =============================================================================
 * Styles injection (safe)
 * ========================================================================== */

let timelineStylesInjected = false;

function ensureTimelineStyles(): void {
  if (timelineStylesInjected) return;
  timelineStylesInjected = true;

  const style = document.createElement("style");
  style.textContent = `
    .timeline-controls { margin-bottom: 12px; }
    .timeline-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .timeline-field { display: grid; gap: 6px; }
    .timeline-paging {
      display: flex;
      align-items: center;
      justify-content: flex-start;
      gap: 10px;
      margin: 12px 0;
      flex-wrap: wrap;
    }
    .table-wrap { overflow: auto; }
    .table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .table th, .table td {
      border-bottom: 1px solid var(--border);
      padding: 10px 8px;
      vertical-align: top;
      white-space: nowrap;
    }
    .table td:last-child { white-space: normal; }
    .table th {
      text-align: left;
      color: var(--muted);
      font-weight: 700;
      font-size: 12px;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }
    .mono { font-family: var(--mono); }
    @media (max-width: 980px) {
      .timeline-grid { grid-template-columns: 1fr; }
      .table th:nth-child(5), .table td:nth-child(5) { display: none; }
    }
  `;
  document.head.appendChild(style);
}