import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '@ambionframework/ambion';
import { describe, expect, it } from 'vitest';
import { hasKey } from '../../src/domain/families.ts';
import { type Lab, openLab } from '../../src/host/host.ts';

interface Scenario {
	name: string;
	person: string;
	request: string;
	specialists: string[];
	summaryCheck: (summary: string) => void;
}

const scenarios: readonly Scenario[] = [
	{
		name: 'characterization',
		person: 'priya',
		request:
			'Pick a load resistor to discharge-test the 18650 cell at about 0.9 A. Confirm the current stays within the cell and connector limits, and cite the datasheet paths.',
		specialists: ['datasheets', 'design'],
		summaryCheck: (summary) => {
			expect(summary).toMatch(/ohm|Ω|resistor/i);
			expect(summary).toMatch(/library/i);
		},
	},
	{
		name: 'cycling',
		person: 'noor',
		request:
			'Plan a repeatable charge and discharge cycling test for the 18650 cell over 10 cycles, with a thermocouple on the cell. List the steps and the pass criterion.',
		specialists: ['design', 'experiments'],
		summaryCheck: (summary) => expect(summary).toMatch(/step|test|cycle|capacity/i),
	},
];

const spoken = (message: Message) =>
	message.kind === 'said' || message.kind === 'summary' ? message : undefined;

async function untilSummary(lab: Lab, room: string): Promise<readonly Message[]> {
	const deadline = Date.now() + 150_000;
	while (Date.now() < deadline) {
		const { messages } = await lab.read(room, 0);
		if (messages.some((message) => message.kind === 'summary')) return messages;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`Workbench did not publish a summary for '${room}'.`);
}

/** Every scenario runs on Pi, on the model WORKBENCH_MODEL selects. The whole file skips with no key. */
describe.skipIf(!hasKey('pi'))('Workbench live scenarios', () => {
	for (const scenario of scenarios) {
		it(`${scenario.name}: returns a cited summary from a specialist`, async () => {
			const directory = await mkdtemp(join(tmpdir(), `workbench-${scenario.name}-live-`));
			const lab = await openLab({ directory: join(directory, 'run') });
			try {
				await lab.join(scenario.name, scenario.person);
				await lab.send(
					scenario.name,
					scenario.person,
					`engine-live-${scenario.name}`,
					scenario.request,
				);
				const messages = await untilSummary(lab, scenario.name);
				const summary = messages.map(spoken).find((message) => message?.kind === 'summary');
				expect(summary).toMatchObject({ from: 'assistant', to: scenario.person });
				expect(
					messages.some(
						(message) => message.kind === 'said' && scenario.specialists.includes(message.from),
					),
				).toBe(true);
				scenario.summaryCheck(summary?.text ?? '');
				// A scripted run carries no cost, so only a real provider proves it.
				const { exchanges } = await lab.read(scenario.name, 0);
				const cost = exchanges.flatMap((exchange) =>
					exchange.status === 'closed' && exchange.usage?.cost !== undefined
						? [exchange.usage.cost]
						: [],
				);
				expect(cost.length).toBeGreaterThan(0);
				expect(Math.max(...cost)).toBeGreaterThan(0);
			} finally {
				await lab.close();
				await rm(directory, { recursive: true, force: true });
			}
		}, 180_000);
	}
});
