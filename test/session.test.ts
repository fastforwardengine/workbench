import { describe, expect, it, vi } from 'vitest';
import type { ActivationSteps, ProcessView } from '../src/host/host.ts';
import { lastPart } from '../src/host/processes.ts';
import { ProcessBrowser, stateText } from '../src/terminal/process-browser.ts';
import type { Session } from '../src/terminal/session.ts';
import { started, view } from './fake-host.ts';

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
			view('characterization', { exchange: { owner: 'priya', from: 4, at: '' } }),
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
			view('characterization', { exchange: { owner: 'priya', from: 4, at: '' } }),
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
});

const AT = '2026-01-01T00:00:00Z';
const closedExchange = (from: number, extra: Record<string, unknown> = {}) => ({
	from,
	through: from + 1,
	status: 'closed',
	owner: 'priya',
	at: AT,
	outcome: { kind: 'complete' },
	summary: { status: 'silent' },
	activations: [
		{
			id: `act-${from}`,
			seat: 'design',
			purpose: 'respond',
			attempt: 1,
			outcome: { status: 'released' },
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

	it('opens the steps of the exchange a discussion key names', async () => {
		const { host, session } = await started();
		host.table.set(
			'characterization',
			view('characterization', { exchanges: [closedExchange(4)] }),
		);
		host.traces.set('act-4', trace('act-4', true));
		await session.refresh();
		await session.showSteps('4');
		expect(session.steps?.id).toBe('act-4');
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
			seat: 'assistant',
			purpose: 'respond',
			attempt,
			outcome: { status, cause: 'permanent' },
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

describe('Session scheduled says', () => {
	it('notes each say that waits to return, with its seat, its time, and its owner', async () => {
		const { host, session } = await started();
		const say = { seq: 5, seat: 'design', owner: 'noor', due: 'soon', text: 'Check the build.' };
		host.table.set('characterization', view('characterization', { scheduled: [say] }));
		await session.refresh();
		expect(session.blocks).toContainEqual({
			type: 'note',
			text: 'design comes back at soon for noor: Check the build. (/dismiss 5)',
		});
		expect(session.suggestions('/dismiss ').map((row) => row.insert)).toEqual(['/dismiss 5']);
		host.table.set('characterization', view('characterization'));
		await session.refresh();
		expect(blockTypes(session)).not.toContain('note');
	});

	it('dismisses a say by the handle that the note shows, and refuses any other', async () => {
		const { host, session } = await started();
		const say = { seq: 5, seat: 'design', owner: 'noor', due: 'soon', text: 'Check the build.' };
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

describe('Session awaiting and approval', () => {
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

	it('shows a pending operation to the owner of the exchange only', async () => {
		const { host, session } = await started();
		host.pendingApprovals = [
			{
				id: 3,
				instrument: 'discharge-current',
				setpoint: 2500,
				unit: 'mA',
				owner: 'priya',
				at: AT,
			},
		];
		await session.refresh();
		expect(session.attention).toHaveLength(1);
		expect(session.attention[0]).toMatch(
			/Operation 3 needs your answer.*discharge-current to 2500 mA/,
		);
		await session.submit('/user noor');
		expect(session.attention).toEqual([]);
		host.pendingApprovals = [];
		await session.submit('/user priya');
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
		startedAt: at(0),
		...extra,
	});

	it('opens on the processes, reads the chosen output, cancels on the second x, and stops reading on close', async () => {
		const { host, session } = await started();
		host.processTable = [
			process('bash-000000000001', { name: 'soak' }),
			process('bash-000000000002', { state: 'exited', exitCode: 0, endedAt: at(3) }),
		];
		expect(await session.submit('/ps')).toEqual({ type: 'processes' });
		const panel = new ProcessBrowser(host, () => {});
		await panel.show();
		expect(panel.open).toBe(true);
		expect(host.processWatchers.size).toBe(1);
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
		expect(host.processWatchers.size).toBe(0);
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
