/** A side panel: the files of the workspace, or the background processes. */
export type PanelMode = 'files' | 'processes';

/** Which surface takes the keys: the composer, the discussions, the refs, or a side panel. */
export type Mode = 'compose' | 'browse' | 'refs' | PanelMode;

/** True when the mode is a side panel. */
export const isPanel = (mode: Mode): mode is PanelMode => mode === 'files' || mode === 'processes';
