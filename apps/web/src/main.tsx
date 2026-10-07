import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ActionsPage } from "./routes/ActionsPage.tsx";
import { AskPage } from "./routes/AskPage.tsx";
import { CommitmentsPage } from "./routes/CommitmentsPage.tsx";
import { ConnectorsPage } from "./routes/ConnectorsPage.tsx";
import { MeetingDetailPage } from "./routes/MeetingDetailPage.tsx";
import { MeetingsPage } from "./routes/MeetingsPage.tsx";
import { NotebookDetailPage } from "./routes/NotebookDetailPage.tsx";
import { NotebooksPage } from "./routes/NotebooksPage.tsx";
import { SettingsPage } from "./routes/SettingsPage.tsx";
import { StudyPage } from "./routes/StudyPage.tsx";
import { Shell } from "./Shell.tsx";
import "./styles/app.css";
import { applyTheme } from "./theme.ts";

applyTheme();

const rootRoute = createRootRoute({ component: Shell });
const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: AskPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/notebooks", component: NotebooksPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/notebooks/$id",
    component: NotebookDetailPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/study",
    component: StudyPage,
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
  createRoute({ getParentRoute: () => rootRoute, path: "/connectors", component: ConnectorsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage }),
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
