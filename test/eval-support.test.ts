/**
 * The eval support on the scripted tier: the room holds the team of
 * Workbench over a seeded workspace, a scripted execution plays every seat,
 * and the simulator drives the room. The live suite's plumbing runs with no
 * key.
 */
import {
	byAgent,
	callTool,
	isClosing,
	quiet,
	type Script,
	scripted,
	speak,
} from '@ambionframework/ambion/testing';
import { scriptedActor, simulate } from '@ambionframework/simulator';
import { describe, expect, it } from 'vitest';
import {
	expectGradable,
	openRoom,
	person,
	saidBy,
	sweep,
	toolsOf,
	WORKSPACE_TOOLS,
} from './live/support.ts';

/** A seat that runs its turns once in each activation, one turn for each result so far. */
const once =
	(turns: readonly ((results: readonly { text: string }[]) => ReturnType<Script>)[]): Script =>
	({ view, results }) => {
		if (view.context.exchange === undefined) return quiet();
		return turns[results.length]?.(results) ?? quiet();
	};

const script = byAgent({
	assistant: (step) =>
		isClosing(step.view) && step.results.length === 0
			? speak('Summary: /library holds no LED datasheet yet.')
			: quiet(),
	// One seat speaks, so no say of another seat makes its view stale.
	datasheets: once([
		() => callTool('read', { path: '/shared/kit.md' }),
		(results) => speak(`/library holds no LED datasheet yet. ${results[0]?.text ?? ''}`),
	]),
});

describe('the eval support', () => {
	it('runs the question of the sweep room through the team, with the summary', async () => {
		const { room } = await openRoom(scripted(script));
		const run = await simulate(room, {
			person,
			actor: scriptedActor([sweep.prompt]),
			exchanges: 1,
			exchangeMs: 10_000,
		});
		expectGradable(run);
		const [exchange] = run.exchanges;
		expect(exchange?.sent).toBe(sweep.prompt);
		expect(exchange?.summary).toMatchObject({ from: 'assistant', to: person.name });
		const said = saidBy(exchange, 'datasheets');
		expect(said).toHaveLength(1);
		// The workspace is seeded, as the host seeds it.
		expect(said[0]?.text).toContain('# The project');
		expect(toolsOf(run, 'datasheets')).toEqual(['read']);
		for (const tool of WORKSPACE_TOOLS) expect(toolsOf(run, 'assistant')).not.toContain(tool);
	});
});
