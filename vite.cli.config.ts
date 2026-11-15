// Builds the command-line tool: one self-contained ES module for Node 18+.
//   npm run build:cli  →  dist-cli/yad-cli.mjs
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

export default defineConfig({
  define: { __YAD_VERSION__: JSON.stringify(version) },
  ssr: { noExternal: true },
  build: {
    ssr: "src/cli/bin.ts",
    target: "node18",
    outDir: "dist-cli",
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      output: { entryFileNames: "yad-cli.mjs", banner: "#!/usr/bin/env node" },
    },
  },
});
