import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
	createRuntime,
	type PersonDefinition,
	type Room,
	type RoomNotification,
	readRoom,
	type TraceStep,
} from '@ambionframework/ambion';
import type { Execution } from '@ambionframework/ambion/hosting';
import {
	type CanvasClose,
	type CanvasError,
	type CanvasEvent,
	type CanvasRoom,
	openCanvas,
	sqliteCanvas,
	type WidgetAct,
} from '@ambionframework/canvas';
import { type Sql, type SqlValue, sqliteJournals } from '@ambionframework/journal';
import { directoryBackend } from '@ambionframework/just-bash';
import { fileCredentials, type PiExecutionOptions, piExecution } from '@ambionframework/pi';
import { openWorkspace } from '@ambionframework/workspace';
import { radioProject, team } from '../domain/definitions.ts';
import { type Environment, missingLogin, piCredentialsPath } from '../domain/model.ts';
import { sharedRegistrations } from '../domain/notes.ts';
import { buildRoom, seats } from '../domain/room.ts';
import { WORKSPACE } from '../view/refs.ts';
import { stepLog } from '../view/steps.ts';
import { labRepositories } from './repositories.ts';
import { seedWorkspace } from './seed.ts';
import { unavailable } from './unavailable.ts';
import { FRAME_KIND } from './viewfinder.ts';
import { probeWorkstation, type WorkstationConfig, workstationBackends } from './workstation.ts';

/** What a person can do to a room's work. Abort ends the open exchange. Stop and resume end and start a run. */
export type RoomAction = 'abort' | 'stop' | 'resume';

export function fail(message: string): never {
	throw new Error(message);
}

interface Activity {
	at: string;
	type: string;
	agent?: string;
	text: string;
}
/** What the host shows of a room besides its row and its journal. The canvas owns the row. */
interface RoomState {
	activity: Activity[];
	/**
	 * Why each failed activation failed, by activation id, from the `end` step
	 * of its trace. The journal holds only the cause, so a restart loses the
	 * reason. The oldest go first past a fixed count.
	 */
	failures: Map<string, string>;
	/** The change listeners a caller registered with `watch`. They survive a stop. */
	watchers: Set<() => void>;
}

/** What the rooms run on. A test passes `stream` and needs no login. */
export interface RoomsOptions {
	/** A model stream for the Pi seats. */
	stream?: PiExecutionOptions['stream'];
	/** The environment that holds the key. The default is the environment of the process. */
	env?: Environment;
	/**
	 * The workstation that runs the bash and git backends. Without it, both run
	 * on this machine: a just-bash directory and a git backend in this process.
	 */
	workstation?: WorkstationConfig;
}

/** The backends of the workspace, and the folders that the files panel lists. */
async function workspaceBackends(directory: string, workstation?: WorkstationConfig) {
	const notes = sharedRegistrations();
	if (workstation)
		return {
			backend: await workstationBackends(workstation, notes),
			roots: workstation.roots,
		};
	return {
		backend: {
			bash: directoryBackend(resolve(directory, 'workspace'), {
				git: labRepositories(resolve(directory, 'git.db'), notes),
			}),
		},
		roots: ['/'],
	};
}

/**
 * The execution every seat runs on: one Pi execution. A test's `stream`
 * scripts it and needs no login. A live run reads the sign-ins of the
 * credential file, and reads the key variable when the file holds no
 * sign-in. A live run with no login gets an execution that fails its seats
 * with the way to log in. The room keeps running and reports why. `reason`
 * is the result of `missingLogin`.
 */
function modelExecution(options: RoomsOptions, reason: string | undefined): Execution {
	const { stream, env = process.env } = options;
	if (stream !== undefined) return piExecution({ stream });
	if (reason === undefined) {
		return piExecution({ credentials: fileCredentials(piCredentialsPath(env)) });
	}
	return unavailable('pi', reason);
}

/** The canvas records hosting intent. Collaboration state stays in each room journal. */
export async function openRooms(
	database: DatabaseSync,
	directory: string,
	options: RoomsOptions = {},
) {
	const sql: Sql = {
		run: (query, ...params) => {
			database.prepare(query).run(...params);
		},
		all: (query, ...params) => database.prepare(query).all(...params) as Record<string, SqlValue>[],
	};
	// A test that supplies a stream runs no live model, so no seat lacks a login.
	const reason = options.stream ? undefined : missingLogin(options.env ?? process.env);
	const states = new Map<string, RoomState>();
	const stateOf = (name: string): RoomState => {
		const found = states.get(name);
		if (found) return found;
		const created = {
			activity: [],
			failures: new Map<string, string>(),
			watchers: new Set<() => void>(),
		};
		states.set(name, created);
		return created;
	};
	// The steps of each activation go to a log in this process. Each step
	// tells the watchers of its room to read again.
	const log = stepLog();
	const runtime = createRuntime({
		storage: sqliteJournals(sql),
		execution: modelExecution(options, reason),
		logger: (record) => {
			log.logger(record);
			const state = stateOf(record.room);
			recordFailure(state, record.step);
			changed(state);
		},
	});
	let closing = false;
	const { backend, roots } = await workspaceBackends(directory, options.workstation);
	const workspace = openWorkspace({ name: WORKSPACE, backend, audit: {}, rooms: true });
	try {
		if (options.workstation) await probeWorkstation(workspace, options.workstation);
		await seedWorkspace(workspace);
		// Register the templates and notes now, so a template that fails to register
		// stops the start with an error that names it.
		await workspace.git?.use(workspace.mirrorAgent, (env) => env.list());
	} catch (error) {
		await workspace.dispose().catch(() => {});
		throw error;
	}
	let workspaceTail = Promise.resolve();
	function withWorkspace<T>(operation: () => Promise<T>): Promise<T> {
		if (closing) fail('The host is stopping.');
		const result = workspaceTail.then(operation);
		workspaceTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
	// The canvas attaches the mirror of each room, so the host attaches none. A specialist
	// opens a breakout room and seats itself in it.
	const canvas = openCanvas({
		name: 'workbench',
		runtime,
		store: sqliteCanvas(sql),
		workspace,
		widgets: { kinds: [FRAME_KIND] },
		onError: (failure) => reportFailure(stateOf(failure.room), failure),
	});
	let roomTeam: Awaited<ReturnType<typeof team>>;
	try {
		// The canvas exists first: a seat reads its bundles when it is defined.
		// Load the skills now, so a skill that breaks a rule stops the start.
		roomTeam = await team(workspace, radioProject, {
			widgets: canvas.widgetTools(),
			canvas: canvas.tools(),
		});
		canvas.subscribe((event) => heardEvent(event, stateOf, (name) => canvas.room(name)));
		await canvas.resume({ agents: roomTeam.specialists });
	} catch (error) {
		closing = true;
		await canvas.close().catch(() => {});
		await workspaceTail.catch(() => {});
		await workspace.dispose().catch(() => {});
		throw error;
	}
	// One model serves every seat, so a missing login makes every seat unavailable.
	const missing = reason === undefined ? [] : roomTeam.specialists.map(({ name }) => name);
	/** The row of a room, or a refusal. */
	function known(name: string): CanvasRoom {
		return canvas.rooms().find((row) => row.name === name) ?? fail('Unknown room.');
	}
	/** The live room, or a refusal that tells the person to resume it. An archived room never resumes. */
	function liveRoom(name: string): Room {
		if (closing) fail('The host is stopping.');
		if (known(name).state === 'archived') fail('This breakout room is archived.');
		return canvas.room(name) ?? fail('Resume this room first.');
	}
	async function inRoom<T>(name: string, operation: (room: Room) => Promise<T>) {
		return operation(liveRoom(name));
	}
	async function view(row: CanvasRoom, messages?: ReadMessages) {
		return roomView(
			row,
			stateOf(row.name),
			await readRoom(row.name, { runtime, messages: messages ?? false }),
			canvas.room(row.name) !== undefined,
			missing,
		);
	}
	async function create(name: string, goal: string) {
		if (closing) fail('The host is stopping.');
		if (canvas.rooms().some((row) => row.name === name)) fail('This room already exists.');
		await canvas.open({
			name,
			goal,
			agents: roomTeam.specialists.map((agent) => agent.name),
			seats,
			// The room seats both specialists. The reserve is empty, so no seat needs
			// the `seat` and `unseat` tools.
			seating: false,
		});
		return view(known(name));
	}
	function watch(name: string, listener: () => void): () => void {
		known(name);
		const { watchers } = stateOf(name);
		watchers.add(listener);
		return () => {
			watchers.delete(listener);
		};
	}
	async function lifecycle(name: string, action: RoomAction) {
		if (closing) fail('The host is stopping.');
		known(name);
		switch (action) {
			case 'resume':
				await canvas.start(name);
				break;
			case 'stop':
				await canvas.stop(name);
				break;
			case 'abort':
				await liveRoom(name).cancel();
				break;
		}
		return view(known(name));
	}
	let shutdown: Promise<void> | undefined;
	async function close(): Promise<void> {
		closing = true;
		// Each room keeps its row, so a restart resumes the rooms that ran. The
		// canvas reports a stop that failed and stops the other rooms.
		await canvas.close();
		await workspaceTail;
		await workspace.dispose();
	}
	return {
		/** The specialists that a room can seat. */
		team: roomTeam.specialists.map(({ name, identity }) => ({ name, identity })),
		/** Whether a room is a breakout room. */
		isBreakout: (name: string) => known(name).start.kind === 'breakout',
		create,
		inRoom,
		watch,
		/** Call `changed` when a room opens, starts, stops, or is archived. The return value ends the watch. */
		watchRooms: (listener: () => void) =>
			canvas.subscribe((event) => {
				if (LIFECYCLE_EVENTS.has(event.type)) listener();
			}),
		withWorkspace,
		workspace,
		/** What the viewfinder reads of the canvas: the widgets of a room, and the events. */
		canvas: {
			widgets: (name: string) => canvas.widgets(name),
			answers: (name: string) => canvas.answers(name),
			subscribe: (listener: (event: CanvasEvent) => void) => canvas.subscribe(listener),
		},
		/** Press an action of a widget as a person. The canvas checks it and sends it as a message. */
		act(person: PersonDefinition, act: WidgetAct) {
			if (closing) fail('The host is stopping.');
			return canvas.act(person, act);
		},
		/** The folders that the files panel lists. */
		roots,
		lifecycle,
		/** The steps of one activation that this process logged. */
		activation: async (name: string, id: string) => {
			known(name);
			return log.read(name, id);
		},
		list: () => Promise.all(canvas.rooms().map((row) => view(row))),
		read: async (name: string, since?: number) =>
			view(known(name), since === undefined ? undefined : { after: since }),
		close() {
			shutdown ??= close().catch((error: unknown) => {
				shutdown = undefined;
				throw error;
			});
			return shutdown;
		},
	};
}

type ReadMessages = NonNullable<Parameters<typeof readRoom>[1]>['messages'];

/** A room as the host presents it: the recorded read, plus the hosting state and the recent work. */
export type RoomView = ReturnType<typeof roomView>;

function roomView(
	row: CanvasRoom,
	state: RoomState,
	snapshot: Awaited<ReturnType<typeof readRoom>>,
	running: boolean,
	unavailable: readonly string[],
) {
	return {
		...snapshot,
		/** The seats that cannot run because the model has no login. */
		unavailable,
		goal: snapshot.initialized ? snapshot.goal : row.goal,
		status: running ? ('running' as const) : ('stopped' as const),
		activity: [...state.activity],
		failures: new Map(state.failures) as ReadonlyMap<string, string>,
		pattern: row.name === buildRoom.name ? buildRoom.pattern : undefined,
		prompt: row.name === buildRoom.name ? buildRoom.prompt : undefined,
		...breakoutOf(row),
	};
}

/** What a breakout room adds to its view: the room that holds it, who opened it, and how it stands. */
interface BreakoutInfo {
	parent: string;
	opener: string;
	state: 'running' | 'stopped' | 'archived';
	/** How the opener closed the room. Only an archived room has it. */
	close?: CanvasClose;
}

/** The `breakout` field of a view: the facts of a breakout row, and nothing for a root room. */
function breakoutOf({ start, state, close }: CanvasRoom): { breakout?: BreakoutInfo } {
	if (start.kind !== 'breakout') return {};
	const { parent, opener } = start;
	return { breakout: { parent, opener, state, ...(close === undefined ? {} : { close }) } };
}

/** Tell every watcher of a room to read again. */
function changed(state: RoomState): void {
	for (const watcher of [...state.watchers]) watcher();
}

/** The name of the room that an event is about. */
function roomOf(event: CanvasEvent): string {
	if (event.type === 'widget') return event.widget.room;
	return event.type === 'opened' ? event.room.name : event.room;
}

/** The events that change which rooms exist or how a room stands. A widget or an answer is not one. */
const LIFECYCLE_EVENTS: ReadonlySet<CanvasEvent['type']> = new Set([
	'opened',
	'started',
	'stopped',
	'archived',
]);

/** Hear the events of a room that the canvas starts, and tell its watchers of each change. */
function heardEvent(
	event: CanvasEvent,
	stateOf: (name: string) => RoomState,
	room: (name: string) => Room | undefined,
): void {
	const name = roomOf(event);
	const state = stateOf(name);
	if (event.type === 'started') room(name)?.subscribe((heard) => notify(state, heard));
	changed(state);
}

/** A failure that the canvas survived goes to the activity list, where the person reads it. */
function reportFailure(state: RoomState, failure: CanvasError): void {
	const reason = failure.error instanceof Error ? failure.error.message : String(failure.error);
	const text =
		failure.operation === 'mirror'
			? `The room mirror failed: ${reason}`
			: `The ${failure.operation} of the room failed: ${reason}`;
	pushActivity(state, { type: 'error', text });
	changed(state);
}

/** One room event: record the activity it shows, then tell every watcher to read again. */
function notify(state: RoomState, event: RoomNotification): void {
	recordActivity(state, event);
	changed(state);
}

/** How many failure reasons a room keeps. */
const FAILURES_KEPT = 100;

/** Keep the reason of an activation that ended on a failure. */
function recordFailure(state: RoomState, step: TraceStep): void {
	if (step.type !== 'end' || step.failure === undefined) return;
	state.failures.set(step.activation, step.failure.message);
	for (const oldest of state.failures.keys()) {
		if (state.failures.size <= FAILURES_KEPT) break;
		state.failures.delete(oldest);
	}
}

function recordActivity(state: RoomState, event: RoomNotification): void {
	const activity = describeEvent(event);
	if (activity) pushActivity(state, activity);
}

function pushActivity(state: RoomState, activity: Omit<Activity, 'at'>): void {
	state.activity.push({ at: new Date().toISOString(), ...activity });
	state.activity.splice(0, Math.max(0, state.activity.length - 30));
}

function describeEvent(event: RoomNotification): Omit<Activity, 'at'> | undefined {
	switch (event.type) {
		case 'error':
		case 'port_error':
			return { type: event.type, agent: event.seat, text: event.error.message };
		case 'activation_start':
			return { type: event.type, agent: event.seat, text: 'Reading and working' };
		case 'activation_end':
			return { type: event.type, agent: event.seat, text: 'Finished activation' };
		case 'tool_call':
			return { type: event.type, agent: event.seat, text: `Using ${event.name}` };
		case 'abandoned':
			return { type: event.type, agent: event.seat, text: 'Retry limit reached' };
		default:
			return undefined;
	}
}
