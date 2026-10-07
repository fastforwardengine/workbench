/**
 * Wrap a read so that calls do not overlap. A call during a read returns at
 * once and asks for one more read after the current one. Many calls then cost
 * at most two reads, and the last change is never lost.
 */
export function coalesced(read: () => Promise<void>): () => Promise<void> {
	let running = false;
	let pending = false;
	return async () => {
		if (running) {
			pending = true;
			return;
		}
		running = true;
		try {
			do {
				pending = false;
				await read();
			} while (pending);
		} finally {
			running = false;
		}
	};
}
