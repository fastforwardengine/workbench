/** The actions of the camera widgets: the press path of the pad, without drawing. */
import { AmbionError } from '@ambionframework/ambion';
import type { CanvasWidget, WidgetAct, WidgetActResult } from '@ambionframework/canvas';
import { describe, expect, it, vi } from 'vitest';
import type { ActionWidget } from '../src/host/host.ts';
import { ActionPad } from '../src/terminal/state/action-pad.ts';

const widget = (extra: Partial<ActionWidget> = {}): ActionWidget => ({
	room: 'build',
	name: 'bench',
	revision: 'r1',
	rev: 1,
	actions: [{ id: 'look', label: 'Look now' }],
	...extra,
});

/** A pad over a host that records each act. `send` decides each result. */
function padOf(
	send: (person: string, act: WidgetAct) => Promise<WidgetActResult> = async () => ({
		kind: 'sent',
		seq: 5,
	}),
) {
	const state = { person: 'priya' as string | undefined, stopped: false };
	const sent: { person: string; act: WidgetAct }[] = [];
	const changed = vi.fn();
	const pad = new ActionPad({
		send: (person, act) => {
			sent.push({ person, act });
			return send(person, act);
		},
		person: () => state.person,
		stopped: () => state.stopped,
		changed,
	});
	pad.sync([widget()]);
	return { pad, state, sent, changed };
}

const note = (pad: ActionPad, name = 'bench') =>
	pad
		.rows(name)
		.filter((row) => row.type === 'note')
		.at(-1);

describe('the rows of an action', () => {
	it('draws one button for the look action, focused only while the pad has the keys', () => {
		const { pad } = padOf();
		expect(pad.rows('bench')).toEqual([
			{ type: 'button', label: 'Look now', focused: false, done: false },
		]);
		expect(pad.enter()).toBe(true);
		expect(pad.rows('bench')[0]).toMatchObject({ focused: true });
	});

	it('has no rows for a widget with no action, and the pad does not enter', () => {
		const { pad } = padOf();
		pad.sync([widget({ actions: [] })]);
		expect(pad.rows('bench')).toEqual([]);
		expect(pad.enter()).toBe(false);
	});

	it('blocks the button for another person, and while the room is stopped', () => {
		const { pad, state } = padOf();
		pad.sync([widget({ for: 'sam' })]);
		expect(pad.rows('bench')).toContainEqual(
			expect.objectContaining({ type: 'button', blocked: 'for sam only' }),
		);
		expect(pad.rows('bench')[0]).toMatchObject({ type: 'note', text: 'for sam' });
		state.person = 'sam';
		expect(pad.rows('bench').find((row) => row.type === 'button')).not.toHaveProperty('blocked');
		state.stopped = true;
		expect(pad.rows('bench').find((row) => row.type === 'button')).toMatchObject({
			blocked: 'room stopped',
		});
	});

	it('shows a once action as done when the revision has an answer', () => {
		const { pad } = padOf();
		pad.sync([
			widget({
				actions: [{ id: 'look', label: 'Look now', once: true }],
				answered: { seq: 9, by: 'priya' },
			}),
		]);
		expect(pad.rows('bench')).toContainEqual({
			type: 'note',
			text: 'answered by priya in #9',
			tone: 'info',
		});
		expect(pad.rows('bench')).toContainEqual(
			expect.objectContaining({ type: 'button', done: true }),
		);
	});
});

describe('the press', () => {
	it('sends one act as the person, with a press token, and notes the seq', async () => {
		const { pad, sent } = padOf();
		pad.enter();
		await pad.press();
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			person: 'priya',
			act: { room: 'build', widget: 'bench', revision: 'r1', action: 'look' },
		});
		expect(sent[0]?.act.press).toMatch(/[0-9a-f-]{36}/);
		expect(note(pad)).toMatchObject({ text: 'Sent as #5.', tone: 'info' });
	});

	it('sends a new press token for each new press', async () => {
		const { pad, sent } = padOf();
		pad.enter();
		await pad.press();
		await pad.press();
		expect(sent[1]?.act.press).not.toBe(sent[0]?.act.press);
	});

	it('sends the act again as it was after a failed call, and a result drops it', async () => {
		let calls = 0;
		const { pad, sent } = padOf(async () => {
			if (++calls === 1) throw new Error('The host lost the answer.');
			return { kind: 'sent', seq: 6 };
		});
		pad.enter();
		await pad.press();
		expect(note(pad)).toMatchObject({
			text: 'The host lost the answer. Press again to retry.',
			tone: 'error',
		});
		await pad.press();
		expect(sent[1]?.act).toBe(sent[0]?.act);
		await pad.press();
		expect(sent[2]?.act.press).not.toBe(sent[0]?.act.press);
	});

	it('does not retry the act for another person', async () => {
		let calls = 0;
		const { pad, state, sent } = padOf(async () => {
			if (++calls === 1) throw new Error('Down.');
			return { kind: 'sent', seq: 6 };
		});
		pad.enter();
		await pad.press();
		state.person = 'sam';
		pad.sync([widget()]);
		await pad.press();
		expect(sent[1]?.person).toBe('sam');
		expect(sent[1]?.act.press).not.toBe(sent[0]?.act.press);
	});

	it('shows the reason of a refusal alone, and sends a new act after it', async () => {
		let calls = 0;
		const { pad, sent } = padOf(async () => {
			if (++calls === 1) throw new AmbionError('refused', 'The room is not running.');
			return { kind: 'sent', seq: 6 };
		});
		pad.enter();
		await pad.press();
		expect(note(pad)).toMatchObject({ text: 'The room is not running.', tone: 'error' });
		await pad.press();
		expect(sent[1]?.act.press).not.toBe(sent[0]?.act.press);
	});

	it('draws the newer revision after a stale result, and presses that revision next', async () => {
		const newer = {
			room: 'build',
			name: 'bench',
			revision: 'r2',
			rev: 2,
			state: 'shown',
			kind: 'frame',
			author: 'engineer',
			actions: [{ id: 'look', label: 'Look again' }],
		} as CanvasWidget;
		let calls = 0;
		const { pad, sent } = padOf(async () =>
			++calls === 1 ? { kind: 'stale', widget: newer } : { kind: 'sent', seq: 8 },
		);
		pad.enter();
		await pad.press();
		expect(pad.rows('bench')).toContainEqual(expect.objectContaining({ label: 'Look again' }));
		expect(note(pad)).toMatchObject({ text: 'This widget changed. Press again.' });
		await pad.press();
		expect(sent[1]?.act.revision).toBe('r2');
		// The host then lists revision 2, and the pad follows it.
		pad.sync([widget({ revision: 'r2', rev: 2 })]);
		expect(pad.rows('bench').some((row) => row.type === 'button')).toBe(true);
	});

	it('notes an answer that already landed', async () => {
		const { pad } = padOf(async () => ({ kind: 'answered', seq: 4 }));
		pad.enter();
		await pad.press();
		expect(note(pad)).toMatchObject({ text: 'Already answered in #4.' });
	});

	it('sends nothing for another person, a stopped room, or an answered once action', async () => {
		const { pad, state, sent } = padOf();
		pad.enter();
		pad.sync([widget({ for: 'sam' })]);
		await pad.press();
		expect(note(pad, 'bench')).toMatchObject({ text: 'Not available: for sam only.' });
		pad.sync([widget()]);
		state.stopped = true;
		await pad.press();
		expect(note(pad)).toMatchObject({ text: 'Not available: room stopped.' });
		state.stopped = false;
		pad.sync([
			widget({
				actions: [{ id: 'look', label: 'Look now', once: true }],
				answered: { seq: 2, by: 'sam' },
			}),
		]);
		await pad.press();
		expect(note(pad)).toMatchObject({ text: 'This was answered by sam in #2.' });
		expect(sent).toHaveLength(0);
	});

	it('asks for a person when nobody is chosen', async () => {
		const { pad, state, sent } = padOf();
		state.person = undefined;
		pad.enter();
		await pad.press();
		expect(sent).toHaveLength(0);
		expect(note(pad)).toMatchObject({ tone: 'error' });
	});
});

describe('the keys of the pad', () => {
	it('moves the focus with Up and Down, presses with Enter, and leaves with Escape', async () => {
		const { pad, sent, changed } = padOf();
		pad.sync([
			widget(),
			widget({ name: 'shelf', revision: 's1', actions: [{ id: 'look', label: 'Look now' }] }),
		]);
		pad.enter();
		pad.key({ name: 'down' });
		pad.key({ name: 'return' });
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.act.widget).toBe('shelf');
		pad.key({ name: 'up' });
		expect(pad.rows('bench')[0]).toMatchObject({ focused: true });
		expect(pad.key({ name: 'escape' })).toBe('leave');
		expect(changed).toHaveBeenCalled();
	});

	it('leaves a key with Ctrl to the terminal', () => {
		const { pad } = padOf();
		pad.enter();
		expect(pad.key({ name: 'escape', ctrl: true })).toBeUndefined();
	});

	it('leaves by itself when the widgets lose their actions', () => {
		const { pad } = padOf();
		pad.enter();
		pad.sync([widget({ actions: [] })]);
		expect(pad.active).toBe(false);
	});
});
