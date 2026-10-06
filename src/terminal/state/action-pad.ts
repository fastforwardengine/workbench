import { AmbionError } from '@ambionframework/ambion';
import { actionWidget } from '../../host/actions.ts';
import type { ActionWidget, Answered, WidgetAct, WidgetActResult } from '../../host/host.ts';

/** Sends one act through the host as a person, and gives the canvas result. */
type SendAct = (person: string, act: WidgetAct) => Promise<WidgetActResult>;

/** What the pad reads from the host and the session, and how it asks for a redraw. */
export interface PadOptions {
	send: SendAct;
	/** The person who presses, or undefined while nobody is chosen. */
	person: () => string | undefined;
	/** True while the room of the widgets is stopped. */
	stopped: () => boolean;
	changed: () => void;
}

/** How a note reads: dim for a state, info for an outcome, error for a refusal. */
export type Tone = 'dim' | 'info' | 'error';

/** One line of the actions of a widget. The drawing maps each row to one styled line. */
export type Row =
	| { type: 'note'; text: string; tone: Tone }
	| { type: 'button'; label: string; focused: boolean; done: boolean; blocked?: string };

/** The key as the pad reads it: a subset of the key event of the terminal. */
export interface KeyInput {
	name: string;
	ctrl?: boolean;
	meta?: boolean;
}

/** The text of a person or a widget with its control characters removed, so it draws as one line. */
const plain = (text: string): string => text.replace(/\p{Cc}/gu, ' ');

const MOVES: Record<string, number> = { up: -1, k: -1, down: 1, j: 1 };

/** What the person focuses: one action of one widget. */
interface Focus {
	name: string;
	action: string;
}

/** The act of a call that threw, with the person who sent it. A retry sends it again as it was. */
interface Failed {
	person: string;
	act: WidgetAct;
}

const answeredText = ({ seq, by }: Answered): string => `answered by ${plain(by)} in #${seq}`;

/**
 * The state of the actions of the camera widgets that the viewfinder draws: the focus, the act
 * of a failed call, and the last result of each widget. It draws nothing and reads no
 * terminal. `send` calls the host as the person, and `changed` asks for a redraw. An action
 * is one button with no form.
 */
export class ActionPad {
	/** True while the keys of the person reach the pad. */
	active = false;
	private readonly options: PadOptions;
	private source: readonly ActionWidget[] = [];
	/** The newer revision that a stale result gave, by widget name. */
	private readonly newer = new Map<string, ActionWidget>();
	private focus: Focus | undefined;
	/** The note of each revision, by revision id. */
	private readonly notes = new Map<string, Row & { type: 'note' }>();
	/** The call that threw. A result or a refusal drops it, and so does a change of person. */
	private failed: Failed | undefined;
	private sending = false;

	constructor(options: PadOptions) {
		this.options = options;
	}

	/** The widgets with actions, as the pad draws them. */
	private get widgets(): ActionWidget[] {
		return this.source
			.map((widget) => {
				const newer = this.newer.get(widget.name);
				return newer && newer.rev > widget.rev ? newer : widget;
			})
			.filter((widget) => widget.actions.length > 0);
	}

	private slots(): { widget: ActionWidget; action: ActionWidget['actions'][number] }[] {
		return this.widgets.flatMap((widget) => widget.actions.map((action) => ({ widget, action })));
	}

	private chosen() {
		return this.slots().find(
			({ widget, action }) => widget.name === this.focus?.name && action.id === this.focus.action,
		);
	}

	/** Read the widgets that the host holds. The focus and the notes follow the revisions. */
	sync(widgets: readonly ActionWidget[]): void {
		this.source = widgets;
		if (this.failed && this.failed.person !== this.options.person()) this.failed = undefined;
		for (const [name, newer] of this.newer)
			if (!widgets.some((widget) => widget.name === name && widget.rev < newer.rev))
				this.newer.delete(name);
		const revisions = new Set(this.widgets.map((widget) => widget.revision));
		for (const revision of this.notes.keys())
			if (!revisions.has(revision)) this.notes.delete(revision);
		this.keepFocus();
	}

	/** Keep the focus on an action that exists, or move it to the first one. Without one, leave. */
	private keepFocus(): void {
		if (this.chosen()) return;
		const first = this.slots()[0];
		this.focus = first && { name: first.widget.name, action: first.action.id };
		if (!this.focus) this.active = false;
	}

	/** Start taking keys. It returns false when no widget has an action. */
	enter(): boolean {
		if (this.slots().length === 0) return false;
		this.active = true;
		return true;
	}

	leave(): void {
		this.active = false;
	}

	private note(widget: ActionWidget, text: string, tone: Tone): void {
		this.notes.set(widget.revision, { type: 'note', text, tone });
	}

	/** Why the person cannot press the actions of a widget now, or undefined. */
	private blocked(widget: ActionWidget): string | undefined {
		if (this.options.stopped()) return 'room stopped';
		const person = this.options.person();
		return widget.for !== undefined && person !== undefined && widget.for !== person
			? `for ${plain(widget.for)} only`
			: undefined;
	}

	private buttonRow(widget: ActionWidget, action: ActionWidget['actions'][number]): Row {
		const done = action.once === true && widget.answered !== undefined;
		const blocked = done ? undefined : this.blocked(widget);
		return {
			type: 'button',
			label: plain(action.label),
			focused: this.active && this.focus?.name === widget.name && this.focus.action === action.id,
			done,
			...(blocked === undefined ? {} : { blocked }),
		};
	}

	/** The rows of one widget: its `for`, its answer, each action as a button, and the last result. */
	rows(name: string): Row[] {
		const widget = this.widgets.find((one) => one.name === name);
		if (!widget) return [];
		const rows: Row[] = [];
		if (widget.for !== undefined)
			rows.push({ type: 'note', text: `for ${plain(widget.for)}`, tone: 'dim' });
		if (widget.answered)
			rows.push({ type: 'note', text: answeredText(widget.answered), tone: 'info' });
		for (const action of widget.actions) rows.push(this.buttonRow(widget, action));
		const note = this.notes.get(widget.revision);
		return note ? [...rows, note] : rows;
	}

	/** Route one key. It returns `leave` when the person leaves the pad. */
	key(key: KeyInput): 'leave' | undefined {
		if (key.ctrl || key.meta) return undefined;
		let result: 'leave' | undefined;
		const step = MOVES[key.name];
		if (step) this.move(step);
		else if (key.name === 'return' || key.name === 'space') void this.press();
		else if (key.name === 'escape' || key.name === 'q') result = 'leave';
		this.options.changed();
		return result;
	}

	private move(step: number): void {
		const slots = this.slots();
		const at = slots.findIndex(
			({ widget, action }) => widget.name === this.focus?.name && action.id === this.focus.action,
		);
		const next = slots[Math.max(0, Math.min(slots.length - 1, at + step))];
		if (next) this.focus = { name: next.widget.name, action: next.action.id };
	}

	/** Press the chosen action. */
	async press(): Promise<void> {
		const slot = this.chosen();
		if (!slot || this.sending) return;
		const { widget, action } = slot;
		const blocked = this.blocked(widget);
		if (action.once === true && widget.answered)
			this.note(widget, `This was ${answeredText(widget.answered)}.`, 'info');
		else if (blocked !== undefined) this.note(widget, `Not available: ${blocked}.`, 'info');
		else await this.call(widget, action.id);
	}

	/**
	 * The act of a call. The act of a failed call comes again as it was, for the same person,
	 * room, widget, and action. Any other call makes a new act with a new press token.
	 */
	private actOf(person: string, widget: ActionWidget, action: string): WidgetAct {
		const before = this.failed;
		if (
			before?.person === person &&
			before.act.room === widget.room &&
			before.act.widget === widget.name &&
			before.act.action === action
		)
			return before.act;
		return {
			room: widget.room,
			widget: widget.name,
			revision: widget.revision,
			action,
			press: crypto.randomUUID(),
		};
	}

	/**
	 * Send one press. The act is saved before the call and stays until the call gives a result,
	 * so a retry after a failure sends that act again, as the same person. A refusal never
	 * lands, so it drops the act and shows its reason alone.
	 */
	private async call(widget: ActionWidget, action: string): Promise<void> {
		const person = this.options.person();
		if (person === undefined) {
			this.note(widget, 'Pick a person first: /user <name>.', 'error');
			return;
		}
		this.sending = true;
		const act = this.actOf(person, widget, action);
		this.failed = { person, act };
		this.note(widget, 'Sending.', 'dim');
		this.options.changed();
		try {
			const result = await this.options.send(person, act);
			this.failed = undefined;
			this.settle(widget, result);
		} catch (error) {
			this.fail(widget, error);
		} finally {
			this.sending = false;
			this.options.changed();
		}
	}

	private fail(widget: ActionWidget, error: unknown): void {
		const reason = plain(error instanceof Error ? error.message : String(error));
		const refused = error instanceof AmbionError && error.code === 'refused';
		if (refused) this.failed = undefined;
		this.note(widget, refused ? reason : `${reason} Press again to retry.`, 'error');
	}

	private settle(widget: ActionWidget, result: WidgetActResult): void {
		if (result.kind === 'sent') this.note(widget, `Sent as #${result.seq}.`, 'info');
		else if (result.kind === 'answered')
			this.note(widget, `Already answered in #${result.seq}.`, 'info');
		else {
			const newer = actionWidget(result.widget);
			this.newer.set(widget.name, newer);
			this.note(newer, 'This widget changed. Press again.', 'info');
		}
	}
}
