/** The side panels, in the order the terminal lays them out. */
const PANELS = ['files', 'processes', 'keys'] as const;

/** A side panel that takes the keys: the files of the workspace, the background processes, or the keys sheet. */
export type PanelMode = (typeof PANELS)[number];

/**
 * Which surface takes the keys: the composer, the refs, the actions of the cameras, or a side
 * panel. The viewfinder has no mode of its own: it takes keys only through `actions`.
 */
export type Mode = 'compose' | 'refs' | 'actions' | PanelMode;

/** True when the mode is a side panel. */
export const isPanel = (mode: Mode): mode is PanelMode =>
	(PANELS as readonly string[]).includes(mode);
