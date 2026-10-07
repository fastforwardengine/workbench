/** The layers of the dock, in the order of the tabs line. */
export const LAYERS = ['files', 'processes', 'keys', 'camera'] as const;

/** One layer of the dock: the files, the background processes, the keys sheet, or the cameras. */
export type LayerId = (typeof LAYERS)[number];

/** True for every layer. A narrow terminal uses a narrower test. */
const ANY = (): boolean => true;

/**
 * The open layers of the dock, and which one is on top. A layer opens on top.
 * Opening a layer that is open puts it on top and keeps the others. Closing the
 * top layer shows the layer that was on top before it. The tabs keep the order
 * of `LAYERS`, so a tab does not move when its layer rises.
 *
 * A test `fits` names the layers that can show now. A layer that does not fit
 * stays open and never counts as the top layer or as a tab.
 */
export class LayerStack {
	/** The open layers. The last one is the newest on top. */
	private recency: LayerId[] = [];

	has(id: LayerId): boolean {
		return this.recency.includes(id);
	}

	/** The open layers in the order of the tabs. */
	tabs(fits: (id: LayerId) => boolean = ANY): LayerId[] {
		return LAYERS.filter((id) => this.has(id) && fits(id));
	}

	/** The layer that shows: the newest of the open layers that fit. */
	top(fits: (id: LayerId) => boolean = ANY): LayerId | undefined {
		return this.recency.findLast(fits);
	}

	/** Put a layer on top. A layer that is closed opens. */
	raise(id: LayerId): void {
		this.recency = [...this.recency.filter((open) => open !== id), id];
	}

	close(id: LayerId): void {
		this.recency = this.recency.filter((open) => open !== id);
	}

	/** The tab after the top layer. It wraps around, and it is the top layer when it is the only tab. */
	next(fits: (id: LayerId) => boolean = ANY): LayerId | undefined {
		const top = this.top(fits);
		const tabs = this.tabs(fits);
		return top === undefined ? undefined : tabs[(tabs.indexOf(top) + 1) % tabs.length];
	}

	clear(): void {
		this.recency = [];
	}
}
