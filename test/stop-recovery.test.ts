import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PiExecutionOptions } from '@ambionframework/pi';
import { afterEach, describe, expect, it } from 'vitest';
import { people } from '../src/domain/definitions.ts';
import { openLab } from '../src/host/host.ts';
import { openRooms } from '../src/host/rooms.ts';

type StopFailure = false | 'before' | 'after';
type WrappedDatabase = {
	database: DatabaseSync;
	setFailure: (failure: StopFailure) => void;
	setCatalogFailure: (failure: boolean) => void;
};
type FaultState = { failure: StopFailure; catalogFailure: boolean };

function wrappedDatabase(path: string): WrappedDatabase {
	const database = new DatabaseSync(path);
	const state: FaultState = { failure: false, catalogFailure: false };
	const wrapped = new Proxy(database, {
		get(target, property) {
			if (property === 'prepare')
				return (query: string) => {
					const statement = target.prepare(query);
					return wrapStatement(statement, query, state);
				};
			const value = Reflect.get(target, property);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	}) as unknown as DatabaseSync;
	return {
		database: wrapped,
		setFailure: (next) => (state.failure = next),
		setCatalogFailure: (next) => (state.catalogFailure = next),
	};
}

function wrapStatement(
	statement: ReturnType<DatabaseSync['prepare']>,
	query: string,
	state: FaultState,
) {
	return new Proxy(statement, {
		get(bound, method) {
			if (
				method === 'all' &&
				state.catalogFailure &&
				query.includes('UPDATE canvas_rooms SET state')
			)
				return () => {
					state.catalogFailure = false;
					throw new Error('injected row save failure');
				};
			if (method === 'all')
				return (...params: unknown[]) => runJournalRead(bound, query, params, state);
			return boundMethod(bound, method);
		},
	});
}

function runJournalRead(
	statement: ReturnType<DatabaseSync['prepare']>,
	query: string,
	params: unknown[],
	state: FaultState,
) {
	const departure = isDeparture(query, params, state.failure);
	if (departure && state.failure === 'before') throw new Error('injected departure write failure');
	const rows = Reflect.apply(statement.all, statement, params);
	if (departure) {
		state.failure = false;
		throw new Error('injected departure acknowledgement loss');
	}
	return rows;
}

function isDeparture(query: string, params: unknown[], failure: StopFailure): boolean {
	return (
		failure !== false &&
		query.includes('INSERT INTO journal_entries') &&
		typeof params[2] === 'string' &&
		JSON.parse(params[2]).body?.kind === 'left'
	);
}

function boundMethod(statement: ReturnType<DatabaseSync['prepare']>, method: string | symbol) {
	const value = Reflect.get(statement, method);
	return typeof value === 'function' ? value.bind(statement) : value;
}

const person = people.at(0);
if (!person) throw new Error('The test team has no human.');

function noModelStream() {
	let calls = 0;
	const stream: PiExecutionOptions['stream'] = () => {
		calls += 1;
		throw new Error('model calls are forbidden in lifecycle recovery tests');
	};
	return { stream, calls: () => calls };
}

function failNextDeparture(): { attempts: () => number; restore: () => void } {
	let pending = true;
	let count = 0;
	const original = DatabaseSync.prototype.prepare;
	const replacement = function (this: DatabaseSync, query: string) {
		const statement = original.call(this, query);
		if (!query.includes('INSERT INTO journal_entries')) return statement;
		return new Proxy(statement, {
			get(bound, method) {
				if (method === 'all')
					return (...params: unknown[]) => {
						const departure =
							pending &&
							typeof params[2] === 'string' &&
							JSON.parse(params[2]).body?.kind === 'left';
						if (departure) {
							pending = false;
							count += 1;
							throw new Error('injected departure write failure');
						}
						const value = Reflect.get(bound, method);
						if (typeof value !== 'function')
							throw new Error('SQLite statement all is unavailable.');
						return Reflect.apply(value, bound, params);
					};
				const value = Reflect.get(bound, method);
				return typeof value === 'function' ? value.bind(bound) : value;
			},
		});
	} as typeof DatabaseSync.prototype.prepare;
	DatabaseSync.prototype.prepare = replacement;
	return {
		attempts: () => count,
		restore: () => {
			DatabaseSync.prototype.prepare = original;
		},
	};
}

/** The state that the canvas row of a room holds. */
function rowState(database: DatabaseSync, name: string): unknown {
	return database.prepare('SELECT state FROM canvas_rooms WHERE name = ?').get(name)?.state;
}

/** The `left` messages of a room: one for each departure that the journal recorded. */
async function departures(rooms: Awaited<ReturnType<typeof openRooms>>, name: string) {
	return (await rooms.read(name, 0)).messages.filter((message) => message.kind === 'left');
}

describe('Workbench host stop recovery', () => {
	const directories: string[] = [];

	afterEach(async () => {
		for (const directory of directories.splice(0))
			await rm(directory, { recursive: true, force: true });
	});

	it('leaves a room stopped after a failed stop, reports it, and starts it again on resume', async () => {
		const directory = await mkdtemp(joinPath(tmpdir(), 'workbench-stop-recovery-'));
		directories.push(directory);
		const wrapped = wrappedDatabase(`${directory}/rooms.db`);
		const model = noModelStream();
		const rooms = await openRooms(wrapped.database, directory, { stream: model.stream });
		try {
			await rooms.create('review', 'Check durable stop.');
			await rooms.inRoom('review', async (room) => void (await room.visit(person)));

			wrapped.setFailure('before');
			await expect(rooms.lifecycle('review', 'stop')).rejects.toThrow(/write failure/);
			await expect(rooms.inRoom('review', (room) => room.visit(person))).rejects.toThrow(
				/Resume this room first/,
			);
			const failed = (await rooms.list())[0];
			expect(failed?.status).toBe('stopped');
			expect(failed?.activity.map((one) => one.text)).toContainEqual(
				expect.stringContaining('The stop of the room failed'),
			);
			expect(rowState(wrapped.database, 'review')).toBe('stopped');

			wrapped.setFailure(false);
			expect((await rooms.lifecycle('review', 'resume')).status).toBe('running');
			const [first, second] = await Promise.all([
				rooms.lifecycle('review', 'stop'),
				rooms.lifecycle('review', 'stop'),
			]);
			expect(first.status).toBe('stopped');
			expect(second.status).toBe('stopped');
			expect(await departures(rooms, 'review')).toHaveLength(1);
			expect(model.calls()).toBe(0);
		} finally {
			wrapped.setFailure(false);
			await rooms.close().catch(() => undefined);
			wrapped.database.close();
		}
	});

	it('keeps a room stopped on the next host after its stop failed', async () => {
		const directory = await mkdtemp(joinPath(tmpdir(), 'workbench-stop-restart-'));
		directories.push(directory);
		const wrapped = wrappedDatabase(`${directory}/rooms.db`);
		let first: Awaited<ReturnType<typeof openRooms>> | undefined;
		let restarted: Awaited<ReturnType<typeof openRooms>> | undefined;
		try {
			const model = noModelStream();
			first = await openRooms(wrapped.database, directory, { stream: model.stream });
			await first.create('review', 'Check durable stop.');
			await first.inRoom('review', async (room) => void (await room.visit(person)));
			wrapped.setFailure('before');
			await expect(first.lifecycle('review', 'stop')).rejects.toThrow(/write failure/);

			wrapped.setFailure(false);
			restarted = await openRooms(wrapped.database, directory, { stream: model.stream });
			expect((await restarted.list())[0]?.status).toBe('stopped');
			expect((await restarted.lifecycle('review', 'resume')).status).toBe('running');
			expect((await restarted.lifecycle('review', 'stop')).status).toBe('stopped');
			expect(await departures(restarted, 'review')).toHaveLength(1);
			expect(model.calls()).toBe(0);
		} finally {
			wrapped.setFailure(false);
			await first?.close().catch(() => undefined);
			await restarted?.close().catch(() => undefined);
			wrapped.database.close();
		}
	});

	it('records one departure when a stop loses its acknowledgement, and closes with a failing stop', async () => {
		const directory = await mkdtemp(joinPath(tmpdir(), 'workbench-stop-recovery-'));
		directories.push(directory);
		const wrapped = wrappedDatabase(`${directory}/rooms.db`);
		const model = noModelStream();
		const rooms = await openRooms(wrapped.database, directory, { stream: model.stream });
		try {
			await rooms.create('review', 'Check durable stop.');
			await rooms.inRoom('review', async (room) => void (await room.visit(person)));

			wrapped.setFailure('after');
			await expect(rooms.lifecycle('review', 'stop')).rejects.toThrow(/acknowledgement loss/);
			expect((await rooms.list())[0]?.status).toBe('stopped');
			wrapped.setFailure(false);
			expect((await rooms.lifecycle('review', 'resume')).status).toBe('running');
			expect(await departures(rooms, 'review')).toHaveLength(1);

			wrapped.setFailure('before');
			await rooms.inRoom('review', async (room) => void (await room.visit(person)));
			// The canvas reports a stop that fails at close, and stops the other rooms.
			await expect(rooms.close()).resolves.toBeUndefined();
			expect(model.calls()).toBe(0);
		} finally {
			wrapped.setFailure(false);
			await rooms.close().catch(() => undefined);
			wrapped.database.close();
		}
	});

	it('keeps a room running when the save of its row fails, and stops it on a retry', async () => {
		const directory = await mkdtemp(joinPath(tmpdir(), 'workbench-stop-catalog-'));
		directories.push(directory);
		const wrapped = wrappedDatabase(`${directory}/rooms.db`);
		let rooms: Awaited<ReturnType<typeof openRooms>> | undefined;
		try {
			const model = noModelStream();
			rooms = await openRooms(wrapped.database, directory, { stream: model.stream });
			await rooms.create('review', 'Check durable stop.');
			await rooms.inRoom('review', async (room) => void (await room.visit(person)));
			wrapped.setCatalogFailure(true);
			await expect(rooms.lifecycle('review', 'stop')).rejects.toThrow(/row save failure/);
			expect((await rooms.list())[0]?.status).toBe('running');
			expect(rowState(wrapped.database, 'review')).toBe('running');
			expect(await departures(rooms, 'review')).toHaveLength(0);
			expect((await rooms.lifecycle('review', 'stop')).status).toBe('stopped');
			expect(rowState(wrapped.database, 'review')).toBe('stopped');
			expect(await departures(rooms, 'review')).toHaveLength(1);
			expect(model.calls()).toBe(0);
		} finally {
			wrapped.setFailure(false);
			wrapped.setCatalogFailure(false);
			await rooms?.close().catch(() => undefined);
			wrapped.database.close();
		}
	});

	it('reports a failed stop through the host and rejects admission until a resume', async () => {
		const directory = await mkdtemp(joinPath(tmpdir(), 'workbench-host-stop-recovery-'));
		const failure = failNextDeparture();
		let modelCalls = 0;
		const stream: PiExecutionOptions['stream'] = () => {
			modelCalls += 1;
			throw new Error('model calls are forbidden in host lifecycle recovery tests');
		};
		let lab: Awaited<ReturnType<typeof openLab>> | undefined;
		try {
			lab = await openLab({ directory: joinPath(directory, 'run'), stream });
			await lab.join('build', person.name);
			await expect(lab.control('build', 'stop')).rejects.toThrow(/write failure/);
			await expect(lab.join('build', person.name)).rejects.toThrow(/Resume this room first/);
			expect((await lab.rooms()).find((room) => room.name === 'build')?.status).toBe('stopped');
			failure.restore();
			expect((await lab.control('build', 'resume')).status).toBe('running');
			expect((await lab.control('build', 'stop')).status).toBe('stopped');
			const messages = (await lab.read('build', 0)).messages;
			expect(messages.filter((message) => message.kind === 'left')).toHaveLength(1);
			expect(failure.attempts()).toBe(1);
			const shutdownFailure = failNextDeparture();
			try {
				expect((await lab.control('build', 'resume')).status).toBe('running');
				await lab.join('build', person.name);
				await expect(lab.close()).resolves.toBeUndefined();
			} finally {
				shutdownFailure.restore();
			}
			expect(modelCalls).toBe(0);
		} finally {
			failure.restore();
			await lab?.close().catch(() => undefined);
			await rm(directory, { recursive: true, force: true });
		}
	});
});
