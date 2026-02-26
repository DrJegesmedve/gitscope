// apps/ui/src/features/commands/commandsView.ts
// =============================================================================
// GitScope UI — Commands View (Phase 1)
// - Heuristic git command suggestions from parsed snapshot (HEAD/refs/config/reflog/stats)
// - Searchable, grouped, copy-to-clipboard actions (with fallback)
// - Self-mounting into panel: [data-view-panel="commands"]
// - No framework; safe DOM guards; XSS-safe output
// =============================================================================

import type { Store, UIState, Action } from "../../app/store";
import { actions } from "../../app/store";

export interface CommandsViewDeps {
  store: Store<UIState, Action>;
}

export interface CommandsViewController {
  mount(): void;
  unmount(): void;
}

type CmdCategory =
  | "Getting started"
  | "Branching"
  | "History"
  | "Sync"
  | "Cleanup"
  | "Diagnostics"
  | "Safety";

interface CommandSuggestion {
  id: string;
  category: CmdCategory;
  title: string;
  command: string;
  reason: string;
  confidence: number; // 0..1
  tags: string[];
}

export function createCommandsView(deps: CommandsViewDeps): CommandsViewController {
  const { store } = deps;

  let root: HTMLElement | null = null;
  let unsub: (() => void) | null = null;

  // local view state
  let searchText = "";
  let categoryFilter: CmdCategory | "All" = "All";

  function mount(): void {
    if (root) return;

    const panel = document.querySelector<HTMLElement>('[data-view-panel="commands"]');
    if (!panel) return;

    root = document.createElement("div");
    root.id = "commandsRoot";
    root.className = "commands-root";
    panel.appendChild(root);

    renderSkeleton(root);
    wireUI(root);

    unsub = store.subscribe(
      (s) => ({
        status: s.status,
        repo: s.repo,
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
    categoryFilter = "All";
  }

  return { mount, unmount };

  /* ---------------------------------------------------------------------- */

  function renderSkeleton(rootEl: HTMLElement): void {
    rootEl.innerHTML = "";

    const top = document.createElement("div");
    top.className = "card commands-controls";
    top.appendChild(h2("Commands"));

    const row = document.createElement("div");
    row.className = "commands-row";

    // Search
    const searchWrap = document.createElement("label");
    searchWrap.className = "commands-field";
    const sl = document.createElement("div");
    sl.className = "label";
    sl.textContent = "Keresés";
    const si = document.createElement("input");
    si.id = "commandsSearch";
    si.className = "input";
    si.type = "text";
    si.placeholder = "Pl. switch, remote, log, rebase, cleanup…";
    searchWrap.appendChild(sl);
    searchWrap.appendChild(si);

    // Category
    const catWrap = document.createElement("label");
    catWrap.className = "commands-field";
    const cl = document.createElement("div");
    cl.className = "label";
    cl.textContent = "Kategória";
    const cs = document.createElement("select");
    cs.id = "commandsCategory";
    cs.className = "input";
    for (const opt of ["All", ...allCategories()] as Array<CmdCategory | "All">) {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt;
      cs.appendChild(o);
    }
    catWrap.appendChild(cl);
    catWrap.appendChild(cs);

    // Actions
    const actionsWrap = document.createElement("div");
    actionsWrap.className = "commands-actions";

    const copyAllBtn = button("Copy all", "commandsCopyAllBtn", "btn btn-ghost");
    const explainBtn = button("Mit látok itt?", "commandsExplainBtn", "btn btn-ghost");
    actionsWrap.appendChild(copyAllBtn);
    actionsWrap.appendChild(explainBtn);

    row.appendChild(searchWrap);
    row.appendChild(catWrap);
    row.appendChild(actionsWrap);

    const meta = document.createElement("div");
    meta.id = "commandsMeta";
    meta.className = "muted";
    meta.style.marginTop = "10px";
    meta.textContent = "—";

    top.appendChild(row);
    top.appendChild(meta);

    const list = document.createElement("div");
    list.id = "commandsList";
    list.className = "commands-list";

    rootEl.appendChild(top);
    rootEl.appendChild(list);

    ensureCommandsStyles();
  }

  function render(rootEl: HTMLElement, state: Readonly<UIState>): void {
    // Sync inputs
    const sInput = rootEl.querySelector<HTMLInputElement>("#commandsSearch");
    if (sInput && sInput.value !== searchText) sInput.value = searchText;

    const cSel = rootEl.querySelector<HTMLSelectElement>("#commandsCategory");
    if (cSel && cSel.value !== categoryFilter) cSel.value = categoryFilter;

    const list = rootEl.querySelector<HTMLElement>("#commandsList");
    const meta = rootEl.querySelector<HTMLElement>("#commandsMeta");
    if (!list || !meta) return;

    const suggestions = buildSuggestions(state);
    const filtered = filterSuggestions(suggestions, searchText, categoryFilter);

    meta.textContent =
      `Javaslatok: ${filtered.length}/${suggestions.length}` +
      (state.repo?.identity?.displayName ? ` • Repo: ${state.repo.identity.displayName}` : "");

    list.innerHTML = "";

    if (!state.repo) {
      list.appendChild(emptyCard("Nincs betöltött projekt. Előbb tölts be egy .git mappát."));
      return;
    }

    if (suggestions.length === 0) {
      list.appendChild(emptyCard("Nincs elég adat a javaslatokhoz (lehet, hogy hiányos a .git tartalom)."));
      return;
    }

    if (filtered.length === 0) {
      list.appendChild(emptyCard("Nincs találat a szűrésre."));
      return;
    }

    // Group by category
    const byCat = new Map<CmdCategory, CommandSuggestion[]>();
    for (const s of filtered) {
      const arr = byCat.get(s.category) ?? [];
      arr.push(s);
      byCat.set(s.category, arr);
    }

    const frag = document.createDocumentFragment();
    for (const cat of allCategories()) {
      const group = byCat.get(cat);
      if (!group || group.length === 0) continue;
      frag.appendChild(renderCategory(cat, group));
    }
    list.appendChild(frag);

    // Enable/disable Copy all
    const copyAll = rootEl.querySelector<HTMLButtonElement>("#commandsCopyAllBtn");
    if (copyAll) copyAll.disabled = filtered.length === 0;
  }

  function wireUI(rootEl: HTMLElement): void {
    // Search (debounced)
    bindDebouncedInput(rootEl, "#commandsSearch", (v) => {
      searchText = v;
      render(rootEl, store.getState());
    });

    // Category
    const cat = rootEl.querySelector<HTMLSelectElement>("#commandsCategory");
    if (cat) {
      cat.addEventListener("change", () => {
        const v = (cat.value || "All") as CmdCategory | "All";
        categoryFilter = v;
        render(rootEl, store.getState());
      });
    }

    // Buttons + Copy actions (delegation)
    rootEl.addEventListener("click", async (ev) => {
      const t = ev.target as HTMLElement | null;
      if (!t) return;

      const btn = t.closest<HTMLButtonElement>("button");
      if (!btn) return;

      if (btn.id === "commandsExplainBtn") {
        store.dispatch(
          actions.setMessage({
            kind: "muted",
            text:
              "Phase 1-ben ezek a javaslatok a .git parse-olt állapotából készülnek (HEAD/refs/reflog/config). " +
              "Phase 2-ben jön a valós git parancsfuttatás és dinamikus ajánlórendszer.",
          })
        );
        return;
      }

      if (btn.id === "commandsCopyAllBtn") {
        const suggestions = filterSuggestions(buildSuggestions(store.getState()), searchText, categoryFilter);
        const text = suggestions.map((s) => s.command).join("\n");
        if (!text) return;
        await copyToClipboard(text, store);
        return;
      }

      if (btn.dataset.action === "copy") {
        const cmd = btn.dataset.value ?? "";
        if (!cmd) return;
        await copyToClipboard(cmd, store);
        return;
      }
    });
  }
}

/* =============================================================================
 * Suggestion engine (Phase 1 heuristics)
 * ========================================================================== */

function buildSuggestions(state: Readonly<UIState>): CommandSuggestion[] {
  const repo = state.repo;
  if (!repo) return [];

  const out: CommandSuggestion[] = [];

  const head = repo.head;
  const refs = repo.refs ?? new Map<string, string>();
  const config = repo.config;
  const stats = repo.stats;

  const branches = listRefs(refs, "refs/heads/");
  const tags = listRefs(refs, "refs/tags/");
  const remotes = listRefs(refs, "refs/remotes/");

  // Remotes from config
  const cfgRemotes = (config?.remotes ?? []).slice();

  // 1) Getting started / Diagnostics
  out.push({
    id: "status",
    category: "Diagnostics",
    title: "Repo állapot gyorsan",
    command: "git status -sb",
    reason: "Gyors áttekintés: branch + staged/unstaged változások.",
    confidence: 0.9,
    tags: ["status", "overview"],
  });

  out.push({
    id: "graph",
    category: "History",
    title: "Commit graf (rövid, dekorált)",
    command: "git log --oneline --decorate --graph --all --max-count=50",
    reason: "Gyors vizuális áttekintés a branch-ek és merge-ek alakulásáról.",
    confidence: 0.85,
    tags: ["log", "graph"],
  });

  // 2) HEAD heuristics
  if (head && head.type === "detached") {
    out.push({
      id: "detached-help",
      category: "Safety",
      title: "Detached HEAD: mentsd el munkád egy branch-be",
      command: "git switch -c saved-work",
      reason: "Detached HEAD-ben a commitok könnyen elveszhetnek, ha nem kapnak branch nevet.",
      confidence: 0.9,
      tags: ["head", "detached", "safety"],
    });

    if (branches.length > 0) {
      const first = branches[0].ref.replace("refs/heads/", "");
      out.push({
        id: "switch-back",
        category: "Branching",
        title: "Visszaváltás egy branch-re",
        command: `git switch ${shellQuote(first)}`,
        reason: "Detached HEAD-ből egy létező branch-re váltás.",
        confidence: 0.75,
        tags: ["switch", "branch"],
      });
    }
  } else if (head && head.type === "ref") {
    const headRef = head.value;
    const headSha = refs.get(headRef);
    if (!headSha) {
      out.push({
        id: "head-missing",
        category: "Diagnostics",
        title: "HEAD ref feloldása / javítás ellenőrzése",
        command: `git show-ref --verify ${shellQuote(headRef)}`,
        reason: "A parse-olt refs-ben nem látszik a HEAD által mutatott ref; érdemes ellenőrizni.",
        confidence: 0.7,
        tags: ["head", "refs"],
      });
    }
  }

  // 3) Remotes heuristics
  if (cfgRemotes.length === 0) {
    out.push({
      id: "no-remote",
      category: "Sync",
      title: "Remote hozzáadása (origin)",
      command: "git remote add origin <URL>",
      reason: "A config alapján nincs remote; push/pull előtt általában kell origin.",
      confidence: 0.8,
      tags: ["remote", "origin"],
    });
  } else {
    out.push({
      id: "list-remotes",
      category: "Diagnostics",
      title: "Remote-ok listázása részletesen",
      command: "git remote -v",
      reason: "Fetch/push URL-ek gyors ellenőrzése.",
      confidence: 0.9,
      tags: ["remote"],
    });

    out.push({
      id: "fetch-all",
      category: "Sync",
      title: "Fetch minden remote-ról",
      command: "git fetch --all --prune",
      reason: "Remote refs frissítése és törölt remote branch-ek eltakarítása.",
      confidence: 0.85,
      tags: ["fetch", "prune"],
    });

    if (remotes.length > 0) {
      out.push({
        id: "branch-vv",
        category: "Diagnostics",
        title: "Branch tracking (ahead/behind)",
        command: "git branch -vv",
        reason: "Látod, mely branch mely remote trackinget használ és mennyire van lemaradva/előrébb.",
        confidence: 0.8,
        tags: ["branch", "tracking"],
      });
    }
  }

  // 4) Branching / cleanup heuristics
  if (branches.length === 0) {
    out.push({
      id: "no-branches",
      category: "Getting started",
      title: "Első branch létrehozása",
      command: "git switch -c main",
      reason: "Ha nincs refs/heads/*, érdemes létrehozni egy első branch-et.",
      confidence: 0.65,
      tags: ["init", "branch"],
    });
  } else {
    out.push({
      id: "list-branches",
      category: "Diagnostics",
      title: "Branch-ek listázása",
      command: "git branch --list",
      reason: "Gyors lista a lokális branch-ekről.",
      confidence: 0.9,
      tags: ["branch"],
    });

    out.push({
      id: "merged-cleanup",
      category: "Cleanup",
      title: "Merged branch-ek listázása",
      command: "git branch --merged",
      reason: "Azok a branch-ek, amik már beolvadtak a jelenlegi ágba — gyakran törölhetők.",
      confidence: 0.75,
      tags: ["cleanup", "branch"],
    });

    if (branches.length >= 20) {
      out.push({
        id: "prune-local",
        category: "Cleanup",
        title: "Régi lokális branch-ek átnézése (részletes)",
        command: "git for-each-ref --format='%(committerdate:short) %(refname:short)' refs/heads | sort",
        reason: "Sok branch esetén segít azonosítani a régen nem használtakat.",
        confidence: 0.7,
        tags: ["cleanup", "refs"],
      });
    }
  }

  // 5) Tags heuristics
  if (tags.length === 0) {
    out.push({
      id: "no-tags",
      category: "History",
      title: "Verzió tag (annotated) készítése",
      command: "git tag -a v0.1.0 -m \"v0.1.0\"",
      reason: "Ha nincs tag, érdemes release pontokat jelölni.",
      confidence: 0.6,
      tags: ["tag", "release"],
    });
  } else {
    out.push({
      id: "list-tags",
      category: "History",
      title: "Tag-ek listázása",
      command: "git tag --list",
      reason: "Gyors lista a tag-ekről.",
      confidence: 0.9,
      tags: ["tag"],
    });
  }

  // 6) Reflog / safety
  const events = repo.commits?.length ?? 0;
  if (events > 0) {
    out.push({
      id: "reflog",
      category: "Safety",
      title: "Reflog megtekintése (mentőöv)",
      command: "git reflog --date=local -n 30",
      reason: "Elveszett commit/branch visszakeresésére a reflog kulcsfontosságú.",
      confidence: 0.8,
      tags: ["reflog", "recovery"],
    });
  } else {
    out.push({
      id: "no-reflog",
      category: "Diagnostics",
      title: "Nincs reflog esemény (ellenőrzés)",
      command: "git reflog -n 10",
      reason: "Ha a .git/logs hiányos, lehet, hogy nem a teljes .git mappa lett betöltve.",
      confidence: 0.6,
      tags: ["reflog"],
    });
  }

  // 7) Sync push hint (only if remote exists)
  if (cfgRemotes.length > 0) {
    const currentBranch = head?.type === "ref" ? shortRefName(head.value, "refs/heads/") : null;
    if (currentBranch) {
      out.push({
        id: "push-set-upstream",
        category: "Sync",
        title: "Első push upstream beállítással",
        command: `git push -u origin ${shellQuote(currentBranch)}`,
        reason: "Kényelmes: később elég a sima git push/pull.",
        confidence: 0.75,
        tags: ["push", "upstream"],
      });
    }
  }

  // 8) Basic safety: fetch before rebase
  out.push({
    id: "fetch-before-rebase",
    category: "Safety",
    title: "Rebase előtt frissítsd a távoli állapotot",
    command: "git fetch --all --prune",
    reason: "Rebase/merge előtt érdemes a remote állapotot frissíteni.",
    confidence: 0.7,
    tags: ["fetch", "safety"],
  });

  // Keep stable ordering: category then confidence desc then title
  out.sort((a, b) => {
    const ca = categoryRank(a.category);
    const cb = categoryRank(b.category);
    if (ca !== cb) return ca - cb;
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    return a.title.localeCompare(b.title);
  });

  // De-duplicate by id (safety)
  const seen = new Set<string>();
  return out.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
}

function listRefs(refs: Map<string, string>, prefix: string): Array<{ ref: string; sha: string }> {
  const out: Array<{ ref: string; sha: string }> = [];
  for (const [ref, sha] of refs.entries()) {
    if (ref.startsWith(prefix)) out.push({ ref, sha });
  }
  out.sort((a, b) => a.ref.localeCompare(b.ref));
  return out;
}

/* =============================================================================
 * Filtering + rendering
 * ========================================================================== */

function filterSuggestions(
  suggestions: CommandSuggestion[],
  search: string,
  category: CmdCategory | "All"
): CommandSuggestion[] {
  const q = norm(search);
  return suggestions.filter((s) => {
    if (category !== "All" && s.category !== category) return false;
    if (!q) return true;

    const blob = `${s.title} ${s.command} ${s.reason} ${s.category} ${s.tags.join(" ")}`.toLowerCase();
    return blob.includes(q);
  });
}

function renderCategory(cat: CmdCategory, items: CommandSuggestion[]): HTMLElement {
  const card = document.createElement("div");
  card.className = "card commands-cat";

  const title = document.createElement("div");
  title.className = "commands-cat-title";
  title.textContent = `${cat} (${items.length})`;

  const list = document.createElement("div");
  list.className = "commands-items";

  const frag = document.createDocumentFragment();
  for (const it of items) frag.appendChild(renderItem(it));
  list.appendChild(frag);

  card.appendChild(title);
  card.appendChild(list);

  return card;
}

function renderItem(it: CommandSuggestion): HTMLElement {
  const box = document.createElement("div");
  box.className = "commands-item";

  const header = document.createElement("div");
  header.className = "commands-item-header";

  const left = document.createElement("div");
  left.className = "commands-item-left";

  const t = document.createElement("div");
  t.className = "commands-item-title";
  t.textContent = it.title;

  const r = document.createElement("div");
  r.className = "commands-item-reason";
  r.textContent = it.reason;

  left.appendChild(t);
  left.appendChild(r);

  const right = document.createElement("div");
  right.className = "commands-item-right";

  const badge = document.createElement("div");
  badge.className = "commands-badge";
  badge.textContent = `${Math.round(it.confidence * 100)}%`;

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "btn btn-ghost";
  copyBtn.textContent = "Copy";
  copyBtn.dataset.action = "copy";
  copyBtn.dataset.value = it.command;

  right.appendChild(badge);
  right.appendChild(copyBtn);

  header.appendChild(left);
  header.appendChild(right);

  const code = document.createElement("pre");
  code.className = "commands-code mono";
  code.textContent = it.command;

  box.appendChild(header);
  box.appendChild(code);

  return box;
}

function emptyCard(text: string): HTMLElement {
  const d = document.createElement("div");
  d.className = "card muted";
  d.textContent = text;
  return d;
}

/* =============================================================================
 * Helpers
 * ========================================================================== */

function norm(s: string): string {
  return (s || "").trim().toLowerCase();
}

function allCategories(): CmdCategory[] {
  return ["Getting started", "Branching", "History", "Sync", "Cleanup", "Diagnostics", "Safety"];
}

function categoryRank(c: CmdCategory): number {
  // stable, human-friendly order
  switch (c) {
    case "Getting started":
      return 1;
    case "Diagnostics":
      return 2;
    case "Branching":
      return 3;
    case "Sync":
      return 4;
    case "History":
      return 5;
    case "Safety":
      return 6;
    case "Cleanup":
      return 7;
  }
}

function shortRefName(ref: string, prefix: string): string | null {
  if (!ref) return null;
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
}

function shellQuote(s: string): string {
  // Simple POSIX-ish safe quoting
  if (!s) return "''";
  if (/^[a-zA-Z0-9._/-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/* =============================================================================
 * DOM utilities
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
 * Styles injection
 * ========================================================================== */

let commandsStylesInjected = false;

function ensureCommandsStyles(): void {
  if (commandsStylesInjected) return;
  commandsStylesInjected = true;

  const style = document.createElement("style");
  style.textContent = `
    .commands-controls { margin-bottom: 12px; }
    .commands-row {
      display: grid;
      grid-template-columns: 1fr 220px 220px;
      gap: 12px;
      align-items: end;
    }
    .commands-field { display: grid; gap: 6px; }
    .commands-actions { display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; }

    .commands-list { display: grid; gap: 12px; }
    .commands-cat-title {
      font-size: 13px;
      color: var(--muted);
      letter-spacing: 0.02em;
      text-transform: uppercase;
      font-weight: 800;
      margin-bottom: 10px;
    }

    .commands-items { display: grid; gap: 10px; }
    .commands-item {
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 12px;
      background: color-mix(in srgb, var(--panel) 88%, transparent);
    }
    .commands-item-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
    }
    .commands-item-title { font-weight: 900; letter-spacing: -0.01em; }
    .commands-item-reason { margin-top: 4px; color: var(--muted); font-size: 12px; line-height: 1.35; }

    .commands-item-right { display: flex; align-items: center; gap: 10px; }
    .commands-badge {
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 6px 10px;
      font-size: 12px;
      color: var(--muted);
      background: color-mix(in srgb, var(--panel) 92%, transparent);
    }

    .commands-code {
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 10px;
      margin: 0;
      overflow: auto;
      background: color-mix(in srgb, var(--panel) 92%, transparent);
      white-space: pre;
      font-size: 12px;
      line-height: 1.35;
    }
    .mono { font-family: var(--mono); }

    @media (max-width: 980px) {
      .commands-row { grid-template-columns: 1fr; align-items: start; }
      .commands-actions { justify-content: flex-start; }
    }
  `;
  document.head.appendChild(style);
}