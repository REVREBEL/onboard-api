import { resolve } from "path";
import { defineConfig } from "vite";

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

export default defineConfig(({ isSsrBuild }) => {
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
