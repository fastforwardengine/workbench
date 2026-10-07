import type { KeyEvent } from '@opentui/core';
import { LAYERS, type LayerId, LayerStack } from '../state/layers.ts';
import { type DockPanel, overlayWidth } from '../widgets/dock.ts';
import type { Exits, Surface } from './surface.ts';

/** Below this width, the dock draws over the conversation, and the camera does not show. */
export const NARROW = 100;

/** Where the dock draws: not at all, beside the conversation, or over it. */
type Placement = 'off' | 'beside' | 'over';

/** What the dock reaches into. */
export interface DockParts {
	/** The layers, by id. */
	surfaces: Readonly<Record<LayerId, Surface>>;
	/** The box at the right of the conversation. */
	panel: DockPanel;
	/** The width of the terminal. */
	width: () => number;
}

/**
 * The dock: one box at the right of the conversation, with the open layers in
 * a stack. Only the top layer draws and runs its work. The layers below keep
 * their state. A narrow terminal shows the dock only while it has the keys, and
 * then the dock draws over the right part of the conversation. The conversation
 * keeps its width.
 */
export class Dock {
	private readonly stack = new LayerStack();
	private readonly surfaces: Readonly<Record<LayerId, Surface>>;
	private readonly panel: DockPanel;
	private readonly width: () => number;
	/** The layer that runs its work now. */
	private live: LayerId | undefined;
	/** Where the dock draws now. */
	private placement: Placement = 'off';

	constructor(parts: DockParts) {
		this.surfaces = parts.surfaces;
		this.panel = parts.panel;
		this.width = parts.width;
	}

	private readonly fits = (id: LayerId): boolean =>
		this.width() >= NARROW || this.surfaces[id].narrow;

	/** True while the dock shows on the screen. */
	get onScreen(): boolean {
		return this.placement !== 'off';
	}

	/** True while the dock draws over the conversation. */
	get covers(): boolean {
		return this.placement === 'over';
	}

	/** The layer on top that fits the terminal, or undefined when the dock has none to show. */
	get shown(): LayerId | undefined {
		return this.stack.top(this.fits);
	}

	/** True when the layer is open, on top or not. */
	has(id: LayerId): boolean {
		return this.stack.has(id);
	}

	/** True when the layer needs the keys when it opens. The camera leaves them with the composer. */
	takesKeys(id: LayerId): boolean {
		return this.surfaces[id].takesKeys;
	}

	/** What the status line says while the top layer has the keys. */
	get status(): string {
		const shown = this.shown;
		return shown ? this.surfaces[shown].status : '';
	}

	/**
	 * Put a layer on top. A layer that is closed opens on fresh state, and the layer
	 * that was on top stops its work. A layer that is open keeps its state.
	 */
	open(id: LayerId): void {
		const fresh = !this.stack.has(id);
		this.stack.raise(id);
		if (!fresh) return;
		const before = this.live;
		this.live = id;
		if (before !== undefined) this.surfaces[before].hide();
		this.surfaces[id].open();
	}

	/** Close a layer, the top one when none is named. The layer below it shows next. */
	close(id: LayerId | undefined = this.shown): void {
		if (id !== undefined) this.stack.close(id);
	}

	/** Put the next tab on top. */
	cycle(): void {
		const next = this.stack.next(this.fits);
		if (next !== undefined && next !== this.shown) this.stack.raise(next);
	}

	/** Give one key to the top layer. */
	onKey(key: KeyEvent, exits: Exits): void {
		const shown = this.shown;
		if (shown) this.surfaces[shown].onKey(key, exits);
	}

	/**
	 * Place the dock for the terminal and the keys, and start the work of the top
	 * layer. Every other layer stops its work. A call that changes nothing has no
	 * effect, so a draw may call it. It returns true when the dock appeared, went
	 * away, or moved between beside and over the conversation, so the conversation
	 * redraws.
	 */
	layout(keyed: boolean): boolean {
		const wide = this.width() >= NARROW;
		const shown = this.shown;
		const visible = shown !== undefined && (wide || keyed);
		const placement = !visible ? 'off' : wide ? 'beside' : 'over';
		const changed = placement !== this.placement;
		this.placement = placement;
		this.panel.layout({
			visible,
			overlay: placement === 'over' ? overlayWidth(this.width()) : undefined,
			keyed,
		});
		this.run(visible ? shown : undefined);
		return changed;
	}

	/** Draw the tabs and the top layer. */
	draw(): void {
		const shown = this.shown;
		this.panel.draw(this.stack.tabs(this.fits), shown);
		for (const id of LAYERS) this.surfaces[id].root.visible = id === shown;
		if (shown !== undefined && this.live === shown) this.surfaces[shown].draw();
	}

	/** Stop the work of every layer, and close them, when the terminal ends. */
	release(): void {
		// Clear the stack first: a layer that stops may redraw the terminal, and the draw must not start it again.
		this.stack.clear();
		this.run(undefined);
	}

	/** Start the work of one layer, and stop the work of the layer before it. */
	private run(next: LayerId | undefined): void {
		const before = this.live;
		if (before === next) return;
		// Record the layer first: a layer may redraw the terminal when it stops.
		this.live = next;
		if (before !== undefined) this.surfaces[before].hide();
		if (next !== undefined) this.surfaces[next].show();
	}
}
