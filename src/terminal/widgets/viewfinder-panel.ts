import {
	BoxRenderable,
	type CliRenderer,
	fg,
	ImageRenderable,
	StyledText,
	TextRenderable,
} from '@opentui/core';
import type { CameraView } from '../../host/host.ts';
import type { Row } from '../state/action-pad.ts';
import type { ViewfinderBrowser } from '../state/viewfinder-browser.ts';
import { ActionRows } from './action-rows.ts';
import { tui as palette } from './brand.ts';
import { lineText, SidePanel } from './side-panel.ts';

/** What the panel says in a terminal that cannot draw the frame. */
const NEEDS_KITTY = 'The viewfinder needs a terminal with Kitty graphics, such as Ghostty.';

/** The rows that a frame takes before the first layout gives the panel a width. */
const IMAGE_ROWS = 12;

/** The columns of the border, the padding, the body padding, the scrollbar, and the border of a box. */
const FRAME_COLUMNS = 9;

/** The shape of a camera frame: 16 wide by 9 high. */
const FRAME_SHAPE = 9 / 16;

/** The label of a camera for people: the title of its widget, else its name. */
const labelOf = (camera: Pick<CameraView, 'name' | 'title'>): string => camera.title ?? camera.name;

/** One labelled box of the stack: a line for the age and the note of one camera, and its frame. */
class CameraBox {
	/** The box of the camera, and the buttons under it. */
	readonly root: BoxRenderable;
	private readonly frame: BoxRenderable;
	private readonly actions: ActionRows;
	private readonly image: ImageRenderable;
	private readonly line: TextRenderable;
	/** The digest of the frame in the image. The box sets the source again only when it changes. */
	private shown: string | undefined;

	constructor(renderer: CliRenderer) {
		this.root = new BoxRenderable(renderer, {
			flexDirection: 'column',
			width: '100%',
			flexShrink: 0,
			visible: false,
		});
		this.frame = new BoxRenderable(renderer, {
			flexDirection: 'column',
			width: '100%',
			flexShrink: 0,
			border: true,
			borderColor: palette.line,
			titleColor: palette.accent,
		});
		this.actions = new ActionRows(renderer);
		this.image = new ImageRenderable(renderer, {
			fit: 'fit',
			protocol: 'kitty',
			width: '100%',
			height: IMAGE_ROWS,
			visible: false,
		});
		this.line = new TextRenderable(renderer, { content: '', wrapMode: 'word', width: '100%' });
		// The line comes first, so a tall frame never pushes the age and the note out of view.
		this.frame.add(this.line);
		this.frame.add(this.image);
		this.root.add(this.frame);
		this.root.add(this.actions.root);
	}

	/** Draw one camera. `age` is the age of its frame, and `columns` is the width that the frame may take. */
	draw(camera: CameraView, age: string | undefined, columns: number, rows: readonly Row[]): void {
		this.root.visible = true;
		this.frame.title = labelOf(camera);
		this.actions.draw(rows);
		this.fitImage(columns);
		this.drawImage(camera.frame?.digest, camera.frame?.png);
		this.line.visible = age !== undefined || camera.note !== undefined;
		this.line.content = new StyledText([
			fg(palette.dim)(age ?? ''),
			fg(palette.note)(camera.note ? `${age ? '   ' : ''}${camera.note}` : ''),
		]);
	}

	hide(): void {
		this.root.visible = false;
	}

	/** Give the frame the rows that a 16:9 picture takes at the width of the panel. */
	private fitImage(columns: number): void {
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

/** The viewfinder panel: one labelled box for each bound camera, stacked, and a note for the whole panel. */
export class ViewfinderPanel extends SidePanel {
	private readonly heading: ReturnType<typeof lineText>;
	private readonly stack: BoxRenderable;
	private readonly body: TextRenderable;
	private readonly boxes: CameraBox[] = [];

	constructor(renderer: CliRenderer) {
		super(renderer, false, '33%');
		this.heading = lineText(renderer);
		this.stack = new BoxRenderable(renderer, { flexDirection: 'column', width: '100%' });
		this.body = new TextRenderable(renderer, { content: '', wrapMode: 'word', width: '100%' });
		this.addBody(this.stack, this.body);
		for (const part of [this.heading, this.scroll]) this.root.add(part);
	}

	/** The box of the camera at `index`. The panel makes a box when a camera needs one. */
	private boxAt(index: number): CameraBox {
		let box = this.boxes[index];
		if (!box) {
			box = new CameraBox(this.renderer);
			this.boxes[index] = box;
			this.stack.add(box.root);
		}
		return box;
	}

	/** Draw the state of the browser. `kitty` is true when the terminal draws Kitty graphics. */
	draw(browser: ViewfinderBrowser, kitty: boolean): void {
		this.root.visible = browser.open;
		if (!browser.open) return;
		const { cameras, note } = browser.state;
		browser.syncActions();
		this.heading.content = new StyledText([fg(palette.accent)('Camera')]);
		const columns = this.root.width - FRAME_COLUMNS;
		const drawn = kitty ? cameras : [];
		drawn.forEach((camera, index) => {
			this.boxAt(index).draw(camera, browser.age(camera), columns, browser.pad.rows(camera.name));
		});
		for (const box of this.boxes.slice(drawn.length)) box.hide();
		const line = kitty ? note : NEEDS_KITTY;
		this.body.content = new StyledText([fg(note ? palette.note : palette.muted)(line ?? '')]);
	}
}
