/** The side panels, in the order the terminal lays them out. */
const PANELS = ['files', 'processes'] as const;

/** A side panel that takes the keys: the files of the workspace, or the background processes. */
export type PanelMode = (typeof PANELS)[number];

/** Which surface takes the keys: the composer, the discussions, the refs, or a side panel. The viewfinder is no mode: it takes no keys. */
export type Mode = 'compose' | 'browse' | 'refs' | PanelMode;

/** True when the mode is a side panel. */
export const isPanel = (mode: Mode): mode is PanelMode =>
	(PANELS as readonly string[]).includes(mode);
