import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  RouterProvider,
} from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ActionsPage } from "./routes/ActionsPage.tsx";
import { AskPage } from "./routes/AskPage.tsx";
import { CommitmentsPage } from "./routes/CommitmentsPage.tsx";
import { HomePage } from "./routes/HomePage.tsx";
import { MeetingDetailPage } from "./routes/MeetingDetailPage.tsx";
import { MeetingsPage } from "./routes/MeetingsPage.tsx";
import { NotebooksPage } from "./routes/NotebooksPage.tsx";
import { Shell } from "./Shell.tsx";
// Self-hosted fonts (no runtime third-party request). Latin subsets cover the UI strings.
import "@fontsource-variable/inter/wght.css";
import "@fontsource/instrument-serif/latin-400.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "./styles/app.css";
import { applyTheme } from "./theme.ts";

applyTheme();

const rootRoute = createRootRoute({ component: Shell });
// Less-used screens (lazyRouteComponent) load on first visit, keeping the first download small.
const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomePage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/ask",
    component: AskPage,
    validateSearch: (s: Record<string, unknown>): { q?: string } =>
      typeof s.q === "string" && s.q.trim() ? { q: s.q.slice(0, 4000) } : {},
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/routines",
    component: lazyRouteComponent(() => import("./routes/RoutinesPage.tsx"), "RoutinesPage"),
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/notebooks", component: NotebooksPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/notebooks/$id",
    component: lazyRouteComponent(
      () => import("./routes/NotebookDetailPage.tsx"),
      "NotebookDetailPage",
    ),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/study",
    component: lazyRouteComponent(() => import("./routes/StudyPage.tsx"), "StudyPage"),
    validateSearch: (s: Record<string, unknown>): { notebook?: string } =>
      typeof s.notebook === "string" && s.notebook ? { notebook: s.notebook } : {},
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/meetings", component: MeetingsPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/meetings/$id",
    component: MeetingDetailPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/commitments",
    component: CommitmentsPage,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/actions", component: ActionsPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/connectors",
    component: lazyRouteComponent(() => import("./routes/ConnectorsPage.tsx"), "ConnectorsPage"),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: lazyRouteComponent(() => import("./routes/SettingsPage.tsx"), "SettingsPage"),
  }),
]);
const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: false } },
});

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
