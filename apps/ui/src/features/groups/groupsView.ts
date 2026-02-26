// apps/ui/src/features/groups/groupsView.ts
// =============================================================================
// GitScope UI — Groups View (Phase 1, local-only)
// - Local project members list (name/email/role)
// - Import authors from reflog-derived events (repo.commits)
// - Simple per-user analytics (events count)
// - Persists to localStorage (namespaced by repo identity displayName)
// - Self-mounting into panel: [data-view-panel="groups"]
// - No framework; safe DOM guards; XSS-safe output
// =============================================================================

import type { Store, UIState, Action, ReflogEntry } from "../../app/store";
import { actions } from "../../app/store";

export interface GroupsViewDeps {
  store: Store<UIState, Action>;
}

export interface GroupsViewController {
  mount(): void;
  unmount(): void;
}

interface Member {
  id: string; // stable id
  name: string;
  email: string;
  role: string;
  createdAt: number;
}

type SortMode = "name" | "eventsDesc" | "createdDesc";

export function createGroupsView(deps: GroupsViewDeps): GroupsViewController {
  const { store } = deps;

  let root: HTMLElement | null = null;
  let unsub: (() => void) | null = null;

  // local state
  let members: Member[] = [];
  let searchText = "";
  let sortMode: SortMode = "eventsDesc";

  // current repo key for persistence
  let repoKey: string = "no-repo";

  function mount(): void {
    if (root) return;

    const panel = document.querySelector<HTMLElement>('[data-view-panel="groups"]');
    if (!panel) return;

    root = document.createElement("div");
    root.id = "groupsRoot";
    root.className = "groups-root";
    panel.appendChild(root);

    renderSkeleton(root);
    wireUI(root);

    unsub = store.subscribe(
      (s) => ({
        repoName: s.repo?.identity.displayName ?? "",
        commits: s.repo?.commits ?? [],
        status: s.status,
      }),
      (next, prev) => {
        // Repo change => reload storage namespace
        if (next.repoName !== prev.repoName) {
          repoKey = storageKeyForRepo(next.repoName);
          members = loadMembers(repoKey);
        }
        render(root!, store.getState());
      },
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

    const top = document.createElement("div");
    top.className = "card groups-top";
    top.appendChild(h2("Groups"));

    const hint = document.createElement("div");
    hint.className = "muted";
    hint.textContent =
      "Phase 1: local-only taglista (localStorage). Phase 3/4-ben jöhet a szerveres projekt-regisztráció.";
    top.appendChild(hint);

    const controls = document.createElement("div");
    controls.className = "groups-controls";

    // search
    const search = labeledInput("Keresés", "groupsSearch", "név / email / role…");

    // sort
    const sortWrap = document.createElement("label");
    sortWrap.className = "groups-field";
    const sl = document.createElement("div");
    sl.className = "label";
    sl.textContent = "Rendezés";
    const sel = document.createElement("select");
    sel.id = "groupsSort";
    sel.className = "input";
    sel.appendChild(option("eventsDesc", "Events (desc)"));
    sel.appendChild(option("name", "Name (A→Z)"));
    sel.appendChild(option("createdDesc", "Created (new→old)"));
    sortWrap.appendChild(sl);
    sortWrap.appendChild(sel);

    // actions
    const actionsRow = document.createElement("div");
    actionsRow.className = "groups-actions";

    const importBtn = button("Import authors", "groupsImportBtn", "btn btn-secondary");
    const clearBtn = button("Clear", "groupsClearBtn", "btn btn-ghost");
    const exportBtn = button("Export JSON", "groupsExportBtn", "btn btn-ghost");

    actionsRow.appendChild(importBtn);
    actionsRow.appendChild(exportBtn);
    actionsRow.appendChild(clearBtn);

    controls.appendChild(search);
    controls.appendChild(sortWrap);
    controls.appendChild(actionsRow);

    top.appendChild(controls);

    const meta = document.createElement("div");
    meta.id = "groupsMeta";
    meta.className = "muted";
    meta.style.marginTop = "10px";
    meta.textContent = "—";
    top.appendChild(meta);

    const split = document.createElement("div");
    split.className = "groups-split";

    // Form card
    const formCard = document.createElement("div");
    formCard.className = "card";
    formCard.appendChild(h2("Tag hozzáadása"));

    const form = document.createElement("div");
    form.className = "groups-form";

    form.appendChild(labeledInput("Név", "groupsName", "Pl. Kovács Béla"));
    form.appendChild(labeledInput("Email", "groupsEmail", "Pl. bela@example.com"));
    form.appendChild(labeledInput("Role", "groupsRole", "Pl. Owner / Dev / Reviewer"));

    const addBtn = button("Add member", "groupsAddBtn", "btn btn-primary");
    form.appendChild(addBtn);

    formCard.appendChild(form);

    // List card
    const listCard = document.createElement("div");
    listCard.className = "card";
    listCard.appendChild(h2("Tagok"));

    const list = document.createElement("div");
    list.id = "groupsList";
    list.className = "groups-list";
    listCard.appendChild(list);

    split.appendChild(formCard);
    split.appendChild(listCard);

    rootEl.appendChild(top);
    rootEl.appendChild(split);

    ensureGroupsStyles();
  }

  function render(rootEl: HTMLElement, state: Readonly<UIState>): void {
    // Sync search + sort inputs
    const s = rootEl.querySelector<HTMLInputElement>("#groupsSearch");
    if (s && s.value !== searchText) s.value = searchText;

    const sortSel = rootEl.querySelector<HTMLSelectElement>("#groupsSort");
    if (sortSel && sortSel.value !== sortMode) sortSel.value = sortMode;

    // Ensure repoKey set + members loaded at least once
    const newKey = storageKeyForRepo(state.repo?.identity.displayName ?? "");
    if (newKey !== repoKey) {
      repoKey = newKey;
      members = loadMembers(repoKey);
    }

    const eventsByUser = computeEventsByUser(state.repo?.commits ?? []);

    // Filter + sort
    const filtered = filterMembers(members, searchText);
    const sorted = sortMembers(filtered, sortMode, eventsByUser);

    const meta = rootEl.querySelector<HTMLElement>("#groupsMeta");
    if (meta) {
      const repoName = state.repo?.identity.displayName ?? "—";
      meta.textContent =
        `Repo: ${repoName} • Members: ${members.length} • Shown: ${sorted.length} • Storage: ${repoKey}`;
    }

    const listEl = rootEl.querySelector<HTMLElement>("#groupsList");
    if (!listEl) return;

    listEl.innerHTML = "";
    if (sorted.length === 0) {
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.textContent = members.length === 0 ? "Még nincs tag. Adj hozzá vagy importálj." : "Nincs találat.";
      listEl.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const m of sorted) {
      const cnt = eventsByUser.get(keyForAuthor(m.name, m.email)) ?? 0;
      frag.appendChild(renderMemberRow(m, cnt));
    }
    listEl.appendChild(frag);
  }

  /* ---------------------------------------------------------------------- */
  /* Events                                                                  */
  /* ---------------------------------------------------------------------- */

  function wireUI(rootEl: HTMLElement): void {
    // search
    bindDebouncedInput(rootEl, "#groupsSearch", (v) => {
      searchText = v;
      render(rootEl, store.getState());
    });

    // sort
    const sortSel = rootEl.querySelector<HTMLSelectElement>("#groupsSort");
    if (sortSel) {
      sortSel.addEventListener("change", () => {
        const v = sortSel.value as SortMode;
        sortMode = isSortMode(v) ? v : "eventsDesc";
        render(rootEl, store.getState());
      });
    }

    // add member
    const addBtn = rootEl.querySelector<HTMLButtonElement>("#groupsAddBtn");
    if (addBtn) {
      addBtn.addEventListener("click", () => {
        const name = valueOf(rootEl, "#groupsName");
        const email = valueOf(rootEl, "#groupsEmail");
        const role = valueOf(rootEl, "#groupsRole");

        const cleaned = validateMemberInput(name, email, role);
        if (!cleaned.ok) {
          store.dispatch(actions.setMessage({ kind: "warn", text: cleaned.error }));
          return;
        }

        const newM: Member = {
          id: createId(),
          name: cleaned.name,
          email: cleaned.email,
          role: cleaned.role,
          createdAt: Date.now(),
        };

        // Avoid duplicates by email (or by name+email key)
        const k = keyForAuthor(newM.name, newM.email);
        const exists = members.some((m) => keyForAuthor(m.name, m.email) === k);
        if (exists) {
          store.dispatch(actions.setMessage({ kind: "warn", text: "Ilyen név+email már szerepel a listában." }));
          return;
        }

        members = [newM, ...members];
        saveMembers(repoKey, members);

        // clear inputs
        setValue(rootEl, "#groupsName", "");
        setValue(rootEl, "#groupsEmail", "");
        setValue(rootEl, "#groupsRole", "");

        store.dispatch(actions.setMessage({ kind: "ok", text: "Tag hozzáadva." }));
        render(rootEl, store.getState());
      });
    }

    // import authors
    const importBtn = rootEl.querySelector<HTMLButtonElement>("#groupsImportBtn");
    if (importBtn) {
      importBtn.addEventListener("click", () => {
        const commits = store.getState().repo?.commits ?? [];
        const imported = importAuthors(commits, members);
        members = imported.members;
        saveMembers(repoKey, members);

        store.dispatch(
          actions.setMessage({
            kind: "ok",
            text: `Import kész. Új: ${imported.added}, összes tag: ${members.length}.`,
          })
        );
        render(rootEl, store.getState());
      });
    }

    // clear
    const clearBtn = rootEl.querySelector<HTMLButtonElement>("#groupsClearBtn");
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        members = [];
        saveMembers(repoKey, members);
        store.dispatch(actions.setMessage({ kind: "muted", text: "Lista törölve (local-only)." }));
        render(rootEl, store.getState());
      });
    }

    // export
    const exportBtn = rootEl.querySelector<HTMLButtonElement>("#groupsExportBtn");
    if (exportBtn) {
      exportBtn.addEventListener("click", () => {
        const data = JSON.stringify({ repoKey, exportedAt: Date.now(), members }, null, 2);
        downloadText(`gitscope_members_${safeFilename(repoKey)}.json`, data);
        store.dispatch(actions.setMessage({ kind: "ok", text: "Export letöltés elindítva." }));
      });
    }

    // row actions (remove / copy)
    rootEl.addEventListener("click", async (ev) => {
      const t = ev.target as HTMLElement | null;
      if (!t) return;

      const btn = t.closest<HTMLButtonElement>("button");
      if (!btn) return;

      const action = btn.dataset.action;
      const id = btn.dataset.id;
      if (!action || !id) return;

      const m = members.find((x) => x.id === id);
      if (!m) return;

      if (action === "remove") {
        members = members.filter((x) => x.id !== id);
        saveMembers(repoKey, members);
        store.dispatch(actions.setMessage({ kind: "ok", text: "Tag törölve." }));
        render(rootEl, store.getState());
        return;
      }

      if (action === "copy-email") {
        await copyToClipboard(m.email, store);
        return;
      }

      if (action === "copy-line") {
        const line = `${m.name} <${m.email}> — ${m.role}`;
        await copyToClipboard(line, store);
        return;
      }
    });
  }
}

/* =============================================================================
 * Import + analytics
 * ========================================================================== */

function importAuthors(commits: ReflogEntry[], existing: Member[]): { members: Member[]; added: number } {
  const set = new Set(existing.map((m) => keyForAuthor(m.name, m.email)));
  const out = existing.slice();
  let added = 0;

  for (const c of commits) {
    const name = (c.authorName || "").trim();
    const email = (c.authorEmail || "").trim();
    if (!name && !email) continue;

    const cleanName = name || "(unknown)";
    const cleanEmail = email || "(unknown)";
    const k = keyForAuthor(cleanName, cleanEmail);
    if (set.has(k)) continue;

    set.add(k);
    out.unshift({
      id: createId(),
      name: cleanName,
      email: cleanEmail,
      role: "Member",
      createdAt: Date.now(),
    });
    added++;
  }

  return { members: out, added };
}

function computeEventsByUser(commits: ReflogEntry[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const c of commits) {
    const name = (c.authorName || "").trim() || "(unknown)";
    const email = (c.authorEmail || "").trim() || "(unknown)";
    const k = keyForAuthor(name, email);
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return map;
}

function keyForAuthor(name: string, email: string): string {
  return `${(name || "").trim().toLowerCase()}|${(email || "").trim().toLowerCase()}`;
}

/* =============================================================================
 * Pure helpers
 * ========================================================================== */

function filterMembers(list: Member[], search: string): Member[] {
  const q = (search || "").trim().toLowerCase();
  if (!q) return list;
  return list.filter((m) => `${m.name} ${m.email} ${m.role}`.toLowerCase().includes(q));
}

function sortMembers(list: Member[], mode: SortMode, eventsByUser: Map<string, number>): Member[] {
  const arr = list.slice();
  arr.sort((a, b) => {
    if (mode === "name") return a.name.localeCompare(b.name);
    if (mode === "createdDesc") return b.createdAt - a.createdAt;

    // eventsDesc default
    const ea = eventsByUser.get(keyForAuthor(a.name, a.email)) ?? 0;
    const eb = eventsByUser.get(keyForAuthor(b.name, b.email)) ?? 0;
    if (ea !== eb) return eb - ea;
    return a.name.localeCompare(b.name);
  });
  return arr;
}

function isSortMode(v: string): v is SortMode {
  return v === "name" || v === "eventsDesc" || v === "createdDesc";
}

function validateMemberInput(name: string, email: string, role: string): { ok: true; name: string; email: string; role: string } | { ok: false; error: string } {
  const n = (name || "").trim();
  const e = (email || "").trim();
  const r = (role || "").trim() || "Member";

  if (!n && !e) return { ok: false, error: "Adj meg legalább nevet vagy emailt." };
  if (e && !looksLikeEmail(e)) return { ok: false, error: "Az email formátuma gyanús (pl. name@domain)." };

  return { ok: true, name: n || "(unknown)", email: e || "(unknown)", role: r };
}

function looksLikeEmail(s: string): boolean {
  // lightweight check, not RFC strict
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function storageKeyForRepo(displayName: string): string {
  const base = (displayName || "no-repo").trim().toLowerCase();
  const safe = base.replace(/[^a-z0-9._-]+/g, "_").slice(0, 80);
  return `gitscope.members.${safe || "no-repo"}`;
}

function loadMembers(key: string): Member[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((x) => normalizeMember(x))
      .filter((m): m is Member => Boolean(m));
  } catch {
    return [];
  }
}

function saveMembers(key: string, list: Member[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // ignore storage errors (quota/private mode)
  }
}

function normalizeMember(x: unknown): Member | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;

  const id = typeof o.id === "string" ? o.id : createId();
  const name = typeof o.name === "string" ? o.name : "(unknown)";
  const email = typeof o.email === "string" ? o.email : "(unknown)";
  const role = typeof o.role === "string" ? o.role : "Member";
  const createdAt = typeof o.createdAt === "number" && Number.isFinite(o.createdAt) ? o.createdAt : Date.now();

  return { id, name, email, role, createdAt };
}

function createId(): string {
  // stable-enough: time + random
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
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

function option(value: string, text: string): HTMLOptionElement {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = text;
  return o;
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
  wrap.className = "groups-field";

  const l = document.createElement("div");
  l.className = "label";
  l.textContent = label;

  const input = document.createElement("input");
  input.id = id;
  input.className = "input";
  input.type = "text";
  input.placeholder = placeholder;

  wrap.appendChild(l);
  wrap.appendChild(input);
  return wrap;
}

function valueOf(root: HTMLElement, selector: string): string {
  const el = root.querySelector<HTMLInputElement>(selector);
  return el?.value ?? "";
}

function setValue(root: HTMLElement, selector: string, value: string): void {
  const el = root.querySelector<HTMLInputElement>(selector);
  if (!el) return;
  el.value = value;
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
 * Row rendering
 * ========================================================================== */

function renderMemberRow(m: Member, eventsCount: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "groups-item";

  const left = document.createElement("div");
  left.className = "groups-item-left";

  const name = document.createElement("div");
  name.className = "groups-item-name";
  name.textContent = m.name;

  const meta = document.createElement("div");
  meta.className = "groups-item-meta mono";
  meta.textContent = `${m.email} • ${m.role}`;

  const stats = document.createElement("div");
  stats.className = "groups-item-stats";
  stats.textContent = `events: ${eventsCount}`;

  left.appendChild(name);
  left.appendChild(meta);
  left.appendChild(stats);

  const right = document.createElement("div");
  right.className = "groups-item-actions";

  const copyEmail = document.createElement("button");
  copyEmail.type = "button";
  copyEmail.className = "btn btn-ghost";
  copyEmail.textContent = "Copy email";
  copyEmail.dataset.action = "copy-email";
  copyEmail.dataset.id = m.id;

  const copyLine = document.createElement("button");
  copyLine.type = "button";
  copyLine.className = "btn btn-ghost";
  copyLine.textContent = "Copy line";
  copyLine.dataset.action = "copy-line";
  copyLine.dataset.id = m.id;

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn btn-ghost";
  remove.textContent = "Remove";
  remove.dataset.action = "remove";
  remove.dataset.id = m.id;

  right.appendChild(copyEmail);
  right.appendChild(copyLine);
  right.appendChild(remove);

  row.appendChild(left);
  row.appendChild(right);

  return row;
}

/* =============================================================================
 * Clipboard + download
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

    store.dispatch(actions.setMessage({ kind: ok ? "ok" : "warn", text: ok ? "Másolva a vágólapra." : "Nem sikerült másolni." }));
  } catch {
    store.dispatch(actions.setMessage({ kind: "warn", text: "Nem sikerült másolni." }));
  }
}

function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

function safeFilename(s: string): string {
  return (s || "export").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}

/* =============================================================================
 * Styles injection
 * ========================================================================== */

let groupsStylesInjected = false;

function ensureGroupsStyles(): void {
  if (groupsStylesInjected) return;
  groupsStylesInjected = true;

  const style = document.createElement("style");
  style.textContent = `
    .groups-top { margin-bottom: 12px; }
    .groups-controls {
      display: grid;
      grid-template-columns: 1fr 220px 1fr;
      gap: 12px;
      align-items: end;
      margin-top: 12px;
    }
    .groups-field { display: grid; gap: 6px; }
    .groups-actions { display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; }

    .groups-split {
      display: grid;
      grid-template-columns: 420px 1fr;
      gap: 12px;
      align-items: start;
      min-width: 0;
    }
    .groups-form { display: grid; gap: 10px; }
    .groups-list { display: grid; gap: 10px; }

    .groups-item {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 12px;
      background: color-mix(in srgb, var(--panel) 88%, transparent);
      min-width: 0;
    }
    .groups-item-left { display: grid; gap: 4px; min-width: 0; }
    .groups-item-name { font-weight: 900; letter-spacing: -0.01em; }
    .groups-item-meta { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .groups-item-stats { color: var(--muted); font-size: 12px; }

    .groups-item-actions { display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
    .mono { font-family: var(--mono); }

    @media (max-width: 980px) {
      .groups-controls { grid-template-columns: 1fr; align-items: start; }
      .groups-actions { justify-content: flex-start; }
      .groups-split { grid-template-columns: 1fr; }
      .groups-item-actions { justify-content: flex-start; }
    }
  `;
  document.head.appendChild(style);
}