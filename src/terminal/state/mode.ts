/** The side panels, in the order the terminal lays them out. */
const PANELS = ['files', 'processes', 'camera'] as const;

/** A side panel: the files of the workspace, the background processes, or the camera. */
export type PanelMode = (typeof PANELS)[number];

/** Which surface takes the keys: the composer, the discussions, the refs, or a side panel. */
export type Mode = 'compose' | 'browse' | 'refs' | PanelMode;

/** True when the mode is a side panel. */
export const isPanel = (mode: Mode): mode is PanelMode =>
	(PANELS as readonly string[]).includes(mode);
