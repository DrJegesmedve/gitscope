// apps/ui/src/features/live/liveTracking.ts
// =============================================================================
// GitScope UI — Live Tracking (Phase 1)
// - Poll-based refresh loop for directory-handle sourced projects
// - Fully stoppable / restartable, no double loops
// - Does NOT store FileSystemDirectoryHandle in the central store (non-serializable)
// - Coordinates with loaders.refreshFromDirectoryHandle
//
// Official references:
// - setTimeout / clearTimeout (MDN): https://developer.mozilla.org/en-US/docs/Web/API/setTimeout
// - File System Access API (MDN): https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API
// =============================================================================

import type { Store, UIState, Action } from "../../app/store";
import { selectors, actions } from "../../app/store";
import { refreshFromDirectoryHandle } from "../../app/loaders";

export interface LiveTrackingDeps {
  store: Store<UIState, Action>;
  /**
   * Function that returns the active directory handle (if any).
   * - Return null if no handle is available (e.g. user loaded via FileList).
   */
  getDirectoryHandle: () => FileSystemDirectoryHandle | null;
}

export interface LiveTrackingController {
  /** Start listening to store changes; safe to call once. */
  start(): void;
  /** Stop polling + unsubscribe; safe to call multiple times. */
  stop(): void;
  /** True if the polling loop is currently active. */
  isRunning(): boolean;
}

/**
 * Create a controller that manages live tracking based on store state.
 */
export function createLiveTrackingController(deps: LiveTrackingDeps): LiveTrackingController {
  const { store, getDirectoryHandle } = deps;

  let unsubscribe: (() => void) | null = null;
  let timerId: number | null = null;
  let running = false;

  // Internal "generation" token: invalidates older loops on restart/stop
  let gen = 0;

  // Simple backoff on repeated errors (bounded)
  let consecutiveErrors = 0;

  function isRunning(): boolean {
    return running;
  }

  function start(): void {
    if (unsubscribe) return; // already started

    // Subscribe to a minimal slice to avoid unnecessary triggers
    unsubscribe = store.subscribe(
      (s) => ({
        enabled: selectors.liveEnabled(s),
        pollMs: selectors.livePollMs(s),
        source: s.repo?.identity.source ?? null,
        status: selectors.status(s),
      }),
      (next, prev) => {
        // React to state changes
        const changed =
          next.enabled !== prev.enabled ||
          next.pollMs !== prev.pollMs ||
          next.source !== prev.source;

        if (!changed) return;

        // Decide desired run state
        const shouldRun = shouldRunLoop(store.getState(), getDirectoryHandle);

        if (shouldRun) {
          // restart loop with new settings (interval/source might have changed)
          restartLoop();
        } else {
          stopLoop();
        }
      },
      { fireImmediately: true }
    );
  }

  function stop(): void {
    stopLoop();
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  }

  function restartLoop(): void {
    stopLoop();
    startLoop();
  }

  function startLoop(): void {
    if (running) return;

    const handle = getDirectoryHandle();
    if (!handle) return;

    // Must be dir-handle source; otherwise no polling
    const s = store.getState();
    if (s.repo?.identity.source !== "dir-handle") return;

    running = true;
    consecutiveErrors = 0;

    gen++;
    const myGen = gen;

    scheduleNextTick(myGen, /*immediate*/ true);
  }

  function stopLoop(): void {
    running = false;
    gen++; // invalidate scheduled ticks
    consecutiveErrors = 0;

    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  }

  function scheduleNextTick(token: number, immediate: boolean): void {
    const pollMs = clampInt(store.getState().live.pollIntervalMs, 500, 60_000);
    const delay = immediate ? 0 : pollMs;

    // window.setTimeout returns number in browsers
    timerId = window.setTimeout(async () => {
      // Invalidate if loop was restarted/stopped
      if (!running || token !== gen) return;

      const handle = getDirectoryHandle();
      if (!handle) {
        // Handle gone => stop loop
        stopLoop();
        store.dispatch(actions.setMessage({ kind: "warn", text: "Live követés leállt: nincs mappa-hozzáférés." }));
        return;
      }

      // Ensure still valid source
      const st = store.getState();
      if (st.repo?.identity.source !== "dir-handle") {
        stopLoop();
        return;
      }

      // Perform refresh (silent by default; loader updates live tick)
      const res = await refreshFromDirectoryHandle(
        { store },
        handle,
        { silent: true }
      );

      if (!res.ok) {
        consecutiveErrors = Math.min(consecutiveErrors + 1, 10);
        // Gradual backoff: add up to +10s
        const backoffMs = Math.min(consecutiveErrors * 1000, 10_000);

        // Show warning only occasionally to avoid spam
        if (consecutiveErrors === 1 || consecutiveErrors === 3 || consecutiveErrors === 5) {
          store.dispatch(
            actions.setMessage({
              kind: "warn",
              text: `Live frissítés hiba (x${consecutiveErrors}).`,
            })
          );
        }

        // Schedule next tick with backoff; keep loop alive
        timerId = window.setTimeout(() => {
          // keep same token; still checks gen at the start of tick
          scheduleNextTick(token, /*immediate*/ true);
        }, backoffMs);

        return;
      }

      // Reset error streak on success
      consecutiveErrors = 0;

      // Schedule the next normal tick
      scheduleNextTick(token, /*immediate*/ false);
    }, delay);
  }

  return { start, stop, isRunning };
}

/* =============================================================================
 * Decision logic & helpers
 * ========================================================================== */

function shouldRunLoop(
  state: Readonly<UIState>,
  getHandle: () => FileSystemDirectoryHandle | null
): boolean {
  if (!state.live.enabled) return false;
  if (state.repo?.identity.source !== "dir-handle") return false;
  return Boolean(getHandle());
}

function clampInt(n: number, min: number, max: number): number {
  const x = Number.isFinite(n) ? Math.trunc(n) : min;
  return Math.min(max, Math.max(min, x));
}