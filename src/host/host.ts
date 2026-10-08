import { access, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Room } from '@ambionframework/ambion';
import type { WidgetAct, WidgetActResult } from '@ambionframework/canvas';
import type { PiExecutionOptions } from '@ambionframework/pi';
import { type Person, people } from '../domain/definitions.ts';
import { missingLogin } from '../domain/model.ts';
import { buildRoom } from '../domain/room.ts';
import type { ActivationSteps } from '../view/steps.ts';
import { type ActionWidget, frameActions } from './actions.ts';
import { writeConfig } from './config.ts';
import {
	type Attachment,
	attachFile,
	type FileContent,
	type FileEntry,
	listFiles,
	readFile,
} from './files.ts';
import { MAX_GOAL, ROOM_NAME } from './names.ts';
import { readCommitFile, readSnapshotFile } from './previews.ts';
import { byRecency, type ProcessOutput, type ProcessView, readOutput } from './processes.ts';
import { fail, openRooms, type RoomAction, type RoomsOptions, type RoomView } from './rooms.ts';
import { writeSchemas } from './schemas.ts';
import { openViewfinder, type Viewfinder } from './viewfinder.ts';
import { loadWorkstation } from './workstation.ts';

export type { WidgetAct, WidgetActResult } from '@ambionframework/canvas';
export type { Person } from '../domain/definitions.ts';
export type { ActivationSteps } from '../view/steps.ts';
export type { ActionWidget, Answered } from './actions.ts';
export type { Attachment, FileContent, FileEntry, ImageContent, TableView } from './files.ts';
export type { ProcessOutput, ProcessView } from './processes.ts';
export type { RoomAction, RoomView } from './rooms.ts';
export type { CameraView, Viewfinder, ViewfinderState } from './viewfinder.ts';

/** A specialist that a message can address, seated in the room or not. */
interface Addressable {
	name: string;
	identity: string;
}

/**
 * The Workbench host, as the terminal sees it. It runs in the same
 * process as the terminal. Opening it hosts the rooms, and closing it stops
 * them. Nothing in this interface is a network call, so a caller may treat
 * every method as a direct one.
 */
export interface Lab {
	readonly people: readonly Person[];
	/** The seats a person can address with `@name`: every specialist. */
	readonly team: readonly Addressable[];
	rooms(): Promise<RoomView[]>;
	/** Read one room. Messages come back only after `since`, an exclusive position. */
	read(room: string, since: number): Promise<RoomView>;
	/**
	 * Watch one room for live changes. A running room calls `changed` after each
	 * entry it records and each activation step, so a reader can read again at
	 * once. A stopped room records nothing, so it calls nothing; a slow read keeps
	 * that room current. The return value ends the watch.
	 */
	watch(room: string, changed: () => void): () => void;
	/**
	 * Call `changed` when a room opens, starts, stops, or is archived. A breakout
	 * room is a room, so its opening and its end count. A widget and an answer
	 * do not. The return value ends the watch.
	 */
	watchRooms(changed: () => void): () => void;
	/** Enter a room as a person. Entering twice records one arrival. */
	join(room: string, person: string): Promise<void>;
	/** Leave a room. A person who is not present has nothing to leave. */
	leave(room: string, person: string): Promise<void>;
	/**
	 * Send a message, with the refs it cites. The same key and text return the
	 * first exchange and add no message. `to` names one seat that the message
	 * wakes. The host seats it at `named` first when the room has not seated
	 * it. A breakout room is the exception: the host seats no seat there, and
	 * refuses a `to` that the room does not seat. A seat at `none` wakes for
	 * nothing, so the host refuses the message.
	 */
	send(
		room: string,
		person: string,
		key: string,
		text: string,
		refs?: string[],
		to?: string,
	): Promise<void>;
	control(room: string, action: RoomAction): Promise<RoomView>;
	/** Dismiss a say of a room that waits to return, by its handle. False when it no longer waits. */
	dismiss(room: string, handle: number): Promise<boolean>;
	/**
	 * The steps of one activation, as the logger of this process received them.
	 * A running activation returns the steps so far. An activation this process
	 * did not run returns nothing.
	 */
	activation(room: string, id: string): Promise<ActivationSteps | undefined>;
	create(name: string, goal: string): Promise<RoomView>;
	/**
	 * The files of the workspace, group by group: each root, then, with `homes`, the
	 * home of each seat, which the host reads as the seat that owns it. A home takes
	 * one SSH read for each folder on a workstation, so a caller that repeats the
	 * call asks for the roots alone.
	 */
	files(homes?: boolean): Promise<FileEntry[]>;
	file(path: string): Promise<FileContent>;
	/** The bytes of a snapshot ref of the workspace, from its object store. */
	snapshot(ref: string): Promise<FileContent>;
	/** The commit that a commit ref of the workspace names, from its git server. */
	commit(ref: string): Promise<FileContent>;
	/** Copy a local file into the workspace and snapshot it, so a message can cite it as a ref. */
	attach(localPath: string): Promise<Attachment>;
	/**
	 * The background processes of the seats that used the workspace in this
	 * run: the running processes first, then the newest start first.
	 */
	processes(): Promise<ProcessView[]>;
	/**
	 * The end of the output of the process `handle` of `agent`: the last 64 K
	 * characters. An output over 1 MiB gives its size and no text.
	 */
	processOutput(handle: string, agent: string): Promise<ProcessOutput>;
	/**
	 * Stop one process. It waits up to 10 seconds for the end, then gives the
	 * state. It runs outside the queue of the host's file reads.
	 */
	cancelProcess(handle: string): Promise<ProcessView>;
	/** Call `changed` when a process starts and when one ends. The return value ends the watch. */
	watchProcesses(changed: () => void): () => void;
	/**
	 * Open a viewfinder on the shown `frame` widgets of `room`: one camera for
	 * each widget, four at most. It polls the process of each widget every 3
	 * seconds and calls `changed` after each change of its state. A poll is a
	 * display read: the workspace keeps no snapshot of it. The viewfinder polls
	 * until its `close`.
	 */
	viewfinder(room: string, changed: () => void): Viewfinder;
	/** The shown camera widgets of a room that hold a "Look now" style action, with their answers. */
	actions(room: string): ActionWidget[];
	/**
	 * Press an action of a widget as a person. The canvas checks the press, and sends it
	 * to the room as a message of the person. A retry with the same `press` lands once.
	 */
	act(person: string, act: WidgetAct): Promise<WidgetActResult>;
	/** Stop every room and release the storage. The journals stay, so a later open resumes them. */
	close(): Promise<void>;
}

export interface OpenOptions {
	/** Where the journals and the workspace live. A directory with no journals starts fresh. */
	directory: string;
	/** A model stream, for tests. The default calls the configured provider. */
	stream?: PiExecutionOptions['stream'];
	/** The environment that holds the key. The default is the environment of the process. */
	env?: RoomsOptions['env'];
	/**
	 * The path of `workstation.json`. The bash and git backends then run on
	 * that workstation. Without it, both run on this machine.
	 */
	workstation?: string;
}

type Rooms = Awaited<ReturnType<typeof openRooms>>;

const exists = (path: string): Promise<boolean> =>
	access(path).then(
		() => true,
		() => false,
	);

function personNamed(name: string): Person {
	const person = people.find((candidate) => candidate.name === name);
	if (!person) fail(`Unknown person '${name}'.`);
	return person;
}

/** Open Workbench. A fresh directory gets the build room. An old one resumes its rooms. */
export async function openLab(options: OpenOptions): Promise<Lab> {
	// Read the workstation first, so a bad file stops the start before any room opens.
	const workstation = options.workstation ? await loadWorkstation(options.workstation) : undefined;
	const path = resolve(options.directory, 'rooms.db');
	const fresh = !(await exists(path));
	await mkdir(options.directory, { recursive: true });
	const database = new DatabaseSync(path);
	let rooms: Rooms | undefined;
	try {
		rooms = await openRooms(database, options.directory, {
			stream: options.stream,
			env: options.env,
			workstation,
		});
		if (fresh) await seedRooms(rooms);
		// The config goes first, so that `schemas.md` lists `configs.jsonl` at the first start.
		await writeConfig(options.directory, {
			specialists: rooms.definitions,
			people,
			limits: rooms.limits,
			workstation: workstation?.host,
			login: missingLogin(options.env ?? process.env) === undefined,
		});
		// The tables of `rooms.db` exist now.
		await writeSchemas(database, options.directory);
	} catch (error) {
		await rooms?.close().catch(() => undefined);
		database.close();
		throw error;
	}
	return hosted(rooms, database);
}

async function seedRooms(rooms: Rooms): Promise<void> {
	await rooms.create(buildRoom.name, buildRoom.goal);
}

function present(
	snapshot: { participants: readonly { name: string; kind: string }[] },
	name: string,
) {
	return snapshot.participants.some(
		(seat) =>
			seat.name === name &&
			seat.kind === 'person' &&
			'presence' in seat &&
			seat.presence === 'present',
	);
}

/** The attention of the seat named `name`, or undefined when the room has not seated it. */
function attentionOf(
	snapshot: { participants: readonly { name: string; kind: string; attention?: string }[] },
	name: string,
): string | undefined {
	return snapshot.participants.find((seat) => seat.kind === 'agent' && seat.name === name)
		?.attention;
}

/** What a person sends: the token, the text, the refs it cites, and the seat it addresses. */
interface Delivery {
	key: string;
	text: string;
	refs: string[];
	to?: string;
	/** Whether the room is a breakout room. Its seats are the agents that the opener chose. */
	breakout?: boolean;
}

/**
 * Check the seat that a message addresses, and seat it when the room has not. A breakout room
 * seats no other seat: its task goes to the seats that the opener chose.
 */
async function addressSeat(
	live: Room,
	snapshot: Parameters<typeof attentionOf>[0],
	to: string,
	breakout: boolean,
): Promise<void> {
	const attention = attentionOf(snapshot, to);
	if (attention === 'none') fail(`'${to}' listens at none, so no message wakes it.`);
	if (attention !== undefined) return;
	if (breakout) fail(`'${to}' is not a seat of this breakout room.`);
	await live.seat(to, { attention: 'named' });
}

/** Send the message of a person who is in the room. Seat the addressed seat first when the room has not. */
async function deliver(
	live: Room,
	who: Person,
	{ key, text, refs, to, breakout = false }: Delivery,
): Promise<void> {
	const snapshot = await live.read({ messages: false });
	if (!present(snapshot, who.name)) fail('Enter this room before sending.');
	if (to !== undefined) await addressSeat(live, snapshot, to, breakout);
	const visit = await live.visit(who);
	await visit.send({
		key,
		text,
		...(to === undefined ? {} : { to }),
		...(refs.length > 0 ? { refs } : {}),
	});
}

function hosted(rooms: Rooms, database: DatabaseSync): Lab {
	let closing: Promise<void> | undefined;
	const { inRoom } = rooms;
	return {
		people,
		team: rooms.team,
		rooms: () => rooms.list(),
		read: (room, since) => rooms.read(room, since),
		watch: (room, changed) => rooms.watch(room, changed),
		watchRooms: (changed) => rooms.watchRooms(changed),
		async join(room, person) {
			const who = personNamed(person);
			await inRoom(room, async (live) => void (await live.visit(who)));
		},
		async leave(room, person) {
			const who = personNamed(person);
			await inRoom(room, async (live) => {
				const snapshot = await live.read({ messages: false });
				if (present(snapshot, who.name)) await (await live.visit(who)).leave();
			});
		},
		async send(room, person, key, text, refs = [], to) {
			const who = personNamed(person);
			if (!key || !text.trim()) fail('Supply a nonempty key and message.');
			// A breakout room names its own seats: `deliver` checks them.
			const breakout = rooms.isBreakout(room);
			if (to !== undefined && !breakout && !rooms.team.some((seat) => seat.name === to))
				fail(`No seat or specialist named '${to}'.`);
			await inRoom(room, async (live) => {
				await deliver(live, who, { key, text, refs, to, breakout });
			});
		},
		control: (room, action) => rooms.lifecycle(room, action),
		dismiss: (room, handle) => inRoom(room, (live) => live.dismiss(handle)),
		activation: (room, id) => rooms.activation(room, id),
		// Async, so a refusal is a rejected promise like every other failure of this interface.
		async create(name, goal) {
			if (!ROOM_NAME.test(name))
				fail('Use a lowercase room name, up to 48 letters, digits, or dashes.');
			const trimmed = goal.trim();
			if (!trimmed || trimmed.length > MAX_GOAL)
				fail(`Give a room goal of 1 to ${MAX_GOAL} characters.`);
			return rooms.create(name, trimmed);
		},
		files: (homes = false) =>
			rooms.withWorkspace(() => listFiles(rooms.workspace, rooms.roots, rooms.seatNames, homes)),
		file: (path) => rooms.withWorkspace(() => readFile(rooms.workspace, path, rooms.seatNames)),
		snapshot: (ref) => rooms.withWorkspace(() => readSnapshotFile(rooms.workspace, ref)),
		commit: (ref) => rooms.withWorkspace(() => readCommitFile(rooms.workspace, ref)),
		attach: (localPath) => rooms.withWorkspace(() => attachFile(rooms.workspace, localPath)),
		processes: () =>
			rooms.withWorkspace(async () => byRecency(await rooms.workspace.processes.list())),
		processOutput: (handle, agent) =>
			rooms.withWorkspace(async () => {
				const listed = await rooms.workspace.processes.list({ agent });
				const process = listed.find((candidate) => candidate.handle === handle);
				if (!process) fail(`No process ${handle}.`);
				return readOutput(rooms.workspace, process);
			}),
		// The table orders a stop on the bash owner of the agent, so the cancel
		// needs no place in the host's queue, and a wait for the end holds no read.
		cancelProcess: (handle) => rooms.workspace.processes.cancel(handle),
		watchProcesses: (changed) => rooms.workspace.processes.subscribe(() => changed()),
		actions: (room) => frameActions(rooms.canvas.widgets(room), rooms.canvas.answers(room)),
		async act(person, act) {
			return rooms.act(personNamed(person), act);
		},
		viewfinder: (room, changed) => openViewfinder(rooms.workspace, rooms.canvas, room, changed),
		close() {
			if (closing) return closing;
			const attempt = shutdown(rooms, database);
			closing = attempt.catch((error: unknown) => {
				closing = undefined;
				throw error;
			});
			return closing;
		},
	};
}

async function shutdown(rooms: Rooms, database: DatabaseSync): Promise<void> {
	// Rooms first, so no room writes to the storage after it closes. The canvas reports a
	// stop that fails, and still stops the other rooms.
	await rooms.close();
	database.close();
}
