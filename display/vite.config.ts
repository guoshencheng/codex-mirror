import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  base: '/display/',
  build: { outDir: '../dist-display', emptyOutDir: true },
});
