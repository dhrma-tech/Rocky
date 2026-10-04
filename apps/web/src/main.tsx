import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ActionsPage } from "./routes/ActionsPage.tsx";
import { AskPage } from "./routes/AskPage.tsx";
import { SettingsPage } from "./routes/SettingsPage.tsx";
import { Shell } from "./Shell.tsx";
import "./styles/app.css";
import { applyTheme } from "./theme.ts";

applyTheme();

const rootRoute = createRootRoute({ component: Shell });
const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: AskPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/actions", component: ActionsPage }),
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
