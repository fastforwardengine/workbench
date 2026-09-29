import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		exclude: ['test/live/**', 'node_modules/**'],
		// OpenTUI draws through Node's FFI, which Node enables only with a flag.
		// The panel tests render on OpenTUI's headless renderer.
		execArgv: ['--experimental-ffi'],
	},
});
