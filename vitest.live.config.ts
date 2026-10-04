import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/live/**/*.test.ts'],
		fileParallelism: false,
		retry: 0,
		testTimeout: 180_000,
		hookTimeout: 60_000,
		// The live tier runs on the `luna` preset. A value of the person wins.
		env: { WORKBENCH_MODEL: process.env.WORKBENCH_MODEL || 'luna' },
	},
});
