// apps/ui/src/features/config/configView.ts
// =============================================================================
// GitScope UI — Config View (Phase 1)
// - Displays Git config snapshot (remotes)
// - Health checks: missing config, no remotes, missing URLs
// - Copy actions with clipboard fallback
// - Self-mounting into panel: [data-view-panel="config"]
// =============================================================================

import type { Store, UIState, Action, GitConfigSnapshot, GitRemote } from "../../app/store";
import { actions } from "../../app/store";

export interface ConfigViewDeps {
  store: Store<UIState, Action>;
}

export interface ConfigViewController {
  mount(): void;
  unmount(): void;
}

export function createConfigView(deps: ConfigViewDeps): ConfigViewController {
  const { store } = deps;

  let root: HTMLElement | null = null;
  let unsub: (() => void) | null = null;

  function mount(): void {
    if (root) return;

    const panel = document.querySelector<HTMLElement>('[data-view-panel="config"]');
    if (!panel) return;

    root = document.createElement("div");
    root.id = "configRoot";
    root.className = "config-root";
    panel.appendChild(root);

    renderSkeleton(root);
    wireUI(root);

    unsub = store.subscribe(
      (s) => ({
        status: s.status,
        repoName: s.repo?.identity.displayName ?? "",
        config: s.repo?.config ?? null,
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

  const top = document.createElement("div");
  top.className = "card config-top";
  top.appendChild(h2("Config"));

  const health = document.createElement("div");
  health.id = "configHealth";
  health.className = "config-health";
  top.appendChild(health);

  const meta = document.createElement("div");
  meta.id = "configMeta";
  meta.className = "muted";
  meta.style.marginTop = "10px";
  meta.textContent = "—";
  top.appendChild(meta);

  const tableCard = document.createElement("div");
  tableCard.className = "card";
  tableCard.appendChild(h2("Remotes"));

  const tableWrap = document.createElement("div");
  tableWrap.className = "table-wrap";

  const table = document.createElement("table");
  table.className = "table config-table";

  const thead = document.createElement("thead");
  thead.innerHTML = `
    <tr>
      <th>Name</th>
      <th>Fetch URL</th>
      <th>Push URL</th>
      <th>Actions</th>
    </tr>
  `;
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  tbody.id = "configTbody";
  table.appendChild(tbody);

  tableWrap.appendChild(table);
  tableCard.appendChild(tableWrap);

  const empty = document.createElement("div");
  empty.id = "configEmpty";
  empty.className = "muted";
  empty.style.marginTop = "10px";
  empty.textContent = "Nincs megjeleníthető remote.";
  empty.hidden = true;

  tableCard.appendChild(empty);

  root.appendChild(top);
  root.appendChild(tableCard);

  ensureConfigStyles();
}

function render(root: HTMLElement, state: Readonly<UIState>): void {
  const config = state.repo?.config ?? null;

  const healthEl = root.querySelector<HTMLElement>("#configHealth");
  const metaEl = root.querySelector<HTMLElement>("#configMeta");
  const tbody = root.querySelector<HTMLTableSectionElement>("#configTbody");
  const empty = root.querySelector<HTMLElement>("#configEmpty");

  if (!healthEl || !metaEl || !tbody || !empty) return;

  // Health checks
  const health = computeHealth(config);
  renderHealth(healthEl, health);

  const remotes = (config?.remotes ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
  metaEl.textContent = config
    ? `Remote-ok: ${remotes.length}`
    : "Nincs config (config fájl hiányzik a .git-ben, vagy nem olvasható).";

  tbody.innerHTML = "";
  if (!config || remotes.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const frag = document.createDocumentFragment();
  for (const r of remotes) frag.appendChild(renderRow(r));
  tbody.appendChild(frag);
}

function renderRow(r: GitRemote): HTMLTableRowElement {
  const tr = document.createElement("tr");

  const name = td(r.name, "mono");
  const fetch = td(r.fetch ?? "—", "mono wrap");
  const push = td(r.push ?? "—", "mono wrap");

  const actionsTd = document.createElement("td");
  actionsTd.className = "config-actions";

  const copyFetch = document.createElement("button");
  copyFetch.type = "button";
  copyFetch.className = "btn btn-ghost";
  copyFetch.textContent = "Copy fetch";
  copyFetch.dataset.action = "copy";
  copyFetch.dataset.value = r.fetch ?? "";
  copyFetch.disabled = !r.fetch;

  const copyPush = document.createElement("button");
  copyPush.type = "button";
  copyPush.className = "btn btn-ghost";
  copyPush.textContent = "Copy push";
  copyPush.dataset.action = "copy";
  copyPush.dataset.value = r.push ?? "";
  copyPush.disabled = !r.push;

  actionsTd.appendChild(copyFetch);
  actionsTd.appendChild(copyPush);

  tr.appendChild(name);
  tr.appendChild(fetch);
  tr.appendChild(push);
  tr.appendChild(actionsTd);

  return tr;
}

/* =============================================================================
 * Health
 * ========================================================================== */

type HealthLevel = "ok" | "warn" | "error";

interface HealthItem {
  level: HealthLevel;
  title: string;
  detail?: string;
}

function computeHealth(config: GitConfigSnapshot | null): HealthItem[] {
  const out: HealthItem[] = [];

  if (!config) {
    out.push({
      level: "error",
      title: "Hiányzó config",
      detail: "A .git/config nem található vagy nem olvasható.",
    });
    return out;
  }

  const remotes = config.remotes ?? [];
  if (remotes.length === 0) {
    out.push({
      level: "warn",
      title: "Nincs remote",
      detail: "Nem találtam [remote] szekciókat a configban.",
    });
  } else {
    out.push({ level: "ok", title: "Remote-ok betöltve", detail: `${remotes.length} db` });
  }

  for (const r of remotes) {
    if (!r.fetch && !r.push) {
      out.push({
        level: "warn",
        title: `Remote "${r.name}" URL hiányzik`,
        detail: "Nincs url/fetch és nincs pushurl.",
      });
      continue;
    }
    if (!r.fetch) {
      out.push({
        level: "warn",
        title: `Remote "${r.name}" fetch hiányzik`,
        detail: "Nem találtam url/fetch beállítást.",
      });
    }
    if (!r.push) {
      // pushurl hiánya lehet normális; git ilyenkor a fetch url-t használja pushra is.
      out.push({
        level: "ok",
        title: `Remote "${r.name}" pushurl nincs megadva`,
        detail: "Ez gyakran normális (push a fetch url-re történik).",
      });
    }
    if (r.fetch && r.push && r.fetch !== r.push) {
      out.push({
        level: "ok",
        title: `Remote "${r.name}" fetch≠push`,
        detail: "Külön fetch és push URL van beállítva.",
      });
    }
  }

  // Keep list compact: prioritize errors/warns, then ok
  out.sort((a, b) => levelRank(b.level) - levelRank(a.level));
  return out.slice(0, 8);
}

function levelRank(l: HealthLevel): number {
  switch (l) {
    case "error":
      return 3;
    case "warn":
      return 2;
    case "ok":
      return 1;
  }
}

function renderHealth(container: HTMLElement, items: HealthItem[]): void {
  container.innerHTML = "";
  if (items.length === 0) return;

  const frag = document.createDocumentFragment();
  for (const it of items) frag.appendChild(renderHealthItem(it));
  container.appendChild(frag);
}

function renderHealthItem(it: HealthItem): HTMLElement {
  const row = document.createElement("div");
  row.className = "health-item";
  row.dataset.level = it.level;

  const title = document.createElement("div");
  title.className = "health-title";
  title.textContent = it.title;

  const detail = document.createElement("div");
  detail.className = "health-detail";
  detail.textContent = it.detail ?? "";

  row.appendChild(title);
  if (it.detail) row.appendChild(detail);

  return row;
}

/* =============================================================================
 * UI Events (copy)
 * ========================================================================== */

function wireUI(root: HTMLElement): void {
  root.addEventListener("click", async (ev) => {
    const t = ev.target as HTMLElement | null;
    if (!t) return;

    const btn = t.closest<HTMLButtonElement>("button");
    if (!btn) return;

    if (btn.dataset.action === "copy") {
      const val = btn.dataset.value ?? "";
      if (!val) return;
      const store = getStoreFromGlobal();
      if (!store) return;
      await copyToClipboard(val, store);
    }
  });
}

/**
 * We keep the view module free from bootstrap ordering problems by allowing
 * an optional global store reference (main.ts can set it).
 */
function getStoreFromGlobal(): Store<UIState, Action> | null {
  const anyWin = window as unknown as { __gitscopeStore?: Store<UIState, Action> };
  return anyWin.__gitscopeStore ?? null;
}

/* =============================================================================
 * Clipboard
 * ========================================================================== */

async function copyToClipboard(value: string, store: Store<UIState, Action>): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      store.dispatch(actions.setMessage({ kind: "ok", text: "Másolva a vágólapra." }));
      return;
    }
  } catch {
    // fallback below
  }

  try {
    const ta = document.createElement("textarea");
    ta.value = value;
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
 * DOM helpers
 * ========================================================================== */

function h2(text: string): HTMLElement {
  const h = document.createElement("h2");
  h.className = "card-title";
  h.textContent = text;
  return h;
}

function td(text: string, cls?: string): HTMLTableCellElement {
  const c = document.createElement("td");
  if (cls) c.className = cls;
  c.textContent = text;
  return c;
}

/* =============================================================================
 * Styles injection
 * ========================================================================== */

let configStylesInjected = false;

function ensureConfigStyles(): void {
  if (configStylesInjected) return;
  configStylesInjected = true;

  const style = document.createElement("style");
  style.textContent = `
    .config-top { margin-bottom: 12px; }
    .config-health {
      display: grid;
      gap: 8px;
      margin-top: 10px;
    }
    .health-item {
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 10px;
      background: color-mix(in srgb, var(--panel) 88%, transparent);
    }
    .health-item[data-level="error"] { border-color: color-mix(in srgb, var(--error) 55%, var(--border)); }
    .health-item[data-level="warn"]  { border-color: color-mix(in srgb, var(--warn) 55%, var(--border)); }
    .health-item[data-level="ok"]    { border-color: color-mix(in srgb, var(--ok) 55%, var(--border)); }
    .health-title { font-weight: 800; letter-spacing: -0.01em; }
    .health-detail { margin-top: 4px; color: var(--muted); font-size: 12px; }

    .table-wrap { overflow: auto; }
    .config-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .config-table th, .config-table td {
      border-bottom: 1px solid var(--border);
      padding: 10px 8px;
      vertical-align: top;
      white-space: nowrap;
    }
    .config-table td.wrap { white-space: normal; word-break: break-word; }
    .config-table th {
      text-align: left;
      color: var(--muted);
      font-weight: 700;
      font-size: 12px;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }

    .config-actions { display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; }
    .mono { font-family: var(--mono); }

    @media (max-width: 980px) {
      .config-actions { justify-content: flex-start; }
      .config-table th:nth-child(3), .config-table td:nth-child(3) { display: none; }
    }
  `;
  document.head.appendChild(style);
}