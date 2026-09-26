import type { ExchangeActivation, ExchangeView } from '@ambionframework/ambion';
import type { RoomView } from '../host/host.ts';

/**
 * The newest activation of an exchange that ran, or undefined when it has
 * none. The room abandons an attempt without running it, so an abandoned
 * attempt has no steps. It counts only when no other activation exists.
 */
export function newest(exchange: ExchangeView | undefined): ExchangeActivation | undefined {
	const activations = exchange?.activations ?? [];
	return (
		activations.findLast((activation) => activation.outcome.status !== 'abandoned') ??
		activations.at(-1)
	);
}

/** The exchange a person names: by ordinal, oldest first, or the latest with an activation. */
export function pick(
	exchanges: readonly ExchangeView[],
	argument: string,
): ExchangeView | undefined {
	if (argument === '') return [...exchanges].reverse().find((exchange) => newest(exchange));
	const ordinal = Number(argument);
	return Number.isInteger(ordinal) ? exchanges[ordinal - 1] : undefined;
}

/** What the person owes the room: the replies that wait on them. */
export function attentionOf(view: RoomView | undefined, person: string): string[] {
	if (!view || !person) return [];
	// `pendingFor` reads a `RoomRead`, and the host view overrides `goal`, so filter here.
	return view.exchanges
		.filter(
			(exchange) =>
				exchange.status === 'closed' &&
				exchange.outcome.kind === 'awaiting' &&
				exchange.outcome.person === person,
		)
		.map((exchange) => `The exchange from message ${exchange.from} waits for your reply.`);
}
