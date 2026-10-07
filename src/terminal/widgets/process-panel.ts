import { bg, type CliRenderer, fg, StyledText, TextRenderable } from '@opentui/core';
import type { ProcessOutput, ProcessView } from '../../host/host.ts';
import { label, type ProcessBrowser, stateText } from '../state/process-browser.ts';
import { tui as palette } from './brand.ts';
import { LIST_ROWS, lineText, listText, SidePanel, windowStart } from './side-panel.ts';

/** The widest a command gets in the list. The title shows it whole. */
const COMMAND_WIDTH = 60;

/** The color of the dot before each process: its state at a glance. */
function dotColor(process: ProcessView): string {
	if (process.state === 'running') return palette.coral;
	if (process.state === 'exited' && process.exitCode === 0) return palette.green;
	return process.state === 'cancelled' ? palette.dim : palette.red;
}

const oneLine = (text: string): string => text.replace(/\s*\n\s*/g, ' ⏎ ');

const clip = (text: string, width: number): string =>
	text.length > width ? `${text.slice(0, width - 1)}…` : text;

/** What the output area says about the size of the output. */
function outputNote(output: ProcessOutput, process: ProcessView): string {
	if (output.size === 0)
		return process.state === 'running' ? 'No output yet.' : 'The process wrote no output.';
	const size = output.size < 1024 ? `${output.size} B` : `${(output.size / 1024).toFixed(1)} KB`;
	if (output.text === '')
		return `The output is ${size}, too large for the panel: ${process.output}`;
	return output.truncated ? `The last part of ${size} of output.` : `${size} of output.`;
}

/** The processes layer: the background processes of the seats, and the output of the chosen one. */
export class ProcessesPanel extends SidePanel {
	private readonly heading: TextRenderable;
	private readonly list: TextRenderable;
	private readonly title: TextRenderable;
	private readonly body: TextRenderable;
	private shown: string | undefined;

	constructor(renderer: CliRenderer) {
		super(renderer, true);
		this.heading = lineText(renderer);
		this.list = listText(renderer);
		this.title = new TextRenderable(renderer, { content: '', flexShrink: 0, wrapMode: 'word' });
		this.body = new TextRenderable(renderer, { content: '', wrapMode: 'char', width: '100%' });
		this.addBody(this.body);
		for (const part of [this.heading, this.list, this.title, this.scroll, this.message])
			this.root.add(part);
	}

	/** Draw the browser's state. The output scrolls to its end when the chosen process changes. */
	draw(browser: ProcessBrowser): void {
		if (!browser.open) return;
		const now = Date.now();
		const running = browser.processes.filter((process) => process.state === 'running').length;
		this.heading.content = new StyledText([
			fg(palette.accent)('Processes'),
			fg(palette.dim)(`   ${running} running, ${browser.processes.length} in all`),
		]);
		this.list.content = this.rows(browser, now);
		this.drawChosen(browser, now);
		this.showMessage(browser.message);
	}

	private rows(browser: ProcessBrowser, now: number): StyledText {
		const processes = browser.processes;
		if (processes.length === 0)
			return new StyledText([
				fg(palette.muted)('No process yet. A specialist starts one with its bash tool.'),
			]);
		const start = windowStart(browser.index, processes.length);
		const labels = processes.map((process) => process.name ?? process.handle);
		const width = Math.max(...labels.map((text) => text.length));
		const seatWidth = Math.max(...processes.map((process) => process.agent.length));
		return new StyledText(
			processes.slice(start, start + LIST_ROWS).flatMap((process, offset) => {
				const chosen = start + offset === browser.index;
				const cancelling = browser.cancelling.has(process.handle) ? 'cancelling ' : '';
				const state = `${cancelling}${stateText(process, now)}`;
				const line = `${chosen ? '▸ ' : '  '}${(labels[start + offset] ?? '').padEnd(width)}  ${process.agent.padEnd(seatWidth)}  ${state.padEnd(20)}  ${clip(oneLine(process.command), COMMAND_WIDTH)}`;
				const tail = offset === LIST_ROWS - 1 ? '' : '\n';
				const text = chosen
					? bg(palette.selected)(fg(palette.accent)(line))
					: fg(palette.muted)(line);
				return [fg(dotColor(process))('● '), text, fg(palette.muted)(tail)];
			}),
		);
	}

	private drawChosen(browser: ProcessBrowser, now: number): void {
		const process = browser.selected;
		if (browser.problem || !process) {
			const text = browser.problem ?? 'Choose a process to read its output.';
			this.title.content = new StyledText([fg(browser.problem ? palette.red : palette.dim)(text)]);
			this.body.content = '';
			this.shown = undefined;
			return;
		}
		const room = process.room ? `, in the room ${process.room}` : '';
		// The output of the process chosen before stays until the new one loads.
		const output = browser.output?.handle === process.handle ? browser.output : undefined;
		this.title.content = new StyledText([
			fg(palette.accent)(label(process)),
			fg(palette.dim)(`   ${process.agent}${room}, ${stateText(process, now)}\n`),
			fg(palette.text)(`$ ${process.command}\n`),
			fg(palette.dim)(output ? outputNote(output, process) : 'Reading the output.'),
		]);
		this.body.content = new StyledText([fg(palette.text)(output?.text ?? '')]);
		if (this.shown !== process.handle) this.scroll.scrollTop = this.scroll.scrollHeight;
		this.shown = process.handle;
	}
}
