import type { CanvasWidget, WidgetAction } from '@ambionframework/canvas';
import { FRAME_KIND } from './viewfinder.ts';

/** The act that answers a revision: its seq and the person. */
export interface Answered {
	seq: number;
	by: string;
}

/** One camera widget as the terminal needs it to draw and press its actions. */
export interface ActionWidget {
	room: string;
	name: string;
	revision: string;
	/** Counts the revisions of this name. A stale result carries a newer one. */
	rev: number;
	/** The actions that a single press sends. An action with a form has no button. */
	actions: readonly WidgetAction[];
	/** The one person who may act. */
	for?: string;
	answered?: Answered;
}

/** The actions of a widget that the terminal draws: a shown widget, and an action with no form. */
export function actionWidget(widget: CanvasWidget, answered?: Answered): ActionWidget {
	return {
		room: widget.room,
		name: widget.name,
		revision: widget.revision,
		rev: widget.rev,
		actions:
			widget.state === 'shown'
				? widget.actions.filter((action) => (action.fields ?? []).length === 0)
				: [],
		...(widget.for === undefined ? {} : { for: widget.for }),
		...(answered === undefined ? {} : { answered }),
	};
}

/** The shown `frame` widgets of a room that hold an action, with the answer of each. */
export function frameActions(
	widgets: readonly CanvasWidget[],
	answers: ReadonlyMap<string, Answered>,
): ActionWidget[] {
	return widgets
		.filter((widget) => widget.kind === FRAME_KIND.name)
		.map((widget) => actionWidget(widget, answers.get(widget.revision)))
		.filter((widget) => widget.actions.length > 0);
}
