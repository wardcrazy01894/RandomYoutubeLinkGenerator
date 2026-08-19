import { defineConfig } from 'vite'

// GitHub Pages serves project sites from /<repo>/, so the base path must match.
// Overridable for local preview and for a future custom domain.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/RandomYoutubeLinkGenerator/',
  build: { outDir: 'dist', sourcemap: false },
  publicDir: 'public',
})
