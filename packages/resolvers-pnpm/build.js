import { build, context } from "esbuild"
import fs from "node:fs"

const args = process.argv.slice(2)

const isDev = args.includes("--dev")

/**
 * @type {import("esbuild").BuildOptions}
 */
const options = {
  entryPoints: ["src/index.ts", "src/__tests__/*.test.ts"],
  outdir: "dist",
  bundle: true,
  sourcemap: true,
  target: "es2022",
  format: "esm",
  platform: "node",
  treeShaking: true,
  minify: !isDev,
  external: ["builderman", "yaml"],
  platform: "node",
}

if (isDev) {
  await context(options).then((ctx) => ctx.watch())
  fs.watch("src/types.d.ts", () => {
    fs.copyFileSync("src/types.d.ts", "dist/index.d.ts")
  })
  console.log("[resolvers-pnpm]: Watching for changes...")
} else {
  await build(options)
  fs.copyFileSync("src/types.d.ts", "dist/index.d.ts")
  console.log("[resolvers-pnpm]: Built successfully")
}
