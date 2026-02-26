// apps/ui/src/app/bootstrapViews.ts
import type { Store, UIState, Action } from "./store";
import { createTimelineView } from "../features/timeline/timelineView";
import { createFilesView } from "../features/files/filesView";
import { createRefsView } from "../features/refs/refsView";
import { createCommandsView } from "../features/commands/commandsView";
import { createGroupsView } from "../features/groups/groupsView";
import { createDashboardView } from "../features/dashboard/dashboardView";
import { createToastView } from "../features/messages/toastView";

export function bootstrapViews(store: Store<UIState, Action>): void {
    createTimelineView({ store }).mount();
    createFilesView({ store }).mount();
    createRefsView({ store }).mount();
    createCommandsView({ store }).mount();
    createGroupsView({ store }).mount();
    createDashboardView({ store }).mount();
    createToastView({ store }).mount();
}