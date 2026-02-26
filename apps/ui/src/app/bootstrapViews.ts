// apps/ui/src/app/bootstrapViews.ts
import type { Store, UIState, Action } from "./store";
import { createTimelineView } from "../features/timeline/timelineView";
import { createFilesView } from "../features/files/filesView";
import { createRefsView } from "../features/refs/refsView";

export function bootstrapViews(store: Store<UIState, Action>): void {
  createTimelineView({ store }).mount();
  createFilesView({ store }).mount();
  createRefsView({ store }).mount();
}