/**
 * The `led-sweep` room, driven by the simulator. A scripted person asks the
 * suggested question of the room, and the live team answers. Checks in code
 * decide who spoke, which tools the assistant used, and the cost. A judge
 * grades what the summary claims.
 *
 * The library holds no datasheet for the LED, the supply, or the camera yet,
 * so the summary must not state a limit as a datasheet fact.
 */
import { agentJudge, scriptedActor, simulate } from '@ambionframework/simulator';
import { expect, it } from 'vitest';
import {
	EXCHANGE_MS,
	expectGradable,
	JUDGE_MODEL,
	JUDGE_THINKING,
	live,
	openRoom,
	person,
	saidBy,
	sweep,
	toolsOf,
	track,
	WORKSPACE_TOOLS,
} from './support.ts';

live('the led-sweep room, driven by the simulator', () => {
	it('answers the suggested question with a summary, and invents no limit', async () => {
		const evidence = track('led-sweep suggested question');
		const { room } = await openRoom();
		const run = await simulate(room, {
			person,
			actor: scriptedActor([sweep.prompt]),
			exchanges: 1,
			exchangeMs: EXCHANGE_MS,
		});
		evidence.run = run;

		expectGradable(run);
		const [exchange] = run.exchanges;
		expect(exchange?.summary).toMatchObject({ from: 'assistant', to: person.name });
		const specialists = ['datasheets', 'experiments', 'instruments'];
		expect(specialists.some((seat) => saidBy(exchange, seat).length > 0)).toBe(true);
		// The assistant holds no workspace, so it calls no workspace tool.
		for (const tool of WORKSPACE_TOOLS) expect(toolsOf(run, 'assistant')).not.toContain(tool);
		// A scripted run carries no cost, so only a real provider proves it.
		expect(run.usage.room.cost ?? 0).toBeGreaterThan(0);

		const verdict = await agentJudge({ model: JUDGE_MODEL, thinking: JUDGE_THINKING })(run, [
			'The summary says that /library holds no datasheet for the LED, the power supply, or the camera yet.',
			'The summary states no LED current limit, supply range, or camera setting as a datasheet fact.',
			'The summary answers the question: it names the limits that the sweep must respect, or the datasheet that must supply each one.',
		]);
		evidence.verdict = verdict;
		expect(verdict.pass, JSON.stringify(verdict.findings)).toBe(true);
	}, 300_000);
});
