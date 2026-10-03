/** Optional SSH + snapshot integration; no camera hardware or model is used. */
import type { ToolContext } from '@ambionframework/ambion';
import { openWorkspace } from '@ambionframework/workspace';
import { describe, expect, it } from 'vitest';
import { loadWorkstation, workstationBackends } from '../src/host/workstation.ts';

const config = process.env.WORKBENCH_WORKSTATION;

describe.skipIf(!config)('the USB camera lifecycle on the workstation', () => {
	it('forks, saves, starts, connects, observes from another account, and restores after shutdown', async () => {
		const workspace = openWorkspace({
			name: 'camera-test',
			backend: await workstationBackends(await loadWorkstation(config ?? '')),
		});
		const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		const name = `camera-${token}`;
		let handle: string | undefined;
		let calls = 0;
		const invoke = async (toolName: string, params: unknown, agent = 'instruments') => {
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
		try {
			await invoke('fork', { source: 'templates/usb-camera', name, clone: `~/${name}` });
			const saved = await invoke('bash', {
				command: `cd ~/${name} && git switch -c capture && python3 -B -m unittest test_camera.py && git commit --allow-empty -m 'Validate synthetic camera' && git push -u origin capture`,
				wait: 30,
			});
			expect(text(saved)).toContain('OK');
			const started = await invoke('bash', {
				command: `cd ~/${name} && AMBION_SENSOR_REPOSITORY=instruments/${name} AMBION_SENSOR_DATA_DIR="$HOME/sensor-data/${name}" python3 -u -B camera.py --demo`,
				name,
				wait: 1,
				timeout: 120,
			});
			handle = (started.details as { process: { handle: string } }).process.handle;
			let output = text(started);
			for (let attempts = 0; attempts < 20 && !output.includes('READY '); attempts++) {
				const status = await invoke('status', { handle });
				output += text(status);
				if (!output.includes('READY ')) await new Promise((resolve) => setTimeout(resolve, 100));
			}
			const ready = JSON.parse(output.match(/READY (\{[^\n]+\})/)?.[1] ?? 'null') as {
				port: number;
				source: { commit: string; dirty: boolean };
			} | null;
			if (!ready) throw new Error(`No camera readiness output: ${output}`);
			expect(ready.source.dirty).toBe(false);
			await invoke('connect', { name, process: handle, port: ready.port });
			// Advancing the checkout must not relabel the serving process.
			await invoke('bash', {
				command: `cd ~/${name} && git commit --allow-empty -m 'Advance branch after launch' && git push`,
				wait: 30,
			});
			const observed = await invoke('observe', { sensor: `${name}/camera` }, 'builder');
			expect(text(observed)).toContain('SYNTHETIC DEMO');
			expect(observed.content.some((part) => part.type === 'image')).toBe(true);
			const evidence = observed.details as {
				manifestRef: string;
				manifestPath: string;
				source: { commit: string };
				files: { ref: string; path: string; digest: string }[];
			};
			expect(evidence.source.commit).toBe(ready.source.commit);
			const heard = await invoke('observe', { sensor: `${name}/microphone` }, 'builder');
			expect(text(heard)).toContain('SYNTHETIC DEMO');
			const clips = (heard.details as { files: { path: string; digest: string }[] }).files;
			expect(clips).toHaveLength(1);
			expect(evidence.files).toHaveLength(1);
			const file = evidence.files[0];
			if (!file) throw new Error('No retained camera frame');
			// Alter the observer's mutable export. Snapshot restoration must still work.
			await invoke('write', { path: file.path, content: 'changed export' }, 'builder');
			await invoke('cancel', { handle });
			handle = undefined;
			await expect(invoke('observe', { sensor: `${name}/camera` }, 'builder')).rejects.toThrow();
			await invoke(
				'restore',
				{ ref: evidence.manifestRef, path: `~/camera-manifest-${token}.json` },
				'experiments',
			);
			const restored = await invoke(
				'read',
				{ path: `~/camera-manifest-${token}.json` },
				'experiments',
			);
			expect(text(restored)).toContain(file.ref);
			expect(text(restored)).toContain(ready.source.commit);
			await invoke(
				'restore',
				{ ref: file.ref, path: `~/camera-frame-${token}.png` },
				'experiments',
			);
			const frame = await invoke('read', { path: `~/camera-frame-${token}.png` }, 'experiments');
			expect(frame.content.some((part) => part.type === 'image')).toBe(true);
		} finally {
			if (handle) await invoke('cancel', { handle }).catch(() => undefined);
			await workspace.dispose();
		}
	}, 60_000);
});
