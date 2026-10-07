import { describe, expect, it, vi } from 'vitest';
import type { ActivationSteps, ProcessView } from '../src/host/host.ts';
import { lastPart } from '../src/host/processes.ts';
import { COMMANDS } from '../src/terminal/state/commands.ts';
import { ProcessBrowser, stateText } from '../src/terminal/state/process-browser.ts';
import { Session } from '../src/terminal/state/session.ts';
import { HELP } from '../src/terminal/state/session-text.ts';
import { FakeHost, started, view } from './fake-host.ts';

describe('Session start', () => {
	it('opens the first running room as the chosen person', async () => {
		const { host, session } = await started();
		expect(session.room).toBe('characterization');
		expect(session.entered).toBe(true);
		expect(host.calls).toEqual(['join:characterization:priya']);
	});

	it('asks who the person is, and joins no room, when nobody is chosen', async () => {
		const { host, session } = await started(null);
		expect(session.identity).toBeUndefined();
		expect(session.room).toBe('');
		expect(host.calls).toEqual([]);
		expect(session.notice).toMatch(/Who are you.*priya, noor/);
	});

	it('tells the terminal to redraw when the state changes', async () => {
		const { changes } = await started();
		expect(changes()).toBeGreaterThan(0);
	});
});

describe('Session sending', () => {
	/** A session whose next send waits until the test calls `release`. */
	async function held() {
		const built = await started();
		let release: () => void = () => {};
		built.host.sendGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		return { ...built, release: () => release() };
	}

	it('tells the terminal to redraw when a send starts and when it ends', async () => {
		const { session, changes, release } = await held();
		expect(session.sending).toBe(false);
		const before = changes();
		const sent = session.submit('Check the diode.');
		expect(session.sending).toBe(true);
		expect(changes()).toBeGreaterThan(before);
		const during = changes();
		release();
		await sent;
		expect(session.sending).toBe(false);
		expect(changes()).toBeGreaterThan(during);
	});

	it('ends the sending state when the send fails', async () => {
		const { host, session } = await started();
		host.send = async () => {
			throw new Error('The link dropped.');
		};
		await session.submit('Check the diode.');
		expect(session.sending).toBe(false);
		expect(session.error).toBe('The link dropped.');
	});
});

describe('Session mentions', () => {
	it('sends a message with the seat it addresses, and keeps the mention in the text', async () => {
		const { host, session } = await started();
		await session.submit('@engineer check the diode');
		expect(host.calls.at(-1)).toBe('send:characterization:priya:@engineer check the diode');
		expect(host.sentTo).toEqual(['engineer']);
		await session.submit('no mention');
		expect(host.sentTo).toEqual(['engineer']);
	});

	it('lists the seats of the roster, with their attention in the open room', async () => {
		const { host, session } = await started();
		host.table.set(
			'characterization',
			view('characterization', {
				participants: [
					{ kind: 'agent', name: 'engineer', identity: 'B', status: 'idle', attention: 'named' },
				],
			}),
		);
		await session.refresh();
		expect(session.suggestions('@').map((row) => [row.label, row.detail])).toEqual([
			['@researcher', 'not seated'],
			['@engineer', 'named'],
		]);
	});

	it('refuses an unknown seat and an empty question, and sends nothing', async () => {
		const { host, session } = await started();
		host.calls.length = 0;
		await session.submit('@nobody hello');
		expect(session.error).toContain('No seat or specialist named @nobody');
		await session.submit('@engineer');
		expect(session.error).toBe('Say what to ask @engineer.');
		expect(host.calls).toEqual([]);
	});

	it('sends a leading at sign after a double at sign', async () => {
		const { host, session } = await started();
		await session.submit('@@nobody hello');
		expect(host.calls.at(-1)).toBe('send:characterization:priya:@nobody hello');
		expect(host.sentTo).toEqual([]);
	});
});

describe('Session users', () => {
	it('chooses the first person, then enters the first room', async () => {
		const { host, session } = await started(null);
		await session.submit('/user noor');
		expect(session.identity?.name).toBe('noor');
		expect(host.calls).toEqual(['join:characterization:noor']);
		expect(session.notice).toBe('You are noor, electrochemistry lead.');
	});

	it('leaves the room as the old person, and enters it as the new one', async () => {
		const { host, session } = await started();
		host.calls.length = 0;
		await session.submit('/user noor');
		expect(host.calls).toEqual(['leave:characterization:priya', 'join:characterization:noor']);
		expect(session.room).toBe('characterization');
		expect(session.entered).toBe(true);
	});

	it('lists the people for /user, and refuses an unknown or the same person', async () => {
		const { host, session } = await started();
		host.calls.length = 0;
		await session.submit('/user');
		expect(session.notice).toMatch(/Pick a person: priya, noor/);
		await session.submit('/user nobody');
		expect(session.notice).toMatch(/No person named nobody/);
		await session.submit('/user priya');
		expect(session.notice).toBe('You are already priya.');
		expect(host.calls).toEqual([]);
	});
});

describe('Session rooms', () => {
	it('leaves the room it was in before it enters another', async () => {
		const { host, session } = await started();
		host.calls.length = 0;
		await session.submit('/room budget');
		expect(host.calls).toEqual(['leave:characterization:priya', 'join:budget:priya']);
		expect(session.room).toBe('budget');
	});

	it('names the fix when the room does not exist', async () => {
		const { session } = await started();
		await session.submit('/room nowhere');
		expect(session.notice).toMatch(/No room named nowhere/);
		expect(session.room).toBe('characterization');
	});

	it('creates a room named with its goal, and opens it', async () => {
		const { host, session } = await started();
		await session.submit('/new formulation Mix a coating for the cell tabs');
		expect(host.calls).toContain('create:formulation:Mix a coating for the cell tabs');
		expect(session.room).toBe('formulation');
		expect(session.notice).toBe('Created formulation.');
	});

	it('asks for the goal when the command has none, and takes the next line as the goal', async () => {
		const { host, session } = await started();
		await session.submit('/new formulation');
		expect(session.awaitingGoal).toBe('formulation');
		expect(session.waiting).toBe('Goal for formulation');
		expect(host.calls.some((call) => call.startsWith('create'))).toBe(false);
		await session.submit('Mix a coating for the cell tabs');
		expect(host.calls).toContain('create:formulation:Mix a coating for the cell tabs');
		expect(session.awaitingGoal).toBeUndefined();
		expect(session.room).toBe('formulation');
	});

	it('can drop a room that waits for its goal', async () => {
		const { host, session } = await started();
		await session.submit('/new formulation');
		session.cancelWaiting();
		expect(session.awaitingGoal).toBeUndefined();
		expect(session.notice).toMatch(/Canceled/);
		expect(host.calls.some((call) => call.startsWith('create'))).toBe(false);
	});

	it('refuses a bad name at once, and a room that exists', async () => {
		const { host, session } = await started();
		await session.submit('/new Bad_Name');
		expect(session.notice).toMatch(/lowercase room name/);
		await session.submit('/new characterization');
		expect(session.notice).toBe('characterization already exists.');
		await session.submit('/new');
		expect(session.notice).toMatch(/Name the room/);
		expect(host.calls.some((call) => call.startsWith('create'))).toBe(false);
	});

	it('reports a failed creation and stops waiting', async () => {
		const { host, session } = await started();
		await session.submit('/new formulation');
		host.failNext = 'The host refused.';
		await session.submit('Mix a coating');
		expect(session.error).toBe('The host refused.');
		expect(session.awaitingGoal).toBeUndefined();
	});
});

describe('Session messages and control', () => {
	it('sends a message as the person, and enters first when not present', async () => {
		const { host, session } = await started();
		session.entered = false;
		host.calls.length = 0;
		await session.submit('Which resistor?');
		expect(host.calls).toEqual([
			'join:characterization:priya',
			'send:characterization:priya:Which resistor?',
		]);
	});

	it('asks for a person before it sends for nobody', async () => {
		const { host, session } = await started(null);
		await session.submit('Hello?');
		expect(session.notice).toMatch(/Pick a person first/);
		expect(host.calls).toEqual([]);
	});

	it('keeps the text and names the fix when the room is stopped', async () => {
		const { host, session } = await started();
		host.table.set('characterization', view('characterization', { status: 'stopped' }));
		await session.refresh();
		host.calls.length = 0;
		await session.submit('Anybody?');
		expect(session.error).toBe('characterization is stopped. Use /resume first.');
		expect(host.calls).toEqual([]);
	});

	it('shows a host error instead of losing it', async () => {
		const { host, session } = await started();
		host.failNext = 'Enter this room before sending.';
		await session.submit('Hello');
		expect(session.error).toBe('Enter this room before sending.');
	});

	it('refuses to abort when no exchange is open, and aborts when one is', async () => {
		const { host, session } = await started();
		await session.submit('/abort');
		expect(session.notice).toBe('Nothing to abort. characterization has no open exchange.');
		expect(host.calls.some((call) => call.startsWith('control'))).toBe(false);
		host.table.set(
			'characterization',
			view('characterization', { exchange: { person: 'priya', from: 4, at: '' } }),
		);
		await session.refresh();
		await session.submit('/abort');
		expect(host.calls).toContain('control:characterization:abort');
		expect(session.notice).toBe('Aborted the open exchange in characterization.');
	});

	it('stops a room, marks the person out of it, and enters it again on resume', async () => {
		const { host, session } = await started();
		await session.submit('/stop');
		expect(session.entered).toBe(false);
		host.table.set('characterization', view('characterization', { status: 'stopped' }));
		await session.refresh();
		await session.submit('/stop');
		expect(session.notice).toBe('characterization is already stopped.');
		host.calls.length = 0;
		await session.submit('/resume');
		expect(host.calls).toEqual(['control:characterization:resume', 'join:characterization:priya']);
		expect(session.entered).toBe(true);
	});

	it('ends the visit on leave, and only when the person is in the room', async () => {
		const { host, session } = await started();
		host.calls.length = 0;
		await session.leave();
		expect(host.calls).toEqual(['leave:characterization:priya']);
		session.entered = false;
		await session.leave();
		expect(host.calls).toEqual(['leave:characterization:priya']);
	});
});

describe('Session files and prompts', () => {
	it('opens the files panel on the first file, and previews it', async () => {
		const { session } = await started();
		expect(await session.submit('/files')).toEqual({ type: 'files' });
		await vi.waitFor(() => expect(session.browser.file?.path).toBe('/library/cell-18650.md'));
		expect(session.browser.open).toBe(true);
		expect(session.browser.file?.text).toBe('text of /library/cell-18650.md');
	});

	it('narrows the files as the person types, and follows the selection', async () => {
		const { session } = await started();
		await session.submit('/files');
		session.browser.type('NOTES');
		expect(session.browser.matches.map((file) => file.path)).toEqual(['/shared/notes.md']);
		await vi.waitFor(() => expect(session.browser.file?.path).toBe('/shared/notes.md'));
		session.browser.clear();
		await vi.waitFor(() => expect(session.browser.file?.path).toBe('/library/cell-18650.md'));
		session.browser.move(1);
		await vi.waitFor(() => expect(session.browser.file?.path).toBe('/shared/notes.md'));
		session.browser.type('nothing');
		expect(session.browser.selected).toBeUndefined();
		await vi.waitFor(() => expect(session.browser.file).toBeUndefined());
	});

	it('opens the panel on one file for /open, by path or by a part of it', async () => {
		const { session } = await started();
		await session.refreshRooms();
		for (const argument of ['/library/cell-18650.md', 'library/cell-18650.md', 'cell-1']) {
			expect(await session.submit(`/open ${argument}`)).toEqual({ type: 'files' });
			expect(session.browser.selected?.path).toBe('/library/cell-18650.md');
		}
	});

	it('says so when /open matches no file, and opens the panel with none named', async () => {
		const { session } = await started();
		expect(await session.submit('/open nothing')).toBeUndefined();
		expect(session.notice).toMatch(/No file matches nothing/);
		expect(await session.submit('/open')).toEqual({ type: 'files' });
	});

	it('fills the composer with the room’s suggested question', async () => {
		const { session } = await started();
		expect(await session.submit('/try')).toEqual({
			type: 'compose',
			text: 'Try characterization',
		});
	});

	it('returns a quit intent, and a message for an unknown command', async () => {
		const { session } = await started();
		expect(await session.submit('/quit')).toEqual({ type: 'quit' });
		await session.submit('/nope');
		expect(session.notice).toMatch(/Unknown command \/nope/);
	});
});

describe('Session push updates', () => {
	it('reads the open room when the host reports a change', async () => {
		const { host, session } = await started();
		const before = host.readCount;
		host.table.set(
			'characterization',
			view('characterization', { exchange: { person: 'priya', from: 4, at: '' } }),
		);
		host.notify('characterization');
		await vi.waitFor(() => expect(session.view?.exchange).toBeDefined());
		expect(host.readCount).toBeGreaterThan(before);
	});

	it('watches only the open room, and moves the watch when the room changes', async () => {
		const { host, session } = await started();
		expect(host.listeners('characterization')).toBe(1);
		await session.submit('/room budget');
		expect(host.listeners('characterization')).toBe(0);
		expect(host.listeners('budget')).toBe(1);
	});

	it('ends the watch when the person leaves', async () => {
		const { host, session } = await started();
		await session.leave();
		expect(host.listeners('characterization')).toBe(0);
	});

	it('reads once more, not once per change, when changes land during a read', async () => {
		const { host, session } = await started();
		const gate = Promise.withResolvers<void>();
		host.gate = gate.promise;
		const before = host.readCount;
		for (let change = 0; change < 5; change += 1) host.notify('characterization');
		host.gate = undefined;
		gate.resolve();
		await vi.waitFor(() => expect(host.readCount).toBe(before + 2));
		await new Promise<void>((resolve) => setTimeout(resolve, 30));
		expect(host.readCount).toBe(before + 2);
		expect(session.offline).toBeUndefined();
	});

	it('reads a stopped room on the slow poll, and leaves a running room to the watch', async () => {
		const { host, session } = await started();
		const running = host.readCount;
		await session.poll();
		expect(host.readCount).toBe(running);
		host.table.set('characterization', view('characterization', { status: 'stopped' }));
		await session.refresh();
		const stopped = host.readCount;
		await session.poll();
		expect(host.readCount).toBeGreaterThan(stopped);
	});

	it('reports a failed read from a change, and recovers on the next one', async () => {
		const { host, session } = await started();
		host.table.delete('characterization');
		host.notify('characterization');
		await vi.waitFor(() => expect(session.offline).toMatch(/No room characterization/));
		host.table.set('characterization', view('characterization'));
		host.notify('characterization');
		await vi.waitFor(() => expect(session.offline).toBeUndefined());
	});

	it('tells the terminal to redraw when a read fails', async () => {
		const { host, session, changes } = await started();
		const before = changes();
		host.table.delete('characterization');
		host.notify('characterization');
		await vi.waitFor(() => expect(session.offline).toMatch(/No room characterization/));
		expect(changes()).toBeGreaterThan(before);
	});
});

const AT = '2026-01-01T00:00:00Z';
const closedExchange = (from: number, extra: Record<string, unknown> = {}) => ({
	from,
	through: from + 1,
	status: 'closed',
	person: 'priya',
	at: AT,
	outcome: { kind: 'complete' },
	summary: { kind: 'silent' },
	activations: [
		{
			id: `act-${from}`,
			seat: 'design',
			purpose: 'respond',
			attempt: 1,
			outcome: { kind: 'released' },
		},
	],
	...extra,
});
const trace = (id: string, withEnd: boolean): ActivationSteps =>
	({
		activation: id,
		passes: [
			{
				pass: 1,
				input: 'view',
				through: 4,
				steps: [
					{ type: 'pass', pass: 1, input: 'view', through: 4 },
					{ type: 'tool_call', call: 'c1', name: 'read', input: { path: '/a' } },
					...(withEnd ? [{ type: 'end', stop: 'stopped' }] : []),
				],
			},
		],
	}) as unknown as ActivationSteps;
const blockTypes = (session: Session) => session.blocks.map((block) => block.type);
const stepsBlock = (session: Session) =>
	session.blocks.find((candidate) => candidate.type === 'steps');

describe('Session steps', () => {
	it('opens the steps of the latest exchange, and reads them again on a room change', async () => {
		const { host, session } = await started();
		host.table.set(
			'characterization',
			view('characterization', { exchanges: [closedExchange(4)] }),
		);
		host.traces.set('act-4', trace('act-4', false));
		await session.refresh();
		await session.submit('/steps');
		expect(host.calls).toContain('activation:act-4');
		expect(stepsBlock(session)).toMatchObject({
			type: 'steps',
			running: true,
			title: 'design · respond · attempt 1',
		});
		host.traces.set('act-4', trace('act-4', true));
		host.notify('characterization');
		await vi.waitFor(() => expect(stepsBlock(session)).toMatchObject({ running: false }));
		await session.submit('/steps off');
		expect(blockTypes(session)).not.toContain('steps');
	});

	it('picks an exchange by ordinal, and refuses one that does not exist', async () => {
		const { host, session } = await started();
		host.table.set(
			'characterization',
			view('characterization', { exchanges: [closedExchange(4), closedExchange(9)] }),
		);
		host.traces.set('act-4', trace('act-4', true));
		await session.refresh();
		await session.submit('/steps 1');
		expect(session.steps?.id).toBe('act-4');
		await session.submit('/steps 7');
		expect(session.notice).toBe('No exchange 7.');
	});

	it('says so when the activation has no trace', async () => {
		const { host, session } = await started();
		host.table.set(
			'characterization',
			view('characterization', { exchanges: [closedExchange(4)] }),
		);
		await session.refresh();
		await session.submit('/steps');
		expect(session.notice).toMatch(/holds no steps/);
	});

	it('opens the attempt that ran, and not the attempt the room abandoned after it', async () => {
		const { host, session } = await started();
		const attempt = (id: string, status: string, attempt: number) => ({
			id,
			seat: 'engineer',
			purpose: 'respond',
			attempt,
			outcome: { kind: status, cause: 'permanent' },
		});
		const activations = [attempt('act-4', 'failed', 1), attempt('act-4b', 'abandoned', 2)];
		host.table.set(
			'characterization',
			view('characterization', { exchanges: [closedExchange(4, { activations })] }),
		);
		host.traces.set('act-4', trace('act-4', true));
		await session.refresh();
		await session.submit('/steps');
		expect(session.steps?.id).toBe('act-4');
	});
});

describe('Session live block', () => {
	const open = (activations: unknown[]) =>
		view('characterization', {
			exchange: { from: 4, status: 'open', person: 'priya', at: AT, activations },
			exchanges: [{ from: 4, status: 'open', person: 'priya', at: AT, activations }],
		});
	const running = { id: 'act-9', seat: 'engineer', purpose: 'respond', attempt: 1 };
	const liveBlock = (session: Session) =>
		session.blocks.find((candidate) => candidate.type === 'live');

	it('shows the calls of a running activation, and reads them again on each change', async () => {
		const { host, session } = await started();
		host.table.set('characterization', open([{ ...running, outcome: { kind: 'running' } }]));
		host.traces.set('act-9', trace('act-9', false));
		await session.refresh();
		expect(host.calls).toContain('activation:act-9');
		expect(liveBlock(session)).toMatchObject({
			text: 'Working on priya’s question',
			activations: [
				{
					id: 'act-9',
					state: 'running',
					title: 'engineer · respond',
					calls: [{ state: 'running', text: '→ read /a', result: '' }],
				},
			],
		});
		host.table.set('characterization', open([{ ...running, outcome: { kind: 'released' } }]));
		host.notify('characterization');
		await vi.waitFor(() =>
			expect(liveBlock(session)).toMatchObject({
				activations: [{ state: 'done', calls: [] }],
			}),
		);
	});

	it('reads an ended activation until a read holds its end step, for its title', async () => {
		const { host, session } = await started();
		host.table.set('characterization', open([{ ...running, outcome: { kind: 'running' } }]));
		host.traces.set('act-9', trace('act-9', false));
		await session.refresh();
		const reads = () => host.calls.filter((call) => call === 'activation:act-9').length;
		host.table.set('characterization', open([{ ...running, outcome: { kind: 'released' } }]));
		host.traces.set('act-9', trace('act-9', true));
		await session.refresh();
		expect(liveBlock(session)).toMatchObject({
			activations: [{ state: 'done', title: 'engineer · respond · 1 call' }],
		});
		const before = reads();
		await session.refresh();
		expect(reads()).toBe(before);
		expect(liveBlock(session)).toMatchObject({
			activations: [{ title: 'engineer · respond · 1 call' }],
		});
	});

	it('keeps the last steps when a read fails, and drops them when the room changes', async () => {
		const { host, session } = await started();
		host.table.set('characterization', open([{ ...running, outcome: { kind: 'running' } }]));
		host.traces.set('act-9', trace('act-9', false));
		await session.refresh();
		host.traces.delete('act-9');
		await session.refresh();
		expect(liveBlock(session)).toMatchObject({ activations: [{ calls: [{ text: '→ read /a' }] }] });
		await session.switchRoom('budget');
		expect(liveBlock(session)).toBeUndefined();
	});
});

describe('Session live block processes', () => {
	const open = (outcome: string) => {
		const activations = [
			{ id: 'act-9', seat: 'engineer', purpose: 'respond', attempt: 1, outcome: { kind: outcome } },
		];
		return view('characterization', {
			exchange: { from: 4, status: 'open', person: 'priya', at: AT, activations },
			exchanges: [{ from: 4, status: 'open', person: 'priya', at: AT, activations }],
		});
	};
	const bash = (handle: string, extra: Partial<ProcessView> = {}): ProcessView => ({
		handle,
		kind: 'bash',
		agent: 'engineer',
		room: 'characterization',
		command: 'python3 scan.py',
		state: 'running',
		output: `/home/engineer/.processes/${handle}/out`,
		timeout: 600,
		grace: 10,
		port: 20001,
		startedAt: new Date().toISOString(),
		...extra,
	});
	const liveBlock = (session: Session) =>
		session.blocks.find((candidate) => candidate.type === 'live');

	it('shows the newest output line of a process of the running seat, and stops with the activation', async () => {
		const { host, session } = await started();
		host.processTable = [
			bash('bash-1', { name: 'scan' }),
			bash('bash-2', { room: 'budget' }),
			bash('bash-3', { agent: 'researcher' }),
		];
		host.table.set('characterization', open('running'));
		await session.refresh();
		await vi.waitFor(() =>
			expect(liveBlock(session)).toMatchObject({
				activations: [{ processes: [{ name: 'scan', line: 'output of bash-1' }] }],
			}),
		);
		expect(host.reads).toEqual(['bash-1']);

		host.table.set('characterization', open('released'));
		await session.refresh();
		expect(liveBlock(session)).toMatchObject({ activations: [{ state: 'done' }] });
		const reads = host.reads.length;
		await new Promise((resolve) => setTimeout(resolve, 1_100));
		expect(host.reads).toHaveLength(reads);
		await session.leave();
	}, 10_000);

	it('drops the lines when the person opens another room', async () => {
		const { host, session } = await started();
		host.processTable = [bash('bash-1')];
		host.table.set('characterization', open('running'));
		await session.refresh();
		await vi.waitFor(() => expect(liveBlock(session)).toBeDefined());
		await session.switchRoom('budget');
		expect(liveBlock(session)).toBeUndefined();
		await session.leave();
	});
});

describe('Session scheduled says', () => {
	it('notes each say that waits to return, with its seat and its time', async () => {
		const { host, session } = await started();
		const say = { seq: 5, seat: 'design', due: 'soon', text: 'Check the build.' };
		host.table.set('characterization', view('characterization', { scheduled: [say] }));
		await session.refresh();
		expect(session.blocks).toContainEqual({
			type: 'note',
			text: 'design comes back at soon: Check the build. (/dismiss 5)',
		});
		expect(session.suggestions('/dismiss ').map((row) => row.insert)).toEqual(['/dismiss 5']);
		host.table.set('characterization', view('characterization'));
		await session.refresh();
		expect(blockTypes(session)).not.toContain('note');
	});

	it('dismisses a say by the handle that the note shows, and refuses any other', async () => {
		const { host, session } = await started();
		const say = { seq: 5, seat: 'design', due: 'soon', text: 'Check the build.' };
		host.table.set('characterization', view('characterization', { scheduled: [say] }));
		await session.refresh();
		for (const typed of ['/dismiss 6', '/dismiss']) {
			await session.submit(typed);
			expect(session.notice).toMatch(/^Use \/dismiss <n>/);
		}
		await session.submit('/dismiss 5');
		expect(session.notice).toBe('Dismissed say 5. design does not come back to it.');
		host.dismissed = false;
		await session.submit('/dismiss 5');
		expect(session.notice).toBe('Say 5 no longer waits.');
		expect(host.calls.filter((call) => call.startsWith('dismiss'))).toEqual([
			'dismiss:characterization:5',
			'dismiss:characterization:5',
		]);
		host.dismiss = async () => {
			throw new Error('Resume this room first.');
		};
		await session.submit('/dismiss 5');
		expect(session.error).toBe('Resume this room first.');
		host.table.set(
			'characterization',
			view('characterization', { scheduled: [say], status: 'stopped' }),
		);
		await session.refresh();
		await session.submit('/dismiss 5');
		expect(session.notice).toBe('characterization is not running. Use /resume first.');
	});
});

describe('Session awaiting', () => {
	const awaiting = closedExchange(4, { outcome: { kind: 'awaiting', person: 'priya' } });

	it('shows an awaiting exchange to the person it waits on, and to nobody else', async () => {
		const { host, session } = await started();
		host.table.set('characterization', view('characterization', { exchanges: [awaiting] }));
		await session.refresh();
		expect(session.attention).toEqual(['The exchange from message 4 waits for your reply.']);
		expect(blockTypes(session)).toContain('note');
		await session.submit('/user noor');
		expect(session.attention).toEqual([]);
	});
});

describe('Session /ps', () => {
	const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, seconds)).toISOString();
	const process = (handle: string, extra: Partial<ProcessView> = {}): ProcessView => ({
		handle,
		kind: 'bash',
		agent: 'design',
		command: 'npm test',
		state: 'running',
		output: `/home/design/.processes/${handle}/out`,
		timeout: 600,
		grace: 10,
		port: 20001,
		startedAt: at(0),
		...extra,
	});

	it('opens on the processes, reads the chosen output, cancels on the second x, and stops reading on close', async () => {
		const { host, session } = await started();
		// The session holds one watch for the count on the status row.
		const held = host.processWatchers.size;
		host.processTable = [
			process('bash-000000000001', { name: 'soak' }),
			process('bash-000000000002', { state: 'exited', exitCode: 0, endedAt: at(3) }),
		];
		expect(await session.submit('/ps')).toEqual({ type: 'processes' });
		const panel = new ProcessBrowser(host, () => {});
		await panel.show();
		expect(panel.open).toBe(true);
		expect(host.processWatchers.size).toBe(held + 1);
		await vi.waitFor(() => expect(panel.output?.handle).toBe('bash-000000000001'));
		panel.move(1);
		await vi.waitFor(() => expect(panel.output?.text).toBe('output of bash-000000000002\n'));
		await panel.cancel();
		expect(panel.message).toBe('bash-000000000002 is not running.');

		panel.move(-1);
		await panel.cancel();
		expect(panel.message).toBe('Press x again to cancel soak (bash-000000000001).');
		expect(host.calls).not.toContain('cancel:bash-000000000001');
		await panel.cancel();
		expect(host.calls).toContain('cancel:bash-000000000001');
		expect(panel.message).toBe('soak (bash-000000000001) is cancelled.');
		expect(panel.selected?.state).toBe('cancelled');

		// A start or an end reads the list again, and keeps the chosen process.
		host.processTable = [process('bash-000000000003'), ...host.processTable];
		for (const changed of host.processWatchers) changed();
		await vi.waitFor(() => expect(panel.processes).toHaveLength(3));
		expect(panel.selected?.handle).toBe('bash-000000000001');

		panel.hide();
		expect(host.processWatchers.size).toBe(held);
		host.processTable = [];
		await panel.refresh();
		expect(panel.processes).toHaveLength(3);
	});

	it.each([
		[{}, 'running 1m 5s'],
		[{ state: 'exited', exitCode: 2, endedAt: at(3) }, 'exit 2 after 3s'],
		[{ state: 'timed_out', endedAt: at(59) }, 'timed out after 59s'],
		[{ state: 'cancelled', endedAt: at(20) }, 'cancelled after 20s'],
		[{ state: 'cancelled' }, 'cancelled'],
		[{ state: 'exited', exitCode: 0 }, 'exit 0'],
		[{ state: 'failed', error: 'The backend closed.' }, 'failed: The backend closed.'],
		[{ startedAt: new Date(Date.UTC(2026, 0, 1, 10, 55)).toISOString() }, 'running 1h 6m'],
	] as const)('states %o as %s', (extra, text) => {
		expect(stateText(process('bash-000000000001', extra), Date.parse(at(65)))).toBe(text);
	});

	it('keeps a move made while a list read runs, and drops a read that lands after a close', async () => {
		const { host } = await started();
		host.processTable = [process('bash-000000000001'), process('bash-000000000002')];
		const panel = new ProcessBrowser(host, () => {});
		await panel.show();
		let open = () => {};
		host.processGate = new Promise<void>((resolve) => {
			open = resolve;
		});
		const reading = panel.refresh();
		panel.move(1);
		open();
		await reading;
		expect(panel.selected?.handle).toBe('bash-000000000002');
		await vi.waitFor(() => expect(panel.output?.handle).toBe('bash-000000000002'));

		host.processGate = new Promise<void>((resolve) => {
			open = resolve;
		});
		const late = panel.refresh();
		panel.hide();
		host.processTable = [];
		open();
		await late;
		expect(panel.processes).toHaveLength(2);
		host.processGate = undefined;
	});

	it('shows a failed list read, a cancel that does not end in time, and a cancel in progress', async () => {
		const { host } = await started();
		host.processTable = [process('bash-000000000001')];
		host.processFailure = 'The workspace is closed.';
		const panel = new ProcessBrowser(host, () => {});
		await panel.show();
		expect(panel.problem).toBe('The workspace is closed.');
		host.processFailure = undefined;
		await panel.refresh();
		expect(panel.problem).toBeUndefined();

		host.cancelState = 'running';
		await panel.cancel();
		const cancelling = panel.cancel();
		// A third press while the cancel runs takes no second cancel.
		void panel.cancel();
		expect(panel.message).toBe('Cancelling bash-000000000001.');
		await cancelling;
		expect(panel.message).toBe('bash-000000000001 did not end within 10 seconds.');
		expect(host.calls.filter((call) => call.startsWith('cancel:'))).toHaveLength(1);
		panel.dispose();
	});

	it.each([
		['short', 'short', false],
		['one\ntwo\nthree\n', 'three\n', true],
		['aaaaaaaaaa\n', 'aaaaaa\n', true],
		['aaaaaaaaaaa', 'aaaaaaa', true],
	])('keeps the end of %j as %j', (text, end, truncated) => {
		expect(lastPart(text, 7)).toEqual({ text: end, truncated });
	});
});

describe('Session commands', () => {
	it('runs every command of the list through a handler', async () => {
		for (const { name } of COMMANDS) {
			const { session } = await started();
			await session.submit(`/${name}`);
			expect(session.error, name).toBeUndefined();
		}
	});

	it('gives the intent of the two commands that leave the room', async () => {
		const { session } = await started();
		expect(await session.submit('/ps')).toEqual({ type: 'processes' });
		expect(await session.submit('/quit')).toEqual({ type: 'quit' });
		expect(await session.submit('/files')).toEqual({ type: 'files' });
	});

	it('shows every message of a closed exchange in the open, with its activation line, and has no /expand', async () => {
		const { host, session } = await started();
		const said = (seq: number, from: string) => ({
			seq,
			kind: 'said',
			from,
			text: `m${seq}`,
			at: AT,
		});
		host.table.set(
			'characterization',
			view('characterization', {
				participants: [{ name: 'priya', kind: 'person' }],
				messages: [said(1, 'priya'), said(2, 'design'), said(3, 'researcher'), said(4, 'priya')],
				exchanges: [closedExchange(1, { through: 3 })],
			}),
		);
		await session.refresh();
		expect(session.blocks.map((block) => block.type)).toEqual([
			'message',
			'message',
			'message',
			'stays',
			'message',
		]);
		await session.submit('/expand');
		expect(session.notice).toMatch(/Unknown command \/expand/);
	});

	it('shows the help text with /help', async () => {
		const { session } = await started();
		await session.submit('/help');
		expect(session.notice).toBe(HELP);
	});
});

describe('Session activation lines', () => {
	const said = (seq: number, from: string, activation?: string) => ({
		seq,
		kind: 'said',
		from,
		text: `${from} ${seq}`,
		at: AT,
		...(activation ? { activation } : {}),
	});
	const closedRoom = (exchanges: unknown[], messages: unknown[]) =>
		view('characterization', {
			participants: [{ name: 'priya', kind: 'person' }],
			messages,
			exchanges,
		});
	const lines = (session: Session) =>
		session.blocks.flatMap((block) => (block.type === 'stays' ? block.items : []));
	const messages = [
		said(4, 'priya'),
		said(5, 'design', 'act-4'),
		said(8, 'priya'),
		said(9, 'design', 'act-8'),
	];
	const both = [closedExchange(4), closedExchange(8)];

	it('keeps the title of an activation that it read before its exchange closed', async () => {
		const { host, session } = await started();
		const open = [
			{
				...closedExchange(4, { through: 5 }).activations[0],
				outcome: { kind: 'released' },
			},
		];
		const running = { from: 4, status: 'open', person: 'priya', at: AT, activations: open };
		host.table.set(
			'characterization',
			view('characterization', {
				participants: [{ name: 'priya', kind: 'person' }],
				messages: messages.slice(0, 2),
				exchange: running,
				exchanges: [running],
			}),
		);
		host.traces.set('act-4', trace('act-4', true));
		await session.refresh();
		expect([...session.reads.keys()]).toEqual(['act-4']);
		host.table.set('characterization', closedRoom([closedExchange(4)], messages.slice(0, 2)));
		host.traces.delete('act-4');
		await session.refresh();
		expect(session.reads.size).toBe(0);
		expect(lines(session)).toEqual([
			{ id: 'act-4', state: 'done', title: 'design · respond · 1 call' },
		]);
		const reads = host.calls.filter((call) => call === 'activation:act-4').length;
		await session.refresh();
		expect(host.calls.filter((call) => call === 'activation:act-4')).toHaveLength(reads);
	});

	it('reads a closed activation once more when its last read held no end step, then drops the steps', async () => {
		const { host, session } = await started();
		const running = {
			from: 4,
			status: 'open',
			person: 'priya',
			at: AT,
			activations: [{ ...closedExchange(4).activations[0], outcome: { kind: 'running' } }],
		};
		host.table.set(
			'characterization',
			view('characterization', {
				messages: messages.slice(0, 1),
				exchange: running,
				exchanges: [running],
			}),
		);
		host.traces.set('act-4', trace('act-4', false));
		await session.refresh();
		host.traces.set('act-4', trace('act-4', true));
		host.table.set('characterization', closedRoom([closedExchange(4)], messages.slice(0, 2)));
		await session.refresh();
		await session.refresh();
		expect(session.reads.size).toBe(0);
		expect(lines(session)[0]?.title).toBe('design · respond · 1 call');
		expect(host.calls.filter((call) => call === 'activation:act-4')).toHaveLength(2);
	});

	it('shows the title of an activation that it never read, without counts', async () => {
		const { host, session } = await started();
		host.table.set('characterization', closedRoom(both, messages));
		await session.refresh();
		expect(host.calls.filter((call) => call.startsWith('activation:'))).toEqual([]);
		expect(lines(session).map((line) => line.title)).toEqual([
			'design · respond',
			'design · respond',
		]);
		expect(session.pickIds).toEqual(['stay:act-4', 'stay:act-8']);
	});

	it('expands a line to the steps that the host holds, and folds it again', async () => {
		const { host, session } = await started();
		host.table.set('characterization', closedRoom(both, messages));
		host.traces.set('act-4', trace('act-4', true));
		await session.refresh();
		expect(await session.openPick('stay:act-4')).toBeUndefined();
		expect(host.calls).toContain('activation:act-4');
		expect(lines(session)[0]).toMatchObject({
			id: 'act-4',
			open: { passes: [{ lines: [{ kind: 'tool', text: '→ read /a' }, { kind: 'end' }] }] },
		});
		expect(lines(session)[1]).not.toHaveProperty('open');
		await session.openPick('stay:act-4');
		expect(lines(session)[0]).not.toHaveProperty('open');
	});

	it('keeps one line expanded: the next one that opens folds the first', async () => {
		const { host, session } = await started();
		host.table.set('characterization', closedRoom(both, messages));
		host.traces.set('act-4', trace('act-4', true));
		host.traces.set('act-8', trace('act-8', true));
		await session.refresh();
		await session.openPick('stay:act-4');
		await session.openPick('stay:act-8');
		expect(lines(session).map((line) => 'open' in line)).toEqual([false, true]);
	});

	it('shows an empty step list when the step log holds nothing, and when the read fails', async () => {
		const { host, session } = await started();
		host.table.set('characterization', closedRoom(both, messages));
		await session.refresh();
		await session.openPick('stay:act-4');
		expect(lines(session)[0]).toMatchObject({ open: { passes: [] } });
		await session.openPick('stay:act-4');
		vi.spyOn(host, 'activation').mockRejectedValueOnce(new Error('gone'));
		await session.openPick('stay:act-8');
		expect(lines(session)[1]).toMatchObject({ open: { passes: [] } });
	});

	it('folds the open line when the person opens another room', async () => {
		const { host, session } = await started();
		host.table.set('characterization', closedRoom(both, messages));
		await session.refresh();
		await session.openPick('stay:act-4');
		await session.switchRoom('budget');
		expect(session.unfolded).toBeUndefined();
		expect(lines(session)).toEqual([]);
	});
});

describe('Session breakout rooms', () => {
	const breakout = (state: 'running' | 'archived', extra: Record<string, unknown> = {}) => ({
		breakout: { parent: 'characterization', opener: 'engineer', state },
		...extra,
	});

	it('reads the room list again when the watch on the room list reports a change', async () => {
		const { host, session } = await started();
		expect(session.background).toEqual({ running: 0, working: false });
		host.table.set('tuners', view('tuners', breakout('running')));
		host.notifyRooms();
		await vi.waitFor(() => expect(session.background).toEqual({ running: 1, working: false }));
		host.table.set('tuners', view('tuners', breakout('running', { exchange: { id: 'x1' } })));
		host.notifyRooms();
		await vi.waitFor(() => expect(session.background).toEqual({ running: 1, working: true }));
		host.table.set('tuners', view('tuners', breakout('archived', { status: 'stopped' })));
		host.notifyRooms();
		await vi.waitFor(() => expect(session.background).toEqual({ running: 0, working: false }));
	});

	it('reads no room list on a change of the open room, and stops the watch on leave', async () => {
		const { host, session } = await started();
		let reads = 0;
		host.rooms = async () => {
			reads += 1;
			return [...host.table.values()];
		};
		host.notify('characterization');
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(reads).toBe(0);
		expect(host.roomWatchers.size).toBe(1);
		await session.leave();
		expect(host.roomWatchers.size).toBe(0);
	});

	it('lists a breakout room under its parent in the palette', async () => {
		const { host, session } = await started();
		host.table.set('tuners', view('tuners', breakout('running')));
		host.notifyRooms();
		await vi.waitFor(() =>
			expect(session.suggestions('/room ').map((row) => row.label)).toEqual([
				'characterization',
				'tuners',
				'budget',
			]),
		);
		expect(session.suggestions('/room tun')[0]?.detail).toBe('running · tuners goal');
	});

	it('picks the newest running breakout room, and from it the parent, when the list opens', async () => {
		const { host, session } = await started();
		host.table.set('characterization-tuners', view('characterization-tuners', breakout('running')));
		host.notifyRooms();
		const pickedRow = () => session.suggestions('/room ').find((row) => row.picked)?.insert;
		await vi.waitFor(() => expect(pickedRow()).toBe('/room characterization-tuners'));
		expect(session.parent).toBeUndefined();
		await session.switchRoom('characterization-tuners');
		expect(session.parent).toBe('characterization');
		expect(pickedRow()).toBe('/room characterization');
		expect(session.suggestions('/room tun').map((row) => row.label)).toEqual(['tuners']);
	});

	it('reads the list once more, and no more, for changes that land during a read', async () => {
		const { host, session } = await started();
		let reads = 0;
		let release = () => {};
		host.rooms = async () => {
			reads += 1;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return [...host.table.values()];
		};
		for (let call = 0; call < 5; call += 1) host.notifyRooms();
		await vi.waitFor(() => expect(reads).toBe(1));
		release();
		await vi.waitFor(() => expect(reads).toBe(2));
		release();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(reads).toBe(2);
		expect(session.offline).toBeUndefined();
	});

	it('keeps the last room list after a failed list read', async () => {
		const { host, session } = await started();
		let calls = 0;
		host.rooms = async () => {
			calls += 1;
			throw new Error('journal busy');
		};
		host.notifyRooms();
		await vi.waitFor(() => expect(calls).toBe(1));
		expect(session.rooms.map((room) => room.name)).toEqual(['characterization', 'budget']);
		expect(session.room).toBe('characterization');
	});

	const seated = {
		kind: 'agent',
		name: 'engineer',
		identity: 'W',
		status: 'idle',
		attention: 'broadcast',
	};

	it('offers and accepts the seated agents of a breakout room, and no other specialist', async () => {
		const { host, session } = await started();
		host.table.set('tuners', view('tuners', breakout('running', { participants: [seated] })));
		await session.refreshRooms();
		await session.switchRoom('tuners');
		expect(session.suggestions('@').map((row) => [row.label, row.detail])).toEqual([
			['@engineer', 'broadcast'],
		]);
		await session.submit('@engineer add the TEA5767');
		expect(host.sentTo).toEqual(['engineer']);
		await session.submit('@researcher hello');
		expect(session.error).toContain('No seat or specialist named @researcher');
		expect(host.sentTo).toEqual(['engineer']);
	});

	it('opens an archived breakout room to read, joins nothing, and says it is archived on a send', async () => {
		const { host, session } = await started();
		host.table.set('old', view('old', breakout('archived', { status: 'stopped' })));
		await session.refreshRooms();
		host.calls.length = 0;
		await session.switchRoom('old');
		expect(host.calls).toEqual(['leave:characterization:priya']);
		expect(session.error).toBeUndefined();
		expect(session.view?.name).toBe('old');
		await session.submit('Hello?');
		expect(session.error).toBe('old is archived. It takes no message.');
		expect(host.calls).toEqual(['leave:characterization:priya']);
		await session.switchRoom('budget');
		expect(host.calls).toEqual(['leave:characterization:priya', 'join:budget:priya']);
	});
});

describe('Session steering', () => {
	const said = (seq: number, text: string) => ({
		kind: 'said',
		seq,
		from: 'priya',
		text,
		at: 'now',
	});
	const trace = (consumed: boolean) =>
		({
			activation: 'a1',
			passes: [
				{
					pass: 1,
					input: 'view',
					through: 2,
					steps: [
						{ type: 'pass', pass: 1, input: 'view', through: 2 },
						{ type: 'steer', seq: 3, consumed },
					],
				},
			],
		}) as never;

	it('tells the terminal to redraw when a step marks a waiting message as read', async () => {
		const { host, session, changes } = await started();
		const exchange = {
			status: 'open',
			from: 2,
			at: 'now',
			activations: [
				{
					id: 'a1',
					seat: 'engineer',
					attempt: 1,
					purpose: 'respond',
					outcome: { kind: 'running' },
				},
			],
		};
		host.table.set(
			'characterization',
			view('characterization', {
				messages: [said(2, 'Start'), said(3, 'check the rail')],
				exchange,
				exchanges: [exchange],
			}),
		);
		host.traces.set('a1', trace(false));
		host.notify('characterization');
		await vi.waitFor(() => expect(session.steering).toHaveLength(1));
		const before = changes();
		host.traces.set('a1', trace(true));
		host.notify('characterization');
		await vi.waitFor(() => expect(session.steering).toEqual([]));
		expect(changes()).toBeGreaterThan(before);
	});
});

describe('Session, when the redraw throws at the start of a send', () => {
	it('ends the send state and reports the error', async () => {
		const host = new FakeHost();
		let broken = false;
		const session = new Session(host, host.people[0], () => {
			if (!broken) return;
			broken = false;
			throw new Error('The redraw failed.');
		});
		await session.start();
		broken = true;
		await session.submit('Hello.');
		expect(session.sending).toBe(false);
		expect(session.error).toBe('The redraw failed.');
	});
});
