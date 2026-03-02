import { cp } from "fs/promises";
import { join } from "path";

const result = await Bun.build({
  entrypoints: ["src/extension.ts"],
  outdir: "dist",
  target: "node",
  format: "cjs",
  sourcemap: "external",
  external: ["vscode"],
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

// Copy sql-wasm.wasm to dist/
await cp(
  join("node_modules", "sql.js", "dist", "sql-wasm.wasm"),
  join("dist", "sql-wasm.wasm")
);

console.log("Build complete.");
