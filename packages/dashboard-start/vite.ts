/** Shared TanStack Start build for every dashboard. Hosts supply only their routes and entries. */
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import type { PluginOption } from "vite-plus";

type StartOptions = NonNullable<Parameters<typeof tanstackStart>[0]>;
type RouterOptions = NonNullable<StartOptions["router"]>;

/**
 * Build metadata is public page configuration. It is compiled into both bundles so the server
 * document and the browser agree without reading a template at request time.
 */
const buildMetadata = (): PluginOption => ({
  name: "executor-build-metadata",
  config: () => ({
    define: {
      "import.meta.env.VITE_EXECUTOR_BUILD": JSON.stringify(
        process.env.EXECUTOR_BUILD_VERSION ?? "development",
      ),
      "import.meta.env.VITE_EXECUTOR_ENVIRONMENT_NAME": JSON.stringify(
        process.env.EXECUTOR_ENVIRONMENT ?? "development",
      ),
    },
  }),
});

/** Server builds are self-contained; dev keeps dependencies external to Vite's Node module runner. */
const serverBundle = (runtime: "workerd" | "node"): PluginOption => ({
  name: "executor-dashboard-server-bundle",
  config: (_, { command }) => ({
    environments: {
      ssr: {
        resolve: {
          ...(command === "build" ? { noExternal: true } : {}),
          ...(runtime === "workerd" && command === "build"
            ? { conditions: ["workerd", "worker", "module", "import", "default"] }
            : {}),
        },
      },
    },
  }),
});

/** Start owns routing, code splitting, the browser entry and the server document handler. */
export const dashboardStartPlugins = ({
  runtime,
  router = {},
  tailwind = tailwindcss(),
}: {
  readonly runtime: "workerd" | "node";
  readonly router?: Pick<RouterOptions, "codeSplittingOptions">;
  readonly tailwind?: ReturnType<typeof tailwindcss>;
}): Array<PluginOption> => [
  buildMetadata(),
  serverBundle(runtime),
  tanstackStart({
    srcDirectory: "src",
    router: {
      routesDirectory: "implementation/routes",
      generatedRouteTree: "implementation/routeTree.gen.ts",
      entry: "implementation/router.tsx",
      ...router,
    },
    client: { entry: "client.tsx" },
    server: { entry: "server.ts" },
  }),
  react(),
  tailwind,
];
