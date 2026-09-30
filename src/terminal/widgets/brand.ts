/**
 * The product name and the terminal's dark palette. A brand kit is future
 * work; these are placeholder colors, chosen so that text measures at least
 * 4.5:1 on the background and a border at least 3:1.
 */

/** The product name and its one-line description. */
export const brand = {
	name: 'Workbench',
	product: 'Lab',
	tagline: 'an agentic lab workspace',
} as const;

/** The terminal palette, on a dark surface. */
export const tui = {
	bg: '#10171c',
	panel: '#1b2a33',
	text: '#e8eef1',
	muted: '#a9bcc1',
	dim: '#7f929a',
	accent: '#5cc6d8',
	coral: '#ff7a59',
	summary: '#e6c68f',
	green: '#6fd3a1',
	red: '#ff8f7d',
	line: '#3f5b66',
	selected: '#233a44',
	steer: '#1e323b',
} as const;
