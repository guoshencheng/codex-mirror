import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['collector/src/cli.ts'],
  outDir: 'dist/collector',
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  bundle: true,
  external: ['better-sqlite3'],
  clean: false,
  splitting: false,
});
