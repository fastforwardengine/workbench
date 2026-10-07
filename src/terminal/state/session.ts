import type { Exchange } from '@ambionframework/ambion';
import type { FileEntry, Lab, Person, RoomAction, RoomView } from '../../host/host.ts';
import { MAX_GOAL, ROOM_NAME } from '../../host/names.ts';
import { liveActivations, type StepTotals, totalsOf } from '../../view/live.ts';
import { type Known, pickIds, type RefItem, refItems, shows, stayOfPick } from '../../view/refs.ts';
import {
	type ActivationSteps,
	activationLine,
	ended,
	NO_STEPS,
	stepsView,
} from '../../view/steps.ts';
import { errorText } from '../../view/text.ts';
import { type Block, buildTimeline } from '../../view/timeline.ts';
import { attachCommand, bodyOf, type StagedAttachment } from './attachments.ts';
import { attentionOf, newest, pick } from './attention.ts';
import { type Background, backgroundOf, roomChoices } from './breakouts.ts';
import { entryLoader, FileBrowser } from './browser.ts';
import { coalesced } from './coalesce.ts';
import {
	type Choices,
	type CommandName,
	type Parsed,
	parse,
	type Suggestion,
	suggest,
} from './commands.ts';
import { dismissCommand } from './dismiss.ts';
import { ProcessTails } from './process-tails.ts';
import { RoomReader } from './room-reader.ts';
import { DONE, HELP, mentionRefusal, notesOf, refusal, seatChoices } from './session-text.ts';

/** What the terminal does after a command, beyond what the session already changed. */
export type Intent =
	{ type: 'quit' | 'files' | 'processes' | 'camera' | 'voice' } | { type: 'compose'; text: string };

/** The seats that run an activation of the open exchange of a room view. */
const runningSeats = (view: RoomView): string[] =>
	(view.exchange?.activations ?? [])
		.filter((activation) => activation.outcome.kind === 'running')
		.map((activation) => activation.seat);

/**
 * Everything the terminal does that is not drawing. It holds who the person is,
 * which room is open, and what that room has said. It talks to the host directly.
 * The terminal draws its state and calls its methods, and calls `changed` back.
 */
export class Session {
	readonly host: Lab;
	identity: Person | undefined;
	rooms: RoomView[] = [];
	files: FileEntry[] = [];
	/** The seq of the message that a ref jumped to. The terminal highlights it. */
	focus: number | undefined;
	/** The files layer. It searches `files` and loads the chosen one. */
	readonly browser: FileBrowser;
	room = '';
	view: RoomView | undefined;
	blocks: Block[] = [];
	notice: string | undefined;
	error: string | undefined;
	offline: string | undefined;
	entered = false;
	/** Counts the notices, so the terminal redraws one that repeats. */
	noticeSeq = 0;
	/** The name of a room that waits for its goal. The next submission is the goal. */
	awaitingGoal: string | undefined;
	/** The activation whose steps the terminal shows. It re-reads on each room change. */
	steps: { id: string; read: ActivationSteps | undefined } | undefined;
	/** The files that `/attach` copied in. They go, as refs, with the next message. */
	pendingRefs: StagedAttachment[] = [];
	/** The full steps of each activation of the open exchange, by activation id. */
	private live = new Map<string, ActivationSteps>();
	/** The totals of each closed activation that this terminal read, by activation id. They are small. */
	private totals = new Map<string, StepTotals>();
	/** The folded line that the person expanded, and the steps that the host held for it. */
	unfolded: { id: string; read: ActivationSteps | undefined } | undefined;
	/** The newest output line of the processes that the running seats of the open exchange own. */
	private readonly tails: ProcessTails;
	private readonly reader: RoomReader<RoomView>;
	private readonly changed: () => void;
	private sending = false;
	private wantBottom = false;

	constructor(host: Lab, identity: Person | undefined, changed: () => void) {
		this.host = host;
		this.identity = identity;
		this.changed = changed;
		this.reader = new RoomReader<RoomView>(
			host,
			(view) => this.applyView(view),
			(error) => {
				this.offline = errorText(error);
				this.changed();
			},
			// A change of the open room may open, stop, or archive a breakout room.
			() => void this.listRooms(),
		);
		this.browser = new FileBrowser(entryLoader(host), changed);
		this.tails = new ProcessTails(host, () => this.rebuild());
	}

	/** True once when the conversation should scroll to its end, as after a notice. */
	takeBottom(): boolean {
		const bottom = this.wantBottom;
		this.wantBottom = false;
		return bottom;
	}

	get whoami(): string {
		return this.identity?.name ?? '';
	}

	/** The prompt the composer shows above the input, when the session waits for something. */
	get waiting(): string | undefined {
		return this.awaitingGoal ? `Goal for ${this.awaitingGoal}` : undefined;
	}

	// Reading

	async start(): Promise<void> {
		await this.refreshRooms();
		if (!this.identity) {
			const names = this.host.people.map((person) => person.name).join(', ');
			this.say(`Who are you in the lab? Pick a person: ${names}.`);
			return;
		}
		await this.enterFirstRoom();
	}

	private async enterFirstRoom(): Promise<void> {
		const first = this.rooms.find((room) => room.status === 'running') ?? this.rooms[0];
		if (first) await this.switchRoom(first.name);
	}

	async refreshRooms(): Promise<void> {
		try {
			this.rooms = await this.host.rooms();
			this.files = await this.host.files();
			this.offline = undefined;
		} catch (error) {
			this.offline = errorText(error);
		}
		this.changed();
	}

	/**
	 * Read the room list again, without the files. The watch of the open room calls it:
	 * a breakout room that opens, stops, or ends tells the watchers of its parent.
	 * A call during a read asks for one more read after it.
	 */
	private readonly listRooms = coalesced(async () => {
		try {
			this.rooms = await this.host.rooms();
		} catch (error) {
			this.offline = errorText(error);
		}
		this.changed();
	});

	/** The breakout rooms that run in the background of the open room. */
	get background(): Background {
		return backgroundOf(this.rooms, this.room);
	}

	/** Read the open room. The reader does it again when a change lands during a read. */
	refresh(): Promise<void> {
		return this.reader.refresh();
	}

	/** Take a room view from the reader: keep it, read the open steps, and build the timeline. */
	private async applyView(view: RoomView): Promise<void> {
		this.view = view;
		this.offline = undefined;
		await this.readSide(view.name);
		// A view of the room that the person left lands late. Its seats are not the open room's.
		if (view.name === this.room) this.tails.watch(view.name, runningSeats(view));
		this.rebuild();
	}

	/**
	 * The slow fallback. It reads the room list and the workspace files, which no
	 * room watch reports. It reads the open room only when the room does not run,
	 * because a stopped room records nothing for a watch to report.
	 */
	async poll(): Promise<void> {
		await this.refreshRooms();
		if (this.view?.status !== 'running') await this.refresh();
	}

	/** Read what a room read does not hold: the open steps and the live steps. */
	private async readSide(room: string): Promise<void> {
		await Promise.all([this.readSteps(room), this.readLive(room)]);
	}

	/** Read the steps that `/steps` shows. A failure keeps the last answer. */
	private async readSteps(room: string): Promise<void> {
		const steps = this.steps;
		if (!steps) return;
		const read = await this.host.activation(room, steps.id).catch(() => undefined);
		if (this.room !== room) return;
		if (read && this.steps?.id === steps.id) this.steps = { id: steps.id, read };
	}

	/**
	 * Read the steps of each activation of the room. A running activation reads
	 * again on each change. An ended activation of the open exchange reads again
	 * until a read holds its end step, so its title can count its calls and its
	 * time. The terminal keeps the full steps of the open exchange only. When an
	 * activation moves to a closed exchange, a last read gives its totals, and the
	 * steps go: the step log of the host holds the trace, and a closed line reads it
	 * again when the person expands the line. An activation that the terminal did
	 * not see in the open exchange has no totals, and its line shows the title
	 * without calls. A failed read keeps the last answer. An activation that left
	 * the room view drops out.
	 */
	private async readLive(room: string): Promise<void> {
		const all = (this.view?.exchanges ?? []).flatMap((exchange) => exchange.activations);
		const open = new Set((this.view?.exchange?.activations ?? []).map(({ id }) => id));
		const wanted = all.filter((activation) =>
			this.wantsRead(activation.id, activation.outcome.kind, open),
		);
		const reads = await Promise.all(
			wanted.map((activation) => this.host.activation(room, activation.id).catch(() => undefined)),
		);
		if (this.room !== room) return;
		const fresh = new Map(wanted.map((activation, at) => [activation.id, reads[at]]));
		this.keep(
			all.map(({ id }) => id),
			open,
			fresh,
		);
	}

	/**
	 * Keep the steps of the open exchange, and the totals of every other activation.
	 * The steps of an activation that moved to a closed exchange go.
	 */
	private keep(
		ids: readonly string[],
		open: ReadonlySet<string>,
		fresh: ReadonlyMap<string, ActivationSteps | undefined>,
	): void {
		const next = new Map<string, ActivationSteps>();
		const totals = new Map<string, StepTotals>();
		for (const id of ids) {
			const read = fresh.get(id) ?? this.live.get(id);
			const kept = read && !open.has(id) ? totalsOf(read) : this.totals.get(id);
			if (open.has(id) && read) next.set(id, read);
			else if (kept) totals.set(id, kept);
		}
		this.live = next;
		this.totals = totals;
	}

	/**
	 * True when an activation needs a read. A running one does. An ended one of the
	 * open exchange reads until it holds its end step. A closed one reads one more
	 * time when the terminal holds steps of it that have no end step, because the
	 * exchange can close before the last step lands.
	 */
	private wantsRead(id: string, outcome: string, open: ReadonlySet<string>): boolean {
		if (outcome === 'running') return true;
		const kept = this.live.get(id);
		if (open.has(id)) return !kept || !ended(kept);
		return kept !== undefined && !ended(kept);
	}

	/** The activations whose full steps the terminal holds: the activations of the open exchange. */
	get reads(): ReadonlyMap<string, ActivationSteps> {
		return this.live;
	}

	/** What the person owes the room, one line each. It is empty when nothing waits. */
	get attention(): string[] {
		return attentionOf(this.view, this.whoami);
	}

	/** The blocks that follow the closed exchanges: what waits on the person, and the open steps. */
	private tail(view: RoomView): Block[] {
		const blocks = notesOf(this.attention, view);
		const steps = this.steps;
		if (!steps?.read) return blocks;
		const activation = view.exchanges
			.flatMap((exchange) => exchange.activations)
			.find((candidate) => candidate.id === steps.id);
		blocks.push({
			type: 'steps',
			title: activation ? activationLine(activation) : steps.id,
			running: !ended(steps.read),
			passes: stepsView(steps.read),
		});
		return blocks;
	}

	rebuild(): void {
		const view = this.view;
		if (!view) return;
		const activity = view.activity.at(-1);
		const error = activity?.type === 'error' || activity?.type === 'port_error';
		this.blocks = buildTimeline({
			messages: this.reader.messages,
			exchanges: view.exchanges,
			open: view.exchange,
			humans: new Set(
				view.participants
					.filter((participant) => participant.kind === 'person')
					.map((participant) => participant.name),
			),
			live: liveActivations(
				view.exchange?.activations ?? [],
				this.live,
				view.failures,
				this.tails.bySeat,
			),
			activity: activity && error ? `${activity.agent ?? 'room'}: ${activity.text}` : undefined,
			tail: this.tail(view),
			failures: view.failures,
			totals: this.totals,
			expanded: this.unfolded,
		});
		this.changed();
	}

	choices(): Choices {
		return {
			rooms: roomChoices(this.rooms, this.room),
			people: this.host.people.map((person) => ({ name: person.name, role: person.role })),
			files: this.files,
			says: this.view?.scheduled ?? [],
			seats: seatChoices(this.host.team, this.view),
		};
	}

	suggestions(input: string): Suggestion[] {
		return suggest(input, this.choices());
	}

	// Saying and failing

	say(text: string): void {
		this.notice = text;
		this.noticeSeq += 1;
		this.wantBottom = true;
		this.rebuild();
		this.changed();
	}

	private fail(error: unknown): void {
		this.error = errorText(error);
		this.changed();
	}

	// The composer's submissions

	/** Handle what the person submitted: a goal, a message, or a command. */
	async submit(text: string): Promise<Intent | undefined> {
		this.error = undefined;
		this.notice = undefined;
		if (this.awaitingGoal) return this.createWithGoal(this.awaitingGoal, text);
		return this.execute(parse(text));
	}

	/**
	 * Ctrl+C. The terminal has cleared the composer; `hadText` says whether it
	 * held text. Ctrl+C drops a new room that waits for its goal. On an empty
	 * composer it drops the staged attachments, and with none staged it says
	 * how to leave.
	 */
	interrupt(hadText: boolean): void {
		if (this.awaitingGoal) this.cancelWaiting();
		else if (!hadText) this.dropStaged();
	}

	private dropStaged(): void {
		// A send in progress holds the staged attachments, so they go with the message.
		if (this.sending) return;
		const staged = this.pendingRefs.length;
		this.pendingRefs = [];
		this.say(
			staged === 0
				? 'Press Ctrl+D twice on an empty composer, or type /quit to leave.'
				: `Dropped ${staged} staged attachment${staged === 1 ? '' : 's'}.`,
		);
	}

	/** Drop a room that waits for its goal. */
	cancelWaiting(): void {
		if (!this.awaitingGoal) return;
		this.awaitingGoal = undefined;
		this.say('Canceled. No room was created.');
	}

	private async execute(parsed: Parsed): Promise<Intent | undefined> {
		if (parsed.kind === 'message') {
			const refusal = parsed.to
				? mentionRefusal(parsed, this.host.team, this.pendingRefs.length)
				: undefined;
			if (refusal) this.fail(new Error(refusal));
			else await this.send(parsed.text, parsed.to);
			return undefined;
		}
		if (parsed.kind === 'unknown') {
			this.say(
				`Unknown command /${parsed.name}. Type / to see the commands, or // to send a slash.`,
			);
			return undefined;
		}
		return this.command(parsed.name, parsed.argument);
	}

	private command(name: CommandName, argument: string): Promise<Intent | undefined> {
		return this.handlers[name](argument);
	}

	/** Wait for some work, then report that the command has no intent to pass on. */
	private async finish(work: unknown): Promise<undefined> {
		await work;
		return undefined;
	}

	/**
	 * What each command does. The type holds a handler for every name in
	 * `COMMANDS`, so a new command that has none does not compile.
	 */
	private readonly handlers: Record<
		CommandName,
		(argument: string) => Promise<Intent | undefined>
	> = {
		room: (argument) => this.finish(this.goTo(argument)),
		new: (argument) => this.finish(this.newRoom(argument)),
		user: (argument) => this.finish(this.chooseUser(argument)),
		files: () => this.openFiles(),
		open: (argument) => this.openFile(argument),
		attach: async (argument) => {
			const done = await attachCommand(this.host, this, argument);
			if ('error' in done) this.fail(done.error);
			else this.say(done.notice);
			return undefined;
		},
		ps: async () => ({ type: 'processes' }),
		camera: async () => ({ type: 'camera' }),
		voice: async () => ({ type: 'voice' }),
		dismiss: async (argument) => {
			const done = await dismissCommand(this.host, this.view, argument);
			if ('error' in done) this.fail(done.error);
			else this.say(done.notice);
			return undefined;
		},
		try: async () => {
			if (this.view?.prompt) return { type: 'compose', text: this.view.prompt };
			this.say('This room has no suggested question.');
			return undefined;
		},
		abort: () => this.finish(this.control('abort')),
		stop: () => this.finish(this.control('stop')),
		resume: () => this.finish(this.control('resume')),
		steps: (argument) => this.finish(this.stepsCommand(argument)),
		help: () => this.finish(this.say(HELP)),
		quit: async () => ({ type: 'quit' }),
	};

	// Rooms

	async switchRoom(name: string): Promise<void> {
		if (name === this.room) return;
		const previous = this.entered ? this.room : '';
		this.room = name;
		this.view = undefined;
		this.blocks = [];
		this.focus = undefined;
		this.steps = undefined;
		this.live = new Map();
		this.totals = new Map();
		this.unfolded = undefined;
		this.tails.stop();
		this.notice = undefined;
		const dropped = this.pendingRefs.length;
		this.pendingRefs = [];
		this.entered = false;
		this.wantBottom = true;
		this.reader.select(name);
		if (previous) await this.host.leave(previous, this.whoami).catch(() => {});
		await this.join();
		await this.refresh();
		if (dropped > 0) this.say(`Dropped ${dropped} staged attachment${dropped === 1 ? '' : 's'}.`);
	}

	private async join(): Promise<void> {
		if (!this.identity || !this.room) return;
		try {
			await this.host.join(this.room, this.identity.name);
			this.entered = true;
		} catch (error) {
			this.fail(error);
		}
	}

	private async goTo(name: string): Promise<void> {
		const found = this.rooms.find((room) => room.name.toLowerCase() === name.toLowerCase());
		if (found) return this.switchRoom(found.name);
		this.say(
			name
				? `No room named ${name}. Press Ctrl+R to see the rooms.`
				: 'Name a room, or press Ctrl+R.',
		);
	}

	private async newRoom(argument: string): Promise<void> {
		const [name = '', ...goal] = argument.split(/\s+/).filter(Boolean);
		if (!name) return this.say('Name the room: /new <name> [goal]');
		if (!ROOM_NAME.test(name))
			return this.say(
				'Use a lowercase room name, up to 48 letters, digits, or dashes, starting with a letter.',
			);
		if (this.rooms.some((room) => room.name === name)) return this.say(`${name} already exists.`);
		if (goal.length > 0) return this.createWithGoal(name, goal.join(' '));
		this.awaitingGoal = name;
		this.say(`What is ${name} for? Type its goal and press Enter. Esc cancels.`);
	}

	private async createWithGoal(name: string, goal: string): Promise<undefined> {
		const text = goal.trim();
		if (!text || text.length > MAX_GOAL) {
			this.say(
				`A goal takes 1 to ${MAX_GOAL} characters. Type it and press Enter, or Esc to cancel.`,
			);
			return undefined;
		}
		try {
			await this.host.create(name, text);
			this.awaitingGoal = undefined;
			await this.refreshRooms();
			await this.switchRoom(name);
			this.say(`Created ${name}.`);
		} catch (error) {
			this.awaitingGoal = undefined;
			this.fail(error);
		}
		return undefined;
	}

	// People

	private async chooseUser(argument: string): Promise<void> {
		const names = this.host.people.map((person) => person.name);
		if (!argument) return this.say(`Pick a person: ${names.join(', ')}. Type /user <name>.`);
		const person = this.host.people.find((candidate) => candidate.name === argument.toLowerCase());
		if (!person) return this.say(`No person named ${argument}. Pick one of ${names.join(', ')}.`);
		if (this.identity?.name === person.name) return this.say(`You are already ${person.name}.`);
		if (this.entered && this.identity)
			await this.host.leave(this.room, this.identity.name).catch(() => {});
		this.identity = person;
		this.entered = false;
		if (this.room) {
			await this.join();
			await this.refresh();
		} else {
			await this.enterFirstRoom();
		}
		this.say(`You are ${person.name}, ${person.role.toLowerCase()}.`);
	}

	// Messages and room control

	private async send(text: string, to?: string): Promise<void> {
		const body = bodyOf(text, to, this.pendingRefs);
		if (!body) return;
		if (this.sending) return this.fail(new Error('The last message is still sending.'));
		if (!this.identity) return this.say('Pick a person first: /user <name>.');
		if (!this.room) return this.say('Open a room first: /room <name>.');
		if (this.view && this.view.status !== 'running')
			return this.fail(new Error(`${this.view.name} is ${this.view.status}. Use /resume first.`));
		this.sending = true;
		// The array can be replaced while the send runs, by a switch to another room.
		// Take the files off the array they came from, and no other.
		const staged = this.pendingRefs;
		const refs = staged.map((one) => one.ref);
		try {
			if (!this.entered) await this.join();
			await this.host.send(this.room, this.identity.name, crypto.randomUUID(), body, refs, to);
			staged.splice(0, refs.length);
			this.wantBottom = true;
			await this.refresh();
		} catch (error) {
			this.fail(error);
		} finally {
			this.sending = false;
		}
	}

	private async control(action: RoomAction): Promise<void> {
		const reason = refusal(action, this.view);
		if (reason) return this.say(reason);
		try {
			await this.host.control(this.room, action);
			if (action === 'stop') this.entered = false;
			if (action === 'resume') await this.join();
			await this.refresh();
			this.say(DONE[action](this.room));
		} catch (error) {
			this.fail(error);
		}
	}

	// Files

	private async openFiles(path?: string, extra?: FileEntry): Promise<Intent | undefined> {
		try {
			this.files = await this.host.files();
		} catch (error) {
			this.fail(error);
			return undefined;
		}
		this.browser.show(this.files, path, extra);
		return { type: 'files' };
	}

	// Refs

	/** What a ref is checked against: the workspace files and this room. */
	private get known(): Known {
		return {
			room: this.room,
			files: this.files.map((file) => file.path),
			seqs: new Set(this.reader.messages.map((message) => message.seq)),
		};
	}

	/** The refs of the messages the conversation shows, top to bottom. */
	get refItems(): RefItem[] {
		return refItems(this.blocks, this.known);
	}

	/** What the pick key can choose, top to bottom: the refs and the folded activation lines. */
	get pickIds(): string[] {
		return pickIds(this.blocks, this.known);
	}

	/** Open what the pick key chose. A folded line expands or folds, and a ref opens as `openRef` says. */
	async openPick(id: string): Promise<Intent | undefined> {
		const activation = stayOfPick(id);
		if (activation === undefined) return this.openRef(id);
		await this.toggleStay(activation);
		return undefined;
	}

	/**
	 * Expand the folded line of a closed activation, or fold it when it is open.
	 * It reads the steps through the host call that `/steps` uses. One line is open at a time.
	 */
	private async toggleStay(id: string): Promise<void> {
		if (this.unfolded?.id === id) {
			this.unfolded = undefined;
			this.rebuild();
			return;
		}
		const room = this.room;
		const read = await this.host.activation(room, id).catch(() => undefined);
		if (this.room !== room) return;
		this.unfolded = { id, read };
		this.rebuild();
	}

	/**
	 * Open a ref. A file, a snapshot, and a commit open in the files layer, and
	 * the terminal shows the layer when this returns the intent. A message ref moves the focus
	 * to that message. A ref that does not resolve opens nothing.
	 */
	async openRef(id: string): Promise<Intent | undefined> {
		const target = this.refItems.find((item) => item.id === id)?.resolved.target;
		if (!target) return undefined;
		if (target.kind === 'message') {
			this.jump(target.seq);
			return undefined;
		}
		if (target.kind === 'snapshot' || target.kind === 'commit')
			return this.openFiles(target.ref, {
				path: target.ref,
				size: 0,
				kind: target.kind,
				label: target.label,
			});
		return this.openFiles(target.path);
	}

	/** Focus one message. */
	jump(seq: number): void {
		this.focus = seq;
		this.rebuild();
		if (!shows(this.blocks, seq)) {
			this.focus = undefined;
			this.say(`Message ${seq} is not in the conversation.`);
		}
	}

	/** Drop the focus that a message ref set. */
	clearFocus(): void {
		if (this.focus === undefined) return;
		this.focus = undefined;
		this.changed();
	}

	private async openFile(argument: string): Promise<Intent | undefined> {
		if (!argument) return this.openFiles();
		const wanted = argument.toLowerCase();
		const matches = this.files.filter(
			(file) => file.path.toLowerCase() === wanted || file.path.toLowerCase() === `/${wanted}`,
		);
		const found = matches[0] ?? this.files.find((file) => file.path.toLowerCase().includes(wanted));
		if (found) return this.openFiles(found.path);
		this.say(`No file matches ${argument}. Type /files to search them.`);
		return undefined;
	}

	// Steps

	private async stepsCommand(argument: string): Promise<void> {
		if (argument === 'off') {
			this.steps = undefined;
			return this.rebuild();
		}
		const exchange = pick(this.view?.exchanges ?? [], argument);
		if (!exchange) return this.say(argument ? `No exchange ${argument}.` : 'No activation yet.');
		return this.showExchange(exchange);
	}

	private async showExchange(exchange: Exchange): Promise<void> {
		const activation = newest(exchange);
		if (!activation) return this.say('That exchange ran no activation.');
		try {
			const read = await this.host.activation(this.room, activation.id);
			this.steps = { id: activation.id, read };
			this.wantBottom = true;
			this.rebuild();
			if (!read || read.passes.length === 0) this.say(NO_STEPS);
		} catch (error) {
			this.fail(error);
		}
	}

	/** End the person's visit, so the room shows them as gone after the terminal exits. */
	async leave(): Promise<void> {
		this.reader.stop();
		this.tails.dispose();
		if (this.room && this.entered && this.identity)
			await this.host.leave(this.room, this.identity.name).catch(() => {});
	}
}
