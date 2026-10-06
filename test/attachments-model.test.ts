/**
 * What a specialist gets from an attached picture. The person attaches a file,
 * the message cites its snapshot, and a seat that reads the copy in the
 * workspace receives a picture, not the bytes as text.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, startRoom } from '@ambionframework/ambion';
import { byAgent, callTool, quiet, say, scripted, settled } from '@ambionframework/ambion/testing';
import { memoryJournals } from '@ambionframework/journal';
import { memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace } from '@ambionframework/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { people, team } from '../src/domain/definitions.ts';
import { attachFile } from '../src/host/files.ts';
import { labRepositories } from '../src/host/repositories.ts';
import { PNG } from './png.ts';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
});

describe('a picture that the person attaches', () => {
	it('reaches a specialist that reads the copy, as a picture of the right type', async () => {
		const person = people[0];
		if (!person) throw new Error('No person.');
		const directory = await mkdtemp(join(tmpdir(), 'workbench-model-'));
		cleanups.push(() => rm(directory, { recursive: true, force: true }));
		await writeFile(join(directory, 'bench.png'), PNG);
		const workspace = openWorkspace({
			name: 'workbench',
			backend: { bash: memoryBackend({ git: labRepositories(':memory:') }) },
		});
		cleanups.push(() => workspace.dispose());
		const attached = await attachFile(workspace, join(directory, 'bench.png'));
		const built = await team(workspace);
		const script = byAgent({
			engineer: (step, _seat, call) => {
				if (call === 1) return callTool('read', { path: attached.path });
				if (call === 2) return say(`Saw: ${step.results.at(-1)?.text}`);
				return quiet();
			},
		});
		const room = await startRoom({
			name: 'attachment',
			goal: 'Look at a picture.',
			agents: built.specialists,
			runtime: createRuntime({ storage: memoryJournals() }),
			execution: scripted(script),
			seats: { engineer: 'named' },
		});
		cleanups.push(() => room.stop());
		await (
			await room.visit(person)
		).send({
			text: 'What is on the bench?',
			to: 'engineer',
			refs: [attached.ref],
		});
		await settled(room);
		const messages = (await room.read()).messages;
		const asked = messages.find(
			(message) => message.kind === 'said' && message.from === person.name,
		);
		expect(asked && 'refs' in asked && asked.refs).toEqual([attached.ref]);
		const answer = messages.find(
			(message) => message.kind === 'said' && message.from === 'engineer',
		);
		expect(answer && 'text' in answer && answer.text).toContain('Read image file [image/png]');
	}, 30_000);
});
