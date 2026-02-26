// apps/ui/src/features/timeline/timelineView.ts
// =============================================================================
// GitScope UI — Timeline View (Phase 1, refined)
// - Renders reflog-derived events (RepoSnapshot.commits)
// - Filters: text/author/action/ref (+ date token support via YYYY-MM-DD)
// - Pagination with safe clamping (auto-corrects out-of-range page)
// - Self-mounting into panel: [data-view-panel="timeline"]
// - No framework; XSS-safe rendering; defensive DOM guards
// =============================================================================

import type { Store, UIState, Action, ReflogEntry } from "../../app/store";
import { actions } from "../../app/store";
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

    root = document.createElement("div");
    root.id = "timelineRoot";
    root.className = "timeline-root";
    panel.appendChild(root);

    renderSkeleton(root);
    wireUI(root, store);

    unsub = store.subscribe(
      (s) => ({
        commits: s.repo?.commits ?? [],
        query: s.query,
        paging: s.timeline,
        status: s.status,
      }),
      () => render(root!, store),
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

  grid.appendChild(labeledInput("Szöveg", "timelineSearch", "Keress üzenetben / authorban / ref-ben / dátumban… (YYYY-MM-DD)"));
  grid.appendChild(labeledInput("Author", "timelineAuthor", "Pl. John Doe vagy email"));
  grid.appendChild(labeledInput("Action", "timelineAction", "Pl. checkout / commit / merge…"));
  grid.appendChild(labeledInput("Ref", "timelineRef", "Pl. HEAD vagy refs/heads/main"));

  controls.appendChild(grid);

  const paging = document.createElement("div");
  paging.className = "timeline-paging";

  const prevBtn = button("Előző", "timelinePrev", "btn btn-ghost");
  const nextBtn = button("Következő", "timelineNext", "btn btn-ghost");

  const perPage = document.createElement("select");
  perPage.id = "timelinePerPage";
  perPage.className = "input";
  for (const n of [10, 25, 50, 100, 200]) {
    const opt = document.createElement("option");
    opt.value = String(n);
    opt.textContent = `${n} / oldal`;
    perPage.appendChild(opt);
  }

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
      <th>Tools</th>
    </tr>
  `;

  const tbody = document.createElement("tbody");
  tbody.id = "timelineTbody";

  table.appendChild(thead);
  table.appendChild(tbody);
  tableWrap.appendChild(table);

  const empty = document.createElement("div");
  empty.id = "timelineEmpty";
  empty.className = "muted";
  empty.style.marginTop = "10px";
  empty.textContent = "Nincs megjeleníthető esemény.";
  empty.hidden = true;

  tableCard.appendChild(tableWrap);
  tableCard.appendChild(empty);

  root.appendChild(tableCard);

  ensureTimelineStyles();
}

function render(root: HTMLElement, store: Store<UIState, Action>): void {
  const state = store.getState();

  // Sync perPage select
  const perPageSel = root.querySelector<HTMLSelectElement>("#timelinePerPage");
  if (perPageSel) {
    const pp = state.timeline.perPage;
    if (perPageSel.value !== String(pp)) perPageSel.value = String(pp);
  }

  // Sync filter inputs
  setInputValue(root, "#timelineSearch", state.query.timelineSearch);
  setInputValue(root, "#timelineAuthor", state.query.timelineAuthor);
  setInputValue(root, "#timelineAction", state.query.timelineAction);
  setInputValue(root, "#timelineRef", state.query.timelineRef);

  const events = state.repo?.commits ?? [];
  const filtered = filterEvents(events, state.query);

  const perPage = clampInt(state.timeline.perPage, 1, 10_000);
  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));

  const desiredPage = clampInt(state.timeline.page, 0, totalPages - 1);
  // If store page out of range, correct it once (safe; will re-render)
  if (desiredPage !== state.timeline.page) {
    store.dispatch(actions.setTimelinePage(desiredPage));
    return;
  }

  const start = desiredPage * perPage;
  const end = Math.min(filtered.length, start + perPage);
  const slice = filtered.slice(start, end);

  // Update page info + buttons
  const pageInfo = root.querySelector<HTMLElement>("#timelinePageInfo");
  if (pageInfo) {
    pageInfo.textContent = `Oldal: ${desiredPage + 1}/${totalPages} • Találat: ${filtered.length}`;
  }

  const prevBtn = root.querySelector<HTMLButtonElement>("#timelinePrev");
  const nextBtn = root.querySelector<HTMLButtonElement>("#timelineNext");
  if (prevBtn) prevBtn.disabled = desiredPage <= 0;
  if (nextBtn) nextBtn.disabled = desiredPage >= totalPages - 1;

  // Render table body
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
  for (const e of slice) frag.appendChild(renderRow(e));
  tbody.appendChild(frag);
}

function renderRow(e: ReflogEntry): HTMLTableRowElement {
  const tr = document.createElement("tr");

  const action = classifyReflogMessage(e.msg || "");
  const author = formatAuthor(e.authorName, e.authorEmail);
  const ref = e.ref || "—";
  const shaFull = (e.newSha || "").trim();
  const shaShort = shaFull ? shaFull.slice(0, 10) : "—";

  tr.appendChild(td(formatTime(e.ts)));
  tr.appendChild(td(action));
  tr.appendChild(td(author));
  tr.appendChild(td(ref, "mono"));
  tr.appendChild(td(shaShort, "mono"));
  tr.appendChild(td(e.msg || "—"));

  const tools = document.createElement("td");
  tools.className = "timeline-tools";

  const copySha = document.createElement("button");
  copySha.type = "button";
  copySha.className = "btn btn-ghost";
  copySha.textContent = "Copy SHA";
  copySha.dataset.action = "copy";
  copySha.dataset.value = shaFull;
  copySha.disabled = !shaFull;

  const copyRef = document.createElement("button");
  copyRef.type = "button";
  copyRef.className = "btn btn-ghost";
  copyRef.textContent = "Copy ref";
  copyRef.dataset.action = "copy";
  copyRef.dataset.value = e.ref || "";
  copyRef.disabled = !e.ref;

  tools.appendChild(copySha);
  tools.appendChild(copyRef);

  tr.appendChild(tools);
  return tr;
}

/* =============================================================================
 * Wiring
 * ========================================================================== */

function wireUI(root: HTMLElement, store: Store<UIState, Action>): void {
  // Inputs (debounced)
  bindDebouncedInput(root, "#timelineSearch", (v) => store.dispatch(actions.patchQuery({ timelineSearch: v })));
  bindDebouncedInput(root, "#timelineAuthor", (v) => store.dispatch(actions.patchQuery({ timelineAuthor: v })));
  bindDebouncedInput(root, "#timelineAction", (v) => store.dispatch(actions.patchQuery({ timelineAction: v })));
  bindDebouncedInput(root, "#timelineRef", (v) => store.dispatch(actions.patchQuery({ timelineRef: v })));

  // Paging buttons
  const prevBtn = root.querySelector<HTMLButtonElement>("#timelinePrev");
  const nextBtn = root.querySelector<HTMLButtonElement>("#timelineNext");
  const perPageSel = root.querySelector<HTMLSelectElement>("#timelinePerPage");

  if (prevBtn) {
    prevBtn.addEventListener("click", () => {
      const s = store.getState();
      store.dispatch(actions.setTimelinePage(Math.max(0, s.timeline.page - 1)));
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      const s = store.getState();
      store.dispatch(actions.setTimelinePage(s.timeline.page + 1));
    });
  }

  if (perPageSel) {
    perPageSel.addEventListener("change", () => {
      const n = Number.parseInt(perPageSel.value, 10);
      if (!Number.isFinite(n) || n <= 0) return;
      store.dispatch(actions.setTimelinePerPage(n));
      store.dispatch(actions.setTimelinePage(0)); // reset to first page for UX
    });
  }

  // Copy buttons in table (delegation)
  root.addEventListener("click", async (ev) => {
    const t = ev.target as HTMLElement | null;
    if (!t) return;

    const btn = t.closest<HTMLButtonElement>("button");
    if (!btn) return;

    if (btn.dataset.action === "copy") {
      const val = btn.dataset.value ?? "";
      if (!val) return;
      await copyToClipboard(val, store);
    }
  });
}

/* =============================================================================
 * Filtering
 * ========================================================================== */

function filterEvents(events: ReflogEntry[], q: UIState["query"]): ReflogEntry[] {
  const search = norm(q.timelineSearch);
  const author = norm(q.timelineAuthor);
  const action = norm(q.timelineAction);
  const ref = norm(q.timelineRef);

  if (!search && !author && !action && !ref) return events;

  return events.filter((e) => {
    const msg = norm(e.msg);
    const a = norm(`${e.authorName ?? ""} ${e.authorEmail ?? ""}`);
    const r = norm(e.ref);
    const act = norm(classifyReflogMessage(e.msg || ""));
    const sha = norm(`${e.newSha ?? ""} ${e.oldSha ?? ""}`);

    if (author && !a.includes(author)) return false;
    if (action && !act.includes(action)) return false;
    if (ref && !r.includes(ref)) return false;

    if (search) {
      // Support YYYY-MM-DD tokens (Dashboard uses this)
      const day = e.ts ? formatDay(e.ts) : "";
      const blob = `${msg} ${a} ${r} ${act} ${sha} ${day}`.toLowerCase();
      if (!blob.includes(search)) return false;
    }

    return true;
  });
}

function norm(s: string): string {
  return (s || "").trim().toLowerCase();
}

/* =============================================================================
 * Formatting
 * ========================================================================== */

function formatTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "—";
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function formatDay(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  return `${yyyy}-${mm}-${dd}`;
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
    .table td:nth-child(6) { white-space: normal; }
    .table th {
      text-align: left;
      color: var(--muted);
      font-weight: 700;
      font-size: 12px;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }

    .timeline-tools { display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; }
    .mono { font-family: var(--mono); }

    @media (max-width: 980px) {
      .timeline-grid { grid-template-columns: 1fr; }
      /* hide Tools on very small screens if needed */
      .table th:last-child, .table td:last-child { display: none; }
    }
  `;
  document.head.appendChild(style);
}