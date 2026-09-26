import { defineConfig } from 'tsdown';

/**
 * The bundle that the npm package runs: one ES module, `dist/main.mjs`, from
 * `src/main.ts`. The dependencies stay external, and npm installs them. The
 * shebang of the entry makes the bundle the `workbench` command.
 */
export default defineConfig({
	entry: ['src/main.ts'],
	format: ['esm'],
	platform: 'node',
	dts: false,
	clean: true,
	outDir: 'dist',
});
