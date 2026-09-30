/**
 * The plugin UI bundle entry point.
 *
 * The host serves this as a single self-contained ES module and imports seven names from it, one
 * per `ui.slots[].exportName` in `src/manifest.ts`. Those export names are a contract: a rename
 * here yields a plugin that installs and then renders nothing, which is why this file exports
 * exactly the manifest's names and nothing that merely looks like a component.
 *
 * Everything the bundle needs is inlined by esbuild except the specifiers the host rewrites —
 * `react`, `react-dom`, `react/jsx-runtime`, and `@paperclipai/plugin-sdk/ui`. So the only bare
 * imports permitted anywhere under `src/ui` are `react` and `@paperclipai/plugin-sdk/ui`; adding a
 * third-party library would produce a bundle the host cannot resolve. There is deliberately no
 * graph library here: the canvas is ~200 lines of SVG in `components/NodeCanvas.tsx`.
 *
 * No component reads a key string. Every read and every write goes through `hooks/usePolyForge.ts`,
 * which owns the `DATA_KEYS` / `ACTION_KEYS` mapping, so a rename in `packages/protocol` fails the
 * build here rather than failing silently in production.
 */

import type { ReactElement } from "react";
import type {
  PluginDetailTabProps,
  PluginPageProps,
  PluginSidebarProps,
  PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";

import { PolyForgePage as Workspace } from "./pages/PolyForgePage.js";
import { LibrarySection } from "./pages/LibrarySection.js";
import { RunsSection } from "./pages/RunsSection.js";
import { HealthSection } from "./pages/HealthSection.js";
import { PolyForgeHealthWidget as HealthWidget, PolyForgeSidebar as SidebarEntry } from "./components/PolyForgeHealthWidget.js";
import { PolyForgeIssueTab as IssueTabBody } from "./tabs/IssueTab.js";
import { PolyForgeProjectTab as ProjectTabBody } from "./tabs/ProjectTab.js";
import { PolyForgeAgentTab as AgentTabBody } from "./tabs/AgentTab.js";
import { PolyForgeRunTab as RunTabBody } from "./tabs/RunTab.js";

/**
 * Slot `page` / `polyforge` — manifest `exportName: "PolyForgePage"`.
 *
 * The host passes the active context as a prop; the components read the company scope from
 * `useHostContext()` themselves so there is one source of truth, and the prop is accepted because
 * the slot contract provides it. The underscore marks it as intentionally unused.
 */
export function PolyForgePage(_props: PluginPageProps): ReactElement {
  return <Workspace />;
}

/** Slot `sidebar` / `polyforge-nav` — manifest `exportName: "PolyForgeSidebar"`. */
export function PolyForgeSidebar(_props: PluginSidebarProps): ReactElement {
  return <SidebarEntry pluginId={(_props as PluginSidebarProps & { slot: { pluginId: string } }).slot.pluginId} />;
}

/** Slot `dashboardWidget` / `polyforge-health` — manifest `exportName: "PolyForgeHealthWidget"`. */
export function PolyForgeHealthWidget(_props: PluginWidgetProps): ReactElement {
  return <HealthWidget />;
}

/** Slot `detailTab` / `polyforge-issue`, `entityTypes: ["issue"]` — `exportName: "PolyForgeIssueTab"`. */
export function PolyForgeIssueTab(props: PluginDetailTabProps): ReactElement {
  return <IssueTabBody entityId={props.context.entityId} />;
}

/** Slot `detailTab` / `polyforge-project`, `entityTypes: ["project"]` — `exportName: "PolyForgeProjectTab"`. */
export function PolyForgeProjectTab(props: PluginDetailTabProps): ReactElement {
  return <ProjectTabBody entityId={props.context.entityId} />;
}

/** Slot `detailTab` / `polyforge-agent`, `entityTypes: ["agent"]` — `exportName: "PolyForgeAgentTab"`. */
export function PolyForgeAgentTab(props: PluginDetailTabProps): ReactElement {
  return <AgentTabBody entityId={props.context.entityId} />;
}

/** Slot `detailTab` / `polyforge-run`, `entityTypes: ["run"]` — `exportName: "PolyForgeRunTab"`. */
export function PolyForgeRunTab(props: PluginDetailTabProps): ReactElement {
  return <RunTabBody entityId={props.context.entityId} />;
}

// The three page sections are exported as well: a second slot, a future launcher, or a host
// test may want to mount one of them directly rather than the whole workspace.
export { LibrarySection, RunsSection, HealthSection };
