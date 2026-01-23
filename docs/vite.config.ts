import { defineConfig } from "vite"
import kiru from "vite-plugin-kiru"
import mdx from "@mdx-js/rollup"
import shiki from "@shikijs/rehype"

const baseUrl = process.env.NODE_ENV === "production" ? "/builderman" : "/"

export default defineConfig({
  base: baseUrl,
  plugins: [
    {
      //enforce: "pre",
      ...mdx({
        jsx: false,
        jsxImportSource: "kiru",
        jsxRuntime: "automatic",
        rehypePlugins: [[shiki, { theme: "github-dark" }]],
      }),
    },
    kiru({
      ssg: {
        baseUrl: baseUrl,
        document: "document.tsx",
        page: "index.{tsx,mdx}",
        layout: "layout.tsx",
        // sitemap: {
        //   domain: "https://lankymoose.github.io",
        //   overrides: {
        //     "/": {
        //       changefreq: "daily",
        //       priority: 0.9,
        //     },
        //   },
        // },
      },
    }),
  ],
})
