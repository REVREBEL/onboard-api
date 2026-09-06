import { resolve } from "path";
import { defineConfig, loadEnv } from "vite";

const flattenHtmlOutput = {
  name: "flatten-html-output",
  enforce: "post",
  generateBundle(_options, bundle) {
    for (const asset of Object.values(bundle)) {
      if (
        asset.type === "asset" &&
        asset.fileName.startsWith("src/") &&
        asset.fileName.endsWith(".html")
      ) {
        asset.fileName = asset.fileName.replace(/^src\//, "");
      }
    }
  }
};

export default defineConfig(({ mode, isSsrBuild }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const accessCode = env.VITE_INDEX_ACCESS_CODE;

  if (!accessCode) {
    console.error("\n[Onboard] BUILD CONFIG ERROR");
    console.error("[Onboard] VITE_INDEX_ACCESS_CODE is not set.");
    console.error("[Onboard] Add VITE_INDEX_ACCESS_CODE to the Webflow Cloud environment variables, then redeploy.\n");
    throw new Error("Missing required environment variable: VITE_INDEX_ACCESS_CODE");
  }

  console.log("[Onboard] VITE_INDEX_ACCESS_CODE detected for this build.");

  if (isSsrBuild) {
    return {
      root: ".",
      build: {
        rollupOptions: {
          input: resolve(__dirname, "src/worker.ts")
        }
      }
    };
  }

  return {
    root: ".",
    build: {
      outDir: "dist",
      emptyOutDir: true,
      rollupOptions: {
        input: {
          main: resolve(__dirname, "index.html"),
          creator: resolve(__dirname, "src/creator.html"),
          runner: resolve(__dirname, "src/runner.html"),
          admin: resolve(__dirname, "src/admin.html"),
          stats: resolve(__dirname, "src/stats.html")
        }
      }
    },
    plugins: [flattenHtmlOutput]
  };
});
