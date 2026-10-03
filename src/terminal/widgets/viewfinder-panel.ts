import { type CliRenderer, fg, ImageRenderable, StyledText, TextRenderable } from '@opentui/core';
import type { ViewfinderBrowser } from '../state/viewfinder-browser.ts';
import { tui as palette } from './brand.ts';
import { lineText, SidePanel } from './side-panel.ts';

const HINT = 'Workbench reads the camera every 3 s   /camera closes';

/** What the panel says in a terminal that cannot draw the frame. */
const NEEDS_KITTY = 'The viewfinder needs a terminal with Kitty graphics, such as Ghostty.';

/** The rows that the frame takes before the first layout gives the panel a width. */
const IMAGE_ROWS = 12;

/** The columns of the border, the padding, the body padding, and the scrollbar. */
const FRAME_COLUMNS = 7;

/** The shape of a camera frame: 16 wide by 9 high. */
const FRAME_SHAPE = 9 / 16;

/** The viewfinder panel: the sensor name, the age of the latest frame, and the frame. */
export class ViewfinderPanel extends SidePanel {
	private readonly heading: ReturnType<typeof lineText>;
	private readonly image: ImageRenderable;
	private readonly body: TextRenderable;
	/** The digest of the frame in the image. The panel sets the source again only when it changes. */
	private shown: string | undefined;

	constructor(renderer: CliRenderer) {
		super(renderer, false, '33%');
		this.heading = lineText(renderer);
		this.image = new ImageRenderable(renderer, {
			fit: 'fit',
			protocol: 'kitty',
			width: '100%',
			height: IMAGE_ROWS,
			visible: false,
		});
		this.body = new TextRenderable(renderer, { content: '', wrapMode: 'word', width: '100%' });
		this.addBody(this.image, this.body);
		for (const part of [this.heading, this.scroll, this.hint]) this.root.add(part);
		this.hint.content = new StyledText([fg(palette.dim)(HINT)]);
	}

	/** Draw the state of the browser. `kitty` is true when the terminal draws Kitty graphics. */
	draw(browser: ViewfinderBrowser, kitty: boolean): void {
		this.root.visible = browser.open;
		if (!browser.open) return;
		const { sensor, frame, note } = browser.state;
		const age = browser.age;
		this.heading.content = new StyledText([
			fg(palette.accent)('Camera'),
			fg(palette.text)(sensor ? ` › ${sensor}` : ''),
			fg(palette.dim)(age ? `   ${age}` : ''),
		]);
		this.fitImage();
		const picture = kitty ? frame : undefined;
		this.drawImage(picture?.digest, picture?.png);
		const line = kitty ? note : NEEDS_KITTY;
		this.body.content = new StyledText([fg(note ? palette.summary : palette.muted)(line ?? '')]);
	}

	/** Give the frame the rows that a 16:9 picture takes at the width of the panel. */
	private fitImage(): void {
		const columns = this.root.width - FRAME_COLUMNS;
		if (columns <= 0) return;
		const rows = Math.max(1, Math.round((columns * FRAME_SHAPE) / this.image.cellAspectRatio));
		if (this.image.height !== rows) this.image.height = rows;
	}

	private drawImage(digest: string | undefined, png: Uint8Array | undefined): void {
		this.image.visible = digest !== undefined;
		if (digest === this.shown) return;
		this.shown = digest;
		if (png) this.image.source = png;
	}
}
