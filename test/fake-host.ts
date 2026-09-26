import type {
	ActivationSteps,
	FileContent,
	FileEntry,
	Lab,
	Person,
	ProcessView,
	RoomView,
} from '../src/host/host.ts';
import { Session } from '../src/terminal/session.ts';

const person = (name: string, role: string) =>
	({ name, role, identity: name }) as unknown as Person;
export const view = (name: string, extra: Record<string, unknown> = {}) =>
	({
		name,
		initialized: true,
		goal: `${name} goal`,
		status: 'running',
		activity: [],
		failures: new Map(),
		prompt: `Try ${name}`,
		messages: [],
		participants: [],
		exchanges: [],
		exchange: undefined,
		scheduled: [],
		watermark: 0,
		...extra,
	}) as unknown as RoomView;

/** A host that records each call and answers from a table. */
export class FakeHost implements Lab {
	readonly people = [person('priya', 'Hardware lead'), person('noor', 'Electrochemistry lead')];
	readonly calls: string[] = [];
	readonly table = new Map<string, RoomView>([
		['characterization', view('characterization')],
		['budget', view('budget')],
	]);
	fileList: FileEntry[] = [
		{ path: '/library/cell-18650.md', size: 797 },
		{ path: '/shared/notes.md', size: 40 },
	];
	failNext: string | undefined;

	private record(call: string): void {
		this.calls.push(call);
		if (this.failNext) {
			const message = this.failNext;
			this.failNext = undefined;
			throw new Error(message);
		}
	}

	async rooms() {
		return [...this.table.values()];
	}
	/** How many times the session read a room. */
	readCount = 0;
	/** While set, a read waits for it. A test uses it to hold a read open. */
	gate: Promise<void> | undefined;
	/** The listeners for each room, as `watch` registered them. */
	readonly watching = new Map<string, Set<() => void>>();

	async read(room: string) {
		this.readCount += 1;
		if (this.gate) await this.gate;
		const found = this.table.get(room);
		if (!found) throw new Error(`No room ${room}`);
		return found;
	}
	watch(room: string, changed: () => void) {
		const listeners = this.watching.get(room) ?? new Set<() => void>();
		listeners.add(changed);
		this.watching.set(room, listeners);
		return () => {
			listeners.delete(changed);
		};
	}
	/** Tell every listener of a room that it changed, as the host does on a room event. */
	notify(room: string): void {
		for (const listener of [...(this.watching.get(room) ?? [])]) listener();
	}
	listeners(room: string): number {
		return this.watching.get(room)?.size ?? 0;
	}
	async join(room: string, who: string) {
		this.record(`join:${room}:${who}`);
	}
	async leave(room: string, who: string) {
		this.record(`leave:${room}:${who}`);
	}
	async send(room: string, who: string, _key: string, text: string) {
		this.record(`send:${room}:${who}:${text}`);
	}
	async control(room: string, action: string) {
		this.record(`control:${room}:${action}`);
		return this.read(room);
	}
	/** What `dismiss` answers: true while the say waits. */
	dismissed = true;
	async dismiss(room: string, handle: number) {
		this.calls.push(`dismiss:${room}:${handle}`);
		return this.dismissed;
	}
	async create(name: string, goal: string) {
		this.record(`create:${name}:${goal}`);
		const created = view(name, { goal });
		this.table.set(name, created);
		return created;
	}
	/** The traces the host holds, by activation id. */
	readonly traces = new Map<string, ActivationSteps>();
	async activation(_room: string, id: string) {
		this.calls.push(`activation:${id}`);
		return this.traces.get(id);
	}
	async files() {
		return this.fileList;
	}
	/** Every path the session asked the host to read. */
	readonly reads: string[] = [];
	async file(path: string): Promise<FileContent> {
		this.reads.push(path);
		return { path, text: `text of ${path}`, truncated: false };
	}
	/** The processes the host lists. A cancel moves one to `cancelled`. */
	processTable: ProcessView[] = [];
	readonly processWatchers = new Set<() => void>();
	/** While set, a process list waits for it. */
	processGate: Promise<void> | undefined;
	/** While set, a process list fails with it. */
	processFailure: string | undefined;
	/** The state a cancel gives. `running` stands for a process that did not end in time. */
	cancelState: ProcessView['state'] = 'cancelled';
	async processes() {
		const table = [...this.processTable];
		if (this.processGate) await this.processGate;
		if (this.processFailure) throw new Error(this.processFailure);
		return table;
	}
	async processOutput(handle: string) {
		this.reads.push(handle);
		return { handle, text: `output of ${handle}\n`, size: 20, truncated: false };
	}
	async cancelProcess(handle: string) {
		this.calls.push(`cancel:${handle}`);
		this.processTable = this.processTable.map((process) =>
			process.handle === handle ? { ...process, state: this.cancelState } : process,
		);
		const found = this.processTable.find((process) => process.handle === handle);
		if (!found) throw new Error(`No process ${handle}.`);
		return found;
	}
	watchProcesses(changed: () => void) {
		this.processWatchers.add(changed);
		return () => {
			this.processWatchers.delete(changed);
		};
	}
	async close() {
		this.calls.push('close');
	}
}

export async function started(name: string | null = 'priya') {
	const host = new FakeHost();
	let changes = 0;
	const identity = name ? host.people.find((candidate) => candidate.name === name) : undefined;
	const session = new Session(host, identity, () => {
		changes += 1;
	});
	await session.start();
	return { host, session, changes: () => changes };
}
