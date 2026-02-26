// apps/ui/src/features/dashboard/dashboardView.ts
// =============================================================================
// GitScope UI — Dashboard View (Phase 1)
// - Real stats computed from parsed snapshot (reflog events + refs + config)
// - Mini charts using SVG (no external libs)
// - Clickable insights: apply Timeline filters and switch view
// - Self-mounting into panel: [data-view-panel="dashboard"]
// - No framework; safe DOM guards; XSS-safe output
// =============================================================================

import type { Store, UIState, Action, ReflogEntry } from "../../app/store";
import { actions } from "../../app/store";
import { classifyReflogMessage } from "../../git/analyzer";

export interface DashboardViewDeps {
  store: Store<UIState, Action>;
}

export interface DashboardViewController {
  mount(): void;
  unmount(): void;
}

type BucketMode = "day";

interface AuthorStat {
  key: string;
  name: string;
  email: string;
  events: number;
}

interface ActionStat {
  action: string;
  events: number;
}

interface TimeBucket {
  label: string; // YYYY-MM-DD
  ts: number; // bucket start
  events: number;
}

export function createDashboardView(deps: DashboardViewDeps): DashboardViewController {
  const { store } = deps;

  let root: HTMLElement | null = null;
  let unsub: (() => void) | null = null;

  function mount(): void {
    if (root) return;

    const panel = document.querySelector<HTMLElement>('[data-view-panel="dashboard"]');
    if (!panel) return;

    root = document.createElement("div");
    root.id = "dashboardRoot";
    root.className = "dashboard-root";
    panel.appendChild(root);

    renderSkeleton(root);
    wireUI(root);

    unsub = store.subscribe(
      (s) => ({
        repo: s.repo,
        status: s.status,
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

  /* ---------------------------------------------------------------------- */

  function renderSkeleton(rootEl: HTMLElement): void {
    rootEl.innerHTML = "";

    const wrap = document.createElement("div");
    wrap.className = "dashboard-grid";

    // KPI row
    const kpi = document.createElement("div");
    kpi.className = "dashboard-kpis";

    kpi.appendChild(kpiCard("Események", "dashKpiEvents", "—"));
    kpi.appendChild(kpiCard("Authors", "dashKpiAuthors", "—"));
    kpi.appendChild(kpiCard("Branches", "dashKpiBranches", "—"));
    kpi.appendChild(kpiCard("Remotes", "dashKpiRemotes", "—"));

    // Activity chart
    const activity = document.createElement("div");
    activity.className = "card";
    activity.appendChild(h2("Activity (last 30 days)"));

    const activityHint = document.createElement("div");
    activityHint.id = "dashActivityHint";
    activityHint.className = "muted";
    activityHint.textContent = "—";
    activity.appendChild(activityHint);

    const activityChart = document.createElement("div");
    activityChart.id = "dashActivityChart";
    activity.appendChild(activityChart);

    // Top authors
    const authors = document.createElement("div");
    authors.className = "card";
    authors.appendChild(h2("Top authors"));

    const authorsList = document.createElement("div");
    authorsList.id = "dashAuthorsList";
    authorsList.className = "dash-list";
    authors.appendChild(authorsList);

    // Actions breakdown
    const actionsCard = document.createElement("div");
    actionsCard.className = "card";
    actionsCard.appendChild(h2("Actions breakdown"));

    const actionsChart = document.createElement("div");
    actionsChart.id = "dashActionsChart";
    actionsCard.appendChild(actionsChart);

    const actionsList = document.createElement("div");
    actionsList.id = "dashActionsList";
    actionsList.className = "dash-list";
    actionsCard.appendChild(actionsList);

    // Health quick checks
    const health = document.createElement("div");
    health.className = "card";
    health.appendChild(h2("Quick health"));

    const healthList = document.createElement("div");
    healthList.id = "dashHealthList";
    healthList.className = "dash-list";
    health.appendChild(healthList);

    wrap.appendChild(kpi);
    wrap.appendChild(activity);
    wrap.appendChild(authors);
    wrap.appendChild(actionsCard);
    wrap.appendChild(health);

    rootEl.appendChild(wrap);

    ensureDashboardStyles();
  }

  function render(rootEl: HTMLElement, state: Readonly<UIState>): void {
    const repo = state.repo;

    if (!repo) {
      setText(rootEl, "#dashKpiEvents", "—");
      setText(rootEl, "#dashKpiAuthors", "—");
      setText(rootEl, "#dashKpiBranches", "—");
      setText(rootEl, "#dashKpiRemotes", "—");
      setText(rootEl, "#dashActivityHint", "Nincs betöltött projekt.");
      setHTMLSafe(rootEl, "#dashActivityChart", emptyCard("Tölts be egy .git mappát a statokhoz."));
      setHTMLSafe(rootEl, "#dashAuthorsList", emptyCard("—"));
      setHTMLSafe(rootEl, "#dashActionsChart", "");
      setHTMLSafe(rootEl, "#dashActionsList", emptyCard("—"));
      setHTMLSafe(rootEl, "#dashHealthList", emptyCard("—"));
      return;
    }

    const events = repo.commits ?? [];
    const refs = repo.refs ?? new Map<string, string>();
    const cfgRemotes = repo.config?.remotes ?? [];
    const branches = countByPrefix(refs, "refs/heads/");
    const authors = computeTopAuthors(events, 8);
    const actionsStats = computeActions(events, 10);
    const buckets = bucketize(events, "day", 30);

    // KPIs
    setText(rootEl, "#dashKpiEvents", String(events.length));
    setText(rootEl, "#dashKpiAuthors", String(authors.length));
    setText(rootEl, "#dashKpiBranches", String(branches));
    setText(rootEl, "#dashKpiRemotes", String(cfgRemotes.length));

    // Activity
    setText(
      rootEl,
      "#dashActivityHint",
      buckets.length > 0 ? `Napi bucketek: ${buckets.length} • Kattints egy oszlopra timeline szűréshez.` : "Nincs aktivitás adat."
    );
    renderActivityChart(rootEl, buckets);

    // Authors list
    renderAuthorsList(rootEl, authors);

    // Actions chart + list
    renderActions(rootEl, actionsStats);

    // Health
    renderHealth(rootEl, repo, refs);
  }

  /* ---------------------------------------------------------------------- */
  /* UI events                                                                */
  /* ---------------------------------------------------------------------- */

  function wireUI(rootEl: HTMLElement): void {
    // Delegated click: data-action
    rootEl.addEventListener("click", (ev) => {
      const t = ev.target as HTMLElement | null;
      if (!t) return;

      const btn = t.closest<HTMLElement>("[data-action]");
      if (!btn) return;

      const action = btn.getAttribute("data-action");
      if (!action) return;

      if (action === "filter-author") {
        const author = btn.getAttribute("data-author") ?? "";
        if (!author) return;

        store.dispatch(actions.patchQuery({ timelineAuthor: author, timelineSearch: "", timelineAction: "", timelineRef: "" }));
        store.dispatch(actions.setView("timeline"));
        store.dispatch(actions.setMessage({ kind: "ok", text: `Timeline szűrve authorra: ${author}` }));
        return;
      }

      if (action === "filter-action") {
        const act = btn.getAttribute("data-value") ?? "";
        if (!act) return;

        store.dispatch(actions.patchQuery({ timelineAction: act, timelineSearch: "", timelineAuthor: "", timelineRef: "" }));
        store.dispatch(actions.setView("timeline"));
        store.dispatch(actions.setMessage({ kind: "ok", text: `Timeline szűrve actionre: ${act}` }));
        return;
      }

      if (action === "filter-date") {
        const day = btn.getAttribute("data-value") ?? "";
        if (!day) return;

        // Phase 1: date filter as search token (simple + robust)
        store.dispatch(actions.patchQuery({ timelineSearch: day, timelineAuthor: "", timelineAction: "", timelineRef: "" }));
        store.dispatch(actions.setView("timeline"));
        store.dispatch(actions.setMessage({ kind: "ok", text: `Timeline szűrve napra: ${day}` }));
        return;
      }
    });
  }
}

/* =============================================================================
 * Stats
 * ========================================================================== */

function computeTopAuthors(events: ReflogEntry[], topN: number): AuthorStat[] {
  const map = new Map<string, AuthorStat>();

  for (const e of events) {
    const name = (e.authorName || "").trim() || "(unknown)";
    const email = (e.authorEmail || "").trim() || "(unknown)";
    const key = `${name.toLowerCase()}|${email.toLowerCase()}`;

    const cur = map.get(key);
    if (!cur) {
      map.set(key, { key, name, email, events: 1 });
    } else {
      cur.events += 1;
    }
  }

  return Array.from(map.values())
    .sort((a, b) => b.events - a.events || a.name.localeCompare(b.name))
    .slice(0, topN);
}

function computeActions(events: ReflogEntry[], topN: number): ActionStat[] {
  const map = new Map<string, number>();
  for (const e of events) {
    const a = classifyReflogMessage(e.msg || "");
    map.set(a, (map.get(a) ?? 0) + 1);
  }
  const out = Array.from(map.entries()).map(([action, events]) => ({ action, events }));
  out.sort((a, b) => b.events - a.events || a.action.localeCompare(b.action));
  return out.slice(0, topN);
}

function bucketize(events: ReflogEntry[], mode: BucketMode, days: number): TimeBucket[] {
  if (mode !== "day") return [];

  const now = Date.now();
  const start = now - days * 24 * 60 * 60 * 1000;

  // Create buckets for each day
  const buckets = new Map<string, TimeBucket>();
  for (let i = 0; i < days; i++) {
    const ts = floorToDay(start + i * 24 * 60 * 60 * 1000);
    const label = formatDay(ts);
    buckets.set(label, { label, ts, events: 0 });
  }

  for (const e of events) {
    if (!Number.isFinite(e.ts) || e.ts <= 0) continue;
    if (e.ts < start) continue;

    const day = formatDay(floorToDay(e.ts));
    const b = buckets.get(day);
    if (b) b.events += 1;
  }

  return Array.from(buckets.values()).sort((a, b) => a.ts - b.ts);
}

function floorToDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function formatDay(ts: number): string {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function countByPrefix(refs: Map<string, string>, prefix: string): number {
  let c = 0;
  for (const k of refs.keys()) if (k.startsWith(prefix)) c++;
  return c;
}

/* =============================================================================
 * Rendering subparts
 * ========================================================================== */

function renderAuthorsList(root: HTMLElement, authors: AuthorStat[]): void {
  const el = root.querySelector<HTMLElement>("#dashAuthorsList");
  if (!el) return;

  el.innerHTML = "";
  if (authors.length === 0) {
    el.appendChild(mutedLine("Nincs author adat."));
    return;
  }

  const frag = document.createDocumentFragment();
  for (const a of authors) frag.appendChild(authorRow(a));
  el.appendChild(frag);

  function authorRow(a: AuthorStat): HTMLElement {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "dash-row";
    row.setAttribute("data-action", "filter-author");
    row.setAttribute("data-author", a.email !== "(unknown)" ? a.email : a.name);

    const left = document.createElement("div");
    left.className = "dash-row-left";

    const title = document.createElement("div");
    title.className = "dash-title";
    title.textContent = a.name;

    const sub = document.createElement("div");
    sub.className = "dash-sub mono";
    sub.textContent = a.email;

    left.appendChild(title);
    left.appendChild(sub);

    const right = document.createElement("div");
    right.className = "dash-right mono";
    right.textContent = String(a.events);

    row.appendChild(left);
    row.appendChild(right);
    return row;
  }
}

function renderActions(root: HTMLElement, actionsStats: ActionStat[]): void {
  const chartEl = root.querySelector<HTMLElement>("#dashActionsChart");
  const listEl = root.querySelector<HTMLElement>("#dashActionsList");
  if (!chartEl || !listEl) return;

  chartEl.innerHTML = "";
  listEl.innerHTML = "";

  if (actionsStats.length === 0) {
    listEl.appendChild(mutedLine("Nincs action adat."));
    return;
  }

  // Chart: horizontal bars (SVG)
  const max = Math.max(...actionsStats.map((a) => a.events), 1);
  chartEl.appendChild(svgBarChart(actionsStats.map((a) => ({ label: a.action, value: a.events })), max));

  const frag = document.createDocumentFragment();
  for (const a of actionsStats) frag.appendChild(actionRow(a));
  listEl.appendChild(frag);

  function actionRow(a: ActionStat): HTMLElement {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "dash-row";
    row.setAttribute("data-action", "filter-action");
    row.setAttribute("data-value", a.action);

    const left = document.createElement("div");
    left.className = "dash-row-left";

    const title = document.createElement("div");
    title.className = "dash-title";
    title.textContent = a.action;

    const sub = document.createElement("div");
    sub.className = "dash-sub";
    sub.textContent = "Kattints timeline szűréshez.";

    left.appendChild(title);
    left.appendChild(sub);

    const right = document.createElement("div");
    right.className = "dash-right mono";
    right.textContent = String(a.events);

    row.appendChild(left);
    row.appendChild(right);
    return row;
  }
}

function renderActivityChart(root: HTMLElement, buckets: TimeBucket[]): void {
  const el = root.querySelector<HTMLElement>("#dashActivityChart");
  if (!el) return;

  el.innerHTML = "";
  if (buckets.length === 0) {
    el.appendChild(mutedLine("Nincs activity adat."));
    return;
  }

  const max = Math.max(...buckets.map((b) => b.events), 1);
  el.appendChild(svgSparkBars(buckets, max));
}

function renderHealth(root: HTMLElement, repo: UIState["repo"], refs: Map<string, string>): void {
  const el = root.querySelector<HTMLElement>("#dashHealthList");
  if (!el) return;

  el.innerHTML = "";

  if (!repo) {
    el.appendChild(mutedLine("—"));
    return;
  }

  const items: Array<{ level: "ok" | "warn" | "error"; title: string; detail?: string }> = [];

  // HEAD
  const head = repo.head;
  if (!head) {
    items.push({ level: "warn", title: "HEAD hiányzik", detail: "Nem sikerült értelmezni a .git/HEAD fájlt." });
  } else if (head.type === "detached") {
    items.push({ level: "warn", title: "Detached HEAD", detail: "Mentéshez hozz létre branch-et." });
  } else {
    const sha = refs.get(head.value);
    items.push({
      level: sha ? "ok" : "warn",
      title: `HEAD → ${head.value}`,
      detail: sha ? `SHA: ${sha.slice(0, 12)}` : "A HEAD ref nincs a refs mapben (ellenőrzés ajánlott).",
    });
  }

  // Remotes
  const remotes = repo.config?.remotes ?? [];
  if (remotes.length === 0) {
    items.push({ level: "warn", title: "Nincs remote", detail: "Push/pull előtt add hozzá az origint." });
  } else {
    const missingFetch = remotes.filter((r) => !r.fetch).length;
    items.push({
      level: missingFetch ? "warn" : "ok",
      title: `Remotes: ${remotes.length}`,
      detail: missingFetch ? `${missingFetch} remote fetch URL nélkül.` : "Fetch URL-ek rendben.",
    });
  }

  // Reflog
  const events = repo.commits?.length ?? 0;
  items.push({
    level: events > 0 ? "ok" : "warn",
    title: "Reflog events",
    detail: events > 0 ? `${events} esemény` : "Nincs reflog esemény (lehet hiányos a .git/logs).",
  });

  // Sort severity
  items.sort((a, b) => severityRank(b.level) - severityRank(a.level));

  const frag = document.createDocumentFragment();
  for (const it of items.slice(0, 8)) frag.appendChild(healthRow(it.level, it.title, it.detail));
  el.appendChild(frag);
}

function severityRank(l: "ok" | "warn" | "error"): number {
  return l === "error" ? 3 : l === "warn" ? 2 : 1;
}

/* =============================================================================
 * SVG charts (no libs)
 * ========================================================================== */

function svgBarChart(data: Array<{ label: string; value: number }>, max: number): SVGElement {
  const W = 640;
  const rowH = 26;
  const pad = 10;
  const labelW = 160;
  const barW = W - pad * 2 - labelW - 90;
  const H = pad * 2 + data.length * rowH;

  const svg = svgEl("svg", { width: "100%", viewBox: `0 0 ${W} ${H}`, role: "img" });

  // background rect
  svg.appendChild(svgEl("rect", { x: "0", y: "0", width: String(W), height: String(H), rx: "12", fill: "transparent" }));

  data.forEach((d, i) => {
    const y = pad + i * rowH + 4;

    const label = svgEl("text", {
      x: String(pad),
      y: String(y + 14),
      "font-size": "12",
      "font-family": "var(--mono)",
      fill: "var(--muted)",
    });
    label.textContent = truncate(d.label, 20);
    svg.appendChild(label);

    const bw = Math.max(0, Math.round((d.value / Math.max(max, 1)) * barW));

    svg.appendChild(svgEl("rect", {
      x: String(pad + labelW),
      y: String(y),
      width: String(barW),
      height: "16",
      rx: "8",
      fill: "color-mix(in srgb, var(--border) 40%, transparent)",
    }));

    svg.appendChild(svgEl("rect", {
      x: String(pad + labelW),
      y: String(y),
      width: String(bw),
      height: "16",
      rx: "8",
      fill: "color-mix(in srgb, var(--accent) 70%, transparent)",
    }));

    const val = svgEl("text", {
      x: String(pad + labelW + barW + 10),
      y: String(y + 14),
      "font-size": "12",
      "font-family": "var(--mono)",
      fill: "var(--text)",
    });
    val.textContent = String(d.value);
    svg.appendChild(val);
  });

  return svg;
}

function svgSparkBars(buckets: TimeBucket[], max: number): HTMLElement {
  // Clickable bars: we render as buttons wrapping SVG for accessibility.
  const wrap = document.createElement("div");
  wrap.className = "dash-spark";

  // Show last 30 buckets max
  const data = buckets.slice(-30);

  for (const b of data) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dash-spark-bar";
    btn.title = `${b.label}: ${b.events}`;
    btn.setAttribute("data-action", "filter-date");
    btn.setAttribute("data-value", b.label);

    const h = Math.round((b.events / Math.max(max, 1)) * 52);
    btn.style.height = `${Math.max(6, h)}px`;

    // tiny label on hover via title; no inner text to keep minimal
    wrap.appendChild(btn);
  }

  return wrap;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/* =============================================================================
 * UI micro helpers
 * ========================================================================== */

function kpiCard(label: string, valueId: string, initial: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "card dash-kpi";

  const l = document.createElement("div");
  l.className = "dash-kpi-label";
  l.textContent = label;

  const v = document.createElement("div");
  v.className = "dash-kpi-value";
  v.id = valueId;
  v.textContent = initial;

  card.appendChild(l);
  card.appendChild(v);
  return card;
}

function h2(text: string): HTMLElement {
  const h = document.createElement("h2");
  h.className = "card-title";
  h.textContent = text;
  return h;
}

function setText(root: HTMLElement, selector: string, text: string): void {
  const el = root.querySelector<HTMLElement>(selector);
  if (el) el.textContent = text;
}

function setHTMLSafe(root: HTMLElement, selector: string, nodeOrHtml: string | HTMLElement): void {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) return;
  el.innerHTML = "";
  if (typeof nodeOrHtml === "string") {
    // This function is only used for internal fixed strings, not user input.
    // Still, prefer nodes; but safe enough here.
    el.textContent = nodeOrHtml;
  } else {
    el.appendChild(nodeOrHtml);
  }
}

function mutedLine(text: string): HTMLElement {
  const d = document.createElement("div");
  d.className = "muted";
  d.textContent = text;
  return d;
}

function emptyCard(text: string): HTMLElement {
  const d = document.createElement("div");
  d.className = "card muted";
  d.textContent = text;
  return d;
}

function truncate(s: string, n: number): string {
  const t = s || "";
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

/* =============================================================================
 * Styles injection
 * ========================================================================== */

let dashStylesInjected = false;

function ensureDashboardStyles(): void {
  if (dashStylesInjected) return;
  dashStylesInjected = true;

  const style = document.createElement("style");
  style.textContent = `
    .dashboard-grid {
      display: grid;
      gap: 12px;
    }
    .dashboard-kpis {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
    }
    .dash-kpi { padding: 14px; }
    .dash-kpi-label { color: var(--muted); font-size: 12px; }
    .dash-kpi-value { font-size: 22px; font-weight: 900; letter-spacing: -0.02em; margin-top: 8px; }

    .dash-list { display: grid; gap: 10px; }
    .dash-row {
      width: 100%;
      text-align: left;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--panel) 88%, transparent);
      color: var(--text);
      padding: 12px;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      gap: 12px;
      min-width: 0;
    }
    .dash-row:hover { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
    .dash-row-left { display: grid; gap: 4px; min-width: 0; }
    .dash-title { font-weight: 900; letter-spacing: -0.01em; }
    .dash-sub { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dash-right { color: var(--muted); font-weight: 900; align-self: center; }

    .dash-spark {
      display: flex;
      gap: 6px;
      align-items: flex-end;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 10px;
      background: color-mix(in srgb, var(--panel) 88%, transparent);
      overflow: auto;
    }
    .dash-spark-bar {
      width: 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: color-mix(in srgb, var(--accent2) 30%, transparent);
      cursor: pointer;
      flex: 0 0 auto;
    }
    .dash-spark-bar:hover {
      border-color: var(--accent2);
      background: color-mix(in srgb, var(--accent2) 55%, transparent);
    }

    .mono { font-family: var(--mono); }

    @media (max-width: 980px) {
      .dashboard-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  `;
  document.head.appendChild(style);
}