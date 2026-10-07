/**
 * The eval support on the scripted tier: the room holds the team of
 * Workbench over a seeded workspace, a scripted execution plays every seat,
 * and the simulator drives the room. The live suite's plumbing runs with no
 * key.
 */
import {
	byAgent,
	callTool,
	quiet,
	type Script,
	say,
	scripted,
} from '@ambionframework/ambion/testing';
import { scriptedActor, simulate } from '@ambionframework/simulator';
import { describe, expect, it } from 'vitest';
import { buildRoom } from '../src/domain/room.ts';
import { expectGradable, openRoom, person, saidBy, toolsOf } from './live/support.ts';

/** A seat that runs its turns once in each activation, one turn for each result so far. */
const once =
	(turns: readonly ((results: readonly { text: string }[]) => ReturnType<Script>)[]): Script =>
	({ view, results }) => {
		if (view.context.exchange === undefined) return quiet();
		return turns[results.length]?.(results) ?? quiet();
	};

const script = byAgent({
	// One seat speaks, so no say of another seat makes its view stale.
	engineer: once([
		() => callTool('read', { path: '/shared/kit.md' }),
		(results) => say(`The kit file says: ${results[0]?.text ?? ''}`),
	]),
});

describe('the eval support', () => {
	it('runs the question of the build room through the team', async () => {
		const { room } = await openRoom(scripted(script));
		const run = await simulate(room, {
			person,
			actor: scriptedActor([buildRoom.prompt]),
			messages: 1,
			exchangeMs: 10_000,
		});
		expectGradable(run);
		const [exchange] = run.exchanges;
		expect(exchange?.sent).toBe(buildRoom.prompt);
		const said = saidBy(exchange, 'engineer');
		expect(said).toHaveLength(1);
		// The workspace is seeded, as the host seeds it.
		expect(said[0]?.text).toContain('# The project');
		expect(toolsOf(run, 'engineer')).toEqual(['read']);
	});
});
