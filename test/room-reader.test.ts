import type { Message } from '@ambionframework/ambion';
import { describe, expect, it, vi } from 'vitest';
import { RoomReader } from '../src/terminal/state/room-reader.ts';

const said = (seq: number): Message =>
	({ seq, kind: 'said', from: 'design', text: `m${seq}`, at: '' }) as Message;

interface View {
	messages: Message[];
	name: string;
}

/** A source whose reads the test releases by hand, and whose watchers the test fires. */
function source() {
	const reads: { room: string; since: number; release: (view: View) => void }[] = [];
	const watchers = new Map<string, Set<() => void>>();
	return {
		reads,
		watchers,
		read: (room: string, since: number) =>
			new Promise<View>((resolve) => {
				reads.push({ room, since, release: resolve });
			}),
		watch: (room: string, changed: () => void) => {
			const set = watchers.get(room) ?? new Set();
			set.add(changed);
			watchers.set(room, set);
			return () => set.delete(changed);
		},
		fire: (room: string) => {
			for (const changed of watchers.get(room) ?? []) changed();
		},
	};
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('RoomReader', () => {
	it('reads nothing before a room is selected', async () => {
		const host = source();
		const apply = vi.fn(async () => {});
		const reader = new RoomReader<View>(host, apply, () => {});
		await reader.refresh();
		expect(host.reads).toHaveLength(0);
		expect(apply).not.toHaveBeenCalled();
	});

	it('reads the room, merges its messages, and hands the view to apply', async () => {
		const host = source();
		const applied: View[] = [];
		const reader = new RoomReader<View>(
			host,
			async (view) => void applied.push(view),
			() => {},
		);
		reader.select('bench');
		const done = reader.refresh();
		await tick();
		expect(host.reads[0]).toMatchObject({ room: 'bench', since: 0 });
		host.reads[0]?.release({ name: 'bench', messages: [said(1), said(2)] });
		await done;
		expect(applied).toHaveLength(1);
		expect(reader.messages.map((message) => message.seq)).toEqual([1, 2]);
	});

	it('reads again after a change that lands during a read, and only once for many changes', async () => {
		const host = source();
		const reader = new RoomReader<View>(
			host,
			async () => {},
			() => {},
		);
		reader.select('bench');
		const done = reader.refresh();
		await tick();
		reader.refresh().catch(() => {});
		reader.refresh().catch(() => {});
		host.fire('bench');
		expect(host.reads).toHaveLength(1);
		host.reads[0]?.release({ name: 'bench', messages: [said(1)] });
		await tick();
		expect(host.reads).toHaveLength(2);
		expect(host.reads[1]?.since).toBe(1);
		host.reads[1]?.release({ name: 'bench', messages: [said(2)] });
		await done;
		expect(host.reads).toHaveLength(2);
		expect(reader.messages.map((message) => message.seq)).toEqual([1, 2]);
	});

	it('watches the selected room, reads on a change, and drops the watch of the room it leaves', async () => {
		const host = source();
		const reader = new RoomReader<View>(
			host,
			async () => {},
			() => {},
		);
		reader.select('one');
		reader.select('two');
		expect(host.watchers.get('one')?.size).toBe(0);
		expect(host.watchers.get('two')?.size).toBe(1);
		host.fire('two');
		await tick();
		expect(host.reads.map((read) => read.room)).toEqual(['two']);
	});

	it('drops the result of a read that belongs to a room it left', async () => {
		const host = source();
		const apply = vi.fn(async () => {});
		const reader = new RoomReader<View>(host, apply, () => {});
		reader.select('one');
		const done = reader.refresh();
		await tick();
		reader.select('two');
		host.reads[0]?.release({ name: 'one', messages: [said(9)] });
		await done;
		expect(apply).not.toHaveBeenCalled();
		expect(reader.messages).toEqual([]);
	});

	it('reports an error of the read or of apply, and keeps reading afterwards', async () => {
		const host = source();
		const failed = vi.fn();
		let breaking = true;
		const reader = new RoomReader<View>(
			{
				...host,
				read: (room, since) =>
					breaking ? Promise.reject(new Error('offline')) : host.read(room, since),
			},
			async () => {
				throw new Error('apply broke');
			},
			failed,
		);
		reader.select('bench');
		await reader.refresh();
		expect(failed).toHaveBeenCalledWith(new Error('offline'));
		breaking = false;
		const done = reader.refresh();
		await tick();
		host.reads[0]?.release({ name: 'bench', messages: [said(1)] });
		await done;
		expect(failed).toHaveBeenLastCalledWith(new Error('apply broke'));
	});

	it('stops watching', async () => {
		const host = source();
		const reader = new RoomReader<View>(
			host,
			async () => {},
			() => {},
		);
		reader.select('bench');
		reader.stop();
		host.fire('bench');
		await tick();
		expect(host.reads).toHaveLength(0);
	});
});
