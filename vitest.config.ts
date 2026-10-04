import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// A test that runs past its limit fails. The scripted tier runs a test in under 1 s, and the
		// slowest panel test in under 7 s under load. A test that needs more sets its own limit.
		testTimeout: 5_000,
		// A hook that runs past its limit fails. The tree-sitter worker start sets its own limit.
		hookTimeout: 10_000,
		// A worker that does not stop within this time fails the run, and Vitest ends the process.
		teardownTimeout: 10_000,
		exclude: [...configDefaults.exclude, 'test/live/**'],
		// OpenTUI draws through Node's FFI, which Node enables only with a flag.
		// The panel tests render on OpenTUI's headless renderer.
		// The warning flag silences the notice that Node prints for each worker.
		execArgv: ['--experimental-ffi', '--disable-warning=ExperimentalWarning'],
	},
});
