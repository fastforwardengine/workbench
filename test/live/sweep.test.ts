/**
 * The `led-sweep` room of the evals, driven by the simulator. A scripted
 * person asks the suggested question of the room, and the live team answers. Checks in code
 * decide who spoke, which tools the specialists used, and the cost. A judge
 * grades what the messages of the specialists claim.
 *
 * The library holds no datasheet for the LED, the supply, or the camera yet,
 * so no message may state a limit as a datasheet fact.
 */
import { agentJudge, scriptedActor, simulate } from '@ambionframework/simulator';
import { expect, it } from 'vitest';
import {
	EXCHANGE_MS,
	expectGradable,
	JUDGE_MODEL,
	JUDGE_SERVICES,
	JUDGE_THINKING,
	live,
	openRoom,
	person,
	saidBy,
	sweep,
	track,
} from './support.ts';

live('the led-sweep room, driven by the simulator', () => {
	it('answers the suggested question, and invents no limit', async () => {
		const evidence = track('led-sweep suggested question');
		const { room } = await openRoom();
		const run = await simulate(room, {
			person,
			actor: scriptedActor([sweep.prompt]),
			messages: 1,
			exchangeMs: EXCHANGE_MS,
		});
		evidence.run = run;

		expectGradable(run);
		const [exchange] = run.exchanges;
		const specialists = ['researcher', 'engineer'];
		expect(specialists.some((seat) => saidBy(exchange, seat).length > 0)).toBe(true);
		// A scripted run carries no cost, so only a real provider proves it.
		expect(run.usage.room.cost ?? 0).toBeGreaterThan(0);

		const verdict = await agentJudge({
			model: JUDGE_MODEL,
			thinking: JUDGE_THINKING,
			services: JUDGE_SERVICES,
		})(run, [
			'The messages of the specialists say that /library holds no datasheet for the LED, the power supply, or the camera yet.',
			'No message of a specialist states an LED current limit, supply range, or camera setting as a datasheet fact.',
			'The messages of the specialists answer the question: they name the limits that the sweep must respect, or the datasheet that must supply each one.',
		]);
		evidence.verdict = verdict;
		expect(verdict.pass, JSON.stringify(verdict.findings)).toBe(true);
	}, 300_000);
});
