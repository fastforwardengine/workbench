import type { Suggestion } from '../state/commands.ts';
import type { Composer } from './composer.ts';

/**
 * The command palette above the composer. It holds the rows for what the person
 * typed, the picked row, and whether the person dismissed the palette. It draws
 * itself through the composer.
 */
export class Palette {
	private readonly composer: Composer;
	private rows: Suggestion[] = [];
	private pick = 0;
	private dismissed = false;
	/** The composer text of the last refresh that showed rows, or undefined when none showed. */
	private seen: string | undefined;

	constructor(composer: Composer) {
		this.composer = composer;
	}

	/** True when the palette shows at least one row. */
	get open(): boolean {
		return this.rows.length > 0;
	}

	/** The picked row, or undefined when the palette is closed. */
	get current(): Suggestion | undefined {
		return this.rows[this.pick];
	}

	/**
	 * Recompute the rows from the composer text and draw them. `active` is false
	 * outside compose mode, so the palette closes. A dismissed palette stays
	 * closed until the person revives it. When the palette opens or the text
	 * changes, a row with the flag `picked` takes the pick.
	 */
	refresh(active: boolean, suggest: (text: string) => Suggestion[]): void {
		const show = active && !this.dismissed;
		const text = this.composer.text;
		this.rows = show ? suggest(text) : [];
		if (this.rows.length > 0 && text !== this.seen) {
			const flagged = this.rows.findIndex((row) => row.picked);
			if (flagged >= 0) this.pick = flagged;
		}
		this.seen = this.rows.length > 0 ? text : undefined;
		this.pick = Math.min(this.pick, Math.max(0, this.rows.length - 1));
		this.composer.setPalette(this.rows, this.pick);
	}

	/** Move the picked row up or down, inside the rows. */
	move(step: number): void {
		const last = this.rows.length - 1;
		this.pick = Math.max(0, Math.min(last, this.pick + step));
		this.composer.setPalette(this.rows, this.pick);
	}

	/** Close the palette until the person revives it. */
	dismiss(): void {
		this.dismissed = true;
	}

	/** Let the palette open again. */
	revive(): void {
		this.dismissed = false;
	}

	/** Put the picked row's text in the composer. */
	complete(): void {
		const row = this.current;
		if (row) this.composer.setText(row.insert);
	}
}
