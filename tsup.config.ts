import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  target: "node18",
  dts: true,
  clean: true,
  splitting: true,
  sourcemap: true,
  external: [
    "node:fs",
    "node:fs/promises",
    "node:path",
    "node:os",
    "node:net",
    "node:url",
    "fs",
    "fs/promises",
    "path",
    "os",
    "net",
    "url",
  ],
});
