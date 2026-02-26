// apps/ui/src/features/messages/toastView.ts
// =============================================================================
// GitScope UI — Toast View (Phase 1)
// - Displays store.message as toast notifications (stacked)
// - Auto-hide with pause-on-hover, dismiss, keyboard accessible
// - Self-mounts to document.body (safe, isolated)
// - No framework; XSS-safe (textContent); defensive DOM guards
//
// Expected store shape (defensive):
//   state.message?: { kind: "ok"|"warn"|"error"|"muted"; text: string }
// Produced by: actions.setMessage({ kind, text })
// =============================================================================

import type { Store, UIState, Action } from "../../app/store";

export interface ToastViewDeps {
  store: Store<UIState, Action>;
}

export interface ToastViewController {
  mount(): void;
  unmount(): void;
}

type ToastKind = "ok" | "warn" | "error" | "muted";

interface ToastItem {
  id: string;
  kind: ToastKind;
  text: string;
  createdAt: number;
  ttlMs: number;
}

export function createToastView(deps: ToastViewDeps): ToastViewController {
  const { store } = deps;

  let root: HTMLElement | null = null;
  let unsub: (() => void) | null = null;

  // local stack
  const queue: ToastItem[] = [];
  let lastSig = ""; // dedupe consecutive duplicates

  function mount(): void {
    if (root) return;

    root = document.createElement("div");
    root.id = "toastRoot";
    root.className = "toast-root";
    root.setAttribute("aria-live", "polite");
    root.setAttribute("aria-relevant", "additions");
    document.body.appendChild(root);

    ensureToastStyles();

    unsub = store.subscribe(
      (s) => (s as unknown as { message?: { kind?: string; text?: string } }).message ?? null,
      (msg) => {
        // msg may be null/undefined or malformed; handle safely
        const kind = normalizeKind(msg?.kind);
        const text = (msg?.text ?? "").toString().trim();

        if (!kind || !text) return;

        const sig = `${kind}::${text}`;
        if (sig === lastSig) return; // avoid repeats from re-renders
        lastSig = sig;

        pushToast({ kind, text, ttlMs: defaultTtl(kind) });
        render();
      },
      { fireImmediately: false }
    );

    render();
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
    queue.length = 0;
    lastSig = "";
  }

  return { mount, unmount };

  /* ---------------------------------------------------------------------- */

  function pushToast(input: { kind: ToastKind; text: string; ttlMs: number }): void {
    const item: ToastItem = {
      id: createId(),
      kind: input.kind,
      text: input.text,
      createdAt: Date.now(),
      ttlMs: clampInt(input.ttlMs, 1200, 30_000),
    };

    queue.unshift(item);

    // cap stack
    const MAX = 5;
    if (queue.length > MAX) queue.splice(MAX);

    // schedule auto-dismiss
    scheduleAutoDismiss(item.id, item.ttlMs);
  }

  function scheduleAutoDismiss(id: string, ttlMs: number): void {
    // We don’t store timers per item; we set one timer and check existence at fire time.
    window.setTimeout(() => {
      // if removed already, skip
      const idx = queue.findIndex((t) => t.id === id);
      if (idx < 0) return;

      // if hovered, defer a little
      const card = root?.querySelector<HTMLElement>(`[data-toast-id="${cssEscape(id)}"]`);
      const paused = Boolean(card?.matches(":hover"));
      if (paused) {
        scheduleAutoDismiss(id, 800);
        return;
      }

      queue.splice(idx, 1);
      render();
    }, ttlMs);
  }

  function removeToast(id: string): void {
    const idx = queue.findIndex((t) => t.id === id);
    if (idx >= 0) {
      queue.splice(idx, 1);
      render();
    }
  }

  function clearAll(): void {
    queue.length = 0;
    render();
  }

  function render(): void {
    if (!root) return;

    root.innerHTML = "";

    if (queue.length === 0) return;

    const frag = document.createDocumentFragment();

    // Header row (only if multiple)
    if (queue.length > 1) {
      const bar = document.createElement("div");
      bar.className = "toast-bar";

      const label = document.createElement("div");
      label.className = "toast-bar-label";
      label.textContent = "Notifications";

      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "btn btn-ghost toast-clear";
      clear.textContent = "Clear";
      clear.addEventListener("click", () => clearAll());

      bar.appendChild(label);
      bar.appendChild(clear);
      frag.appendChild(bar);
    }

    for (const item of queue) {
      frag.appendChild(renderToast(item));
    }

    root.appendChild(frag);
  }

  function renderToast(item: ToastItem): HTMLElement {
    const card = document.createElement("div");
    card.className = "toast-card";
    card.dataset.kind = item.kind;
    card.setAttribute("role", item.kind === "error" ? "alert" : "status");
    card.setAttribute("data-toast-id", item.id);

    const left = document.createElement("div");
    left.className = "toast-left";

    const title = document.createElement("div");
    title.className = "toast-title";
    title.textContent = titleForKind(item.kind);

    const text = document.createElement("div");
    text.className = "toast-text";
    text.textContent = item.text;

    left.appendChild(title);
    left.appendChild(text);

    const right = document.createElement("div");
    right.className = "toast-right";

    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "btn btn-ghost toast-dismiss";
    dismiss.textContent = "×";
    dismiss.setAttribute("aria-label", "Dismiss notification");
    dismiss.addEventListener("click", () => removeToast(item.id));

    right.appendChild(dismiss);

    // Progress (visual TTL)
    const prog = document.createElement("div");
    prog.className = "toast-progress";
    prog.dataset.kind = item.kind;

    // animate width from 100% -> 0
    prog.animate(
      [{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }],
      { duration: item.ttlMs, easing: "linear", fill: "forwards" }
    );

    card.appendChild(left);
    card.appendChild(right);
    card.appendChild(prog);

    // Keyboard: ESC dismiss topmost when focused inside
    card.tabIndex = 0;
    card.addEventListener("keydown", (e) => {
      if (e.key === "Escape") removeToast(item.id);
    });

    return card;
  }
}

/* =============================================================================
 * Helpers
 * ========================================================================== */

function normalizeKind(k: unknown): ToastKind | null {
  const v = (k ?? "").toString().trim().toLowerCase();
  if (v === "ok" || v === "warn" || v === "error" || v === "muted") return v;
  return null;
}

function defaultTtl(kind: ToastKind): number {
  switch (kind) {
    case "error":
      return 9000;
    case "warn":
      return 6500;
    case "ok":
      return 4500;
    case "muted":
      return 3800;
  }
}

function titleForKind(kind: ToastKind): string {
  switch (kind) {
    case "ok":
      return "OK";
    case "warn":
      return "Warning";
    case "error":
      return "Error";
    case "muted":
      return "Info";
  }
}

function createId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function clampInt(n: number, min: number, max: number): number {
  const x = Number.isFinite(n) ? Math.trunc(n) : min;
  return Math.min(max, Math.max(min, x));
}

// Minimal CSS.escape fallback
function cssEscape(s: string): string {
  // Good enough for our generated ids (alnum+_).
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/* =============================================================================
 * Styles
 * ========================================================================== */

let toastStylesInjected = false;

function ensureToastStyles(): void {
  if (toastStylesInjected) return;
  toastStylesInjected = true;

  const style = document.createElement("style");
  style.textContent = `
    .toast-root {
      position: fixed;
      right: 14px;
      bottom: 14px;
      display: grid;
      gap: 10px;
      z-index: 9999;
      width: min(420px, calc(100vw - 28px));
      pointer-events: none; /* allow clicks only on cards */
    }
    .toast-bar {
      pointer-events: auto;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--panel) 92%, transparent);
      box-shadow: 0 8px 28px rgba(0,0,0,0.20);
      backdrop-filter: blur(10px);
    }
    .toast-bar-label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }
    .toast-card {
      pointer-events: auto;
      position: relative;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--panel) 92%, transparent);
      box-shadow: 0 8px 28px rgba(0,0,0,0.20);
      backdrop-filter: blur(10px);
      overflow: hidden;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 12px;
      padding: 12px 12px 10px 12px;
      transform: translateY(0);
      animation: toastIn 140ms ease-out;
    }
    @keyframes toastIn {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    .toast-left { display: grid; gap: 6px; min-width: 0; }
    .toast-title {
      font-weight: 900;
      letter-spacing: -0.01em;
      font-size: 13px;
    }
    .toast-text {
      color: var(--text);
      font-size: 13px;
      line-height: 1.35;
      word-break: break-word;
    }
    .toast-right { display: flex; align-items: flex-start; }
    .toast-dismiss {
      width: 34px;
      height: 34px;
      padding: 0;
      font-size: 18px;
      line-height: 1;
    }

    .toast-card[data-kind="ok"]    { border-color: color-mix(in srgb, var(--ok) 45%, var(--border)); }
    .toast-card[data-kind="warn"]  { border-color: color-mix(in srgb, var(--warn) 50%, var(--border)); }
    .toast-card[data-kind="error"] { border-color: color-mix(in srgb, var(--error) 55%, var(--border)); }
    .toast-card[data-kind="muted"] { border-color: color-mix(in srgb, var(--border) 65%, var(--border)); }

    .toast-progress {
      position: absolute;
      left: 0;
      bottom: 0;
      height: 3px;
      width: 100%;
      transform-origin: left center;
      background: color-mix(in srgb, var(--accent) 45%, transparent);
      opacity: 0.9;
    }
    .toast-progress[data-kind="ok"]    { background: color-mix(in srgb, var(--ok) 70%, transparent); }
    .toast-progress[data-kind="warn"]  { background: color-mix(in srgb, var(--warn) 70%, transparent); }
    .toast-progress[data-kind="error"] { background: color-mix(in srgb, var(--error) 70%, transparent); }
    .toast-progress[data-kind="muted"] { background: color-mix(in srgb, var(--accent) 45%, transparent); }

    /* Smaller screens: move to top */
    @media (max-width: 560px) {
      .toast-root {
        right: 10px;
        left: 10px;
        width: auto;
        bottom: auto;
        top: 10px;
      }
    }
  `;
  document.head.appendChild(style);
}