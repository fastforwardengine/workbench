/** Optional SSH + snapshot integration; no camera hardware or model is used. */
import type { ToolContext } from '@ambionframework/ambion';
import { openWorkspace } from '@ambionframework/workspace';
import { describe, expect, it } from 'vitest';
import { loadWorkstation, workstationBackends } from '../src/host/workstation.ts';

const config = process.env.WORKBENCH_WORKSTATION;

describe.skipIf(!config)('the USB camera lifecycle on the workstation', () => {
	it('forks, saves, starts, fetches from another account, and restores after shutdown', async () => {
		const workspace = openWorkspace({
			name: 'camera-test',
			backend: await workstationBackends(await loadWorkstation(config ?? '')),
		});
		const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		const name = `camera-${token}`;
		let handle: string | undefined;
		let calls = 0;
		const invoke = async (toolName: string, params: unknown, agent = 'engineer') => {
			const tool = workspace.tools().tools.find((one) => one.name === toolName);
			if (!tool) throw new Error(`No ${toolName} tool`);
			const context: ToolContext = {
				agent: { name: agent, identity: agent },
				callId: `${token}-${++calls}`,
			};
			const result = await tool.invoke(params, context);
			if (typeof result === 'string') throw new Error(result);
			return result;
		};
		const text = (result: Awaited<ReturnType<typeof invoke>>) =>
			result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
		/** Fetch the index until the server listens, and return its JSON text. */
		const fetchWhenListening = async (process: string): Promise<string> => {
			for (let attempts = 0; attempts < 100; attempts++) {
				try {
					const result = await invoke('fetch', { process, path: '/' });
					const file = (result.details as { file: string }).file;
					return text(await invoke('read', { path: file }));
				} catch {
					await new Promise((resolve) => setTimeout(resolve, 500));
				}
			}
			throw new Error('The camera server did not listen');
		};
		try {
			await invoke('fork', { source: 'templates/usb-camera', name, clone: `~/${name}` });
			const saved = await invoke('bash', {
				command: `cd ~/${name} && git switch -c capture && python3 -B -m unittest test_camera.py && git commit --allow-empty -m 'Validate synthetic camera' && git push -u origin capture`,
				wait: 30,
			});
			expect(text(saved)).toContain('OK');
			const started = await invoke('bash', {
				command: `cd ~/${name} && AMBION_SENSOR_REPOSITORY=engineer/${name} AMBION_SENSOR_DATA_DIR="$HOME/sensor-data/${name}" python3 -u -B camera.py --demo`,
				name,
				wait: 0,
				timeout: 120,
			});
			handle = (started.details as { process: { handle: string } }).process.handle;
			// The server prints no ready line. It listens after its first capture.
			const index = await fetchWhenListening(handle);
			expect(JSON.parse(index)).toMatchObject({ api: 2, source: { dirty: false } });
			// Advancing the checkout must not relabel the serving process.
			await invoke('bash', {
				command: `cd ~/${name} && git commit --allow-empty -m 'Advance branch after launch' && git push`,
				wait: 30,
			});
			const observed = await invoke(
				'fetch',
				{ process: name, path: '/camera/observe' },
				'researcher',
			);
			expect(text(observed)).toContain('SYNTHETIC DEMO');
			const observation = observed.details as { ref: string; file: string };
			const parts = JSON.parse(
				text(await invoke('read', { path: observation.file }, 'researcher')),
			) as { observations: { parts: { kind: string; file?: string }[] }[] };
			const digest = parts.observations[0]?.parts.find((part) => part.kind === 'frame')?.file;
			if (!digest) throw new Error('No frame in the camera observation');
			const frame = await invoke(
				'fetch',
				{ process: name, path: `/files/${digest}` },
				'researcher',
			);
			expect(frame.content.some((part) => part.type === 'image')).toBe(true);
			const retained = frame.details as { ref: string; file: string };
			const heard = await invoke(
				'fetch',
				{ process: name, path: '/microphone/observe' },
				'researcher',
			);
			expect(text(heard)).toContain('SYNTHETIC DEMO');
			// Alter the observer's mutable export. Snapshot restoration must still work.
			await invoke('write', { path: retained.file, content: 'changed export' }, 'researcher');
			await invoke('cancel', { handle });
			handle = undefined;
			await expect(
				invoke('fetch', { process: name, path: '/camera/observe' }, 'researcher'),
			).rejects.toThrow();
			await invoke(
				'restore',
				{ ref: observation.ref, path: `~/camera-observation-${token}.json` },
				'researcher',
			);
			const restored = await invoke(
				'read',
				{ path: `~/camera-observation-${token}.json` },
				'researcher',
			);
			expect(text(restored)).toContain(digest);
			await invoke(
				'restore',
				{ ref: retained.ref, path: `~/camera-frame-${token}.png` },
				'researcher',
			);
			const picture = await invoke('read', { path: `~/camera-frame-${token}.png` }, 'researcher');
			expect(picture.content.some((part) => part.type === 'image')).toBe(true);
		} finally {
			if (handle) await invoke('cancel', { handle }).catch(() => undefined);
			await workspace.dispose();
		}
	}, 60_000);
});
