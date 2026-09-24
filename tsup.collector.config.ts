import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['collector/src/cli.ts', 'collector/src/setup.ts'],
  outDir: 'dist/collector',
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  bundle: true,
  external: ['better-sqlite3'],
  noExternal: ['zod'],
  clean: false,
  splitting: false,
});
