import type { ExchangeActivation, Message } from '@ambionframework/ambion';
import type { ActivationSteps } from './steps.ts';
import { firstLine } from './text.ts';

/** A message of the person that a running seat has not read yet. */
export interface WaitingMessage {
	seq: number;
	/** The first line of the text that holds a character. */
	text: string;
}

/** The open exchange of a room: where it starts, and its activations. */
interface OpenExchange {
	from: number;
	activations: readonly ExchangeActivation[];
}

/**
 * True when the steps show that the activation read the line at `seq`. A
 * `steer` step with `consumed` set says the model got the line in a live pass.
 * A `steer` step without it says the pass did not read the line: the line waits
 * for the next delta. A pass reads the lines up to its `through`.
 */
function hasRead(read: ActivationSteps | undefined, seq: number): boolean {
	return (
		read?.passes.some(
			(pass) =>
				pass.through >= seq ||
				pass.steps.some((step) => step.type === 'steer' && step.seq === seq && step.consumed),
		) ?? false
	);
}

/**
 * The messages of `person` that wait to be read. A message waits when it came
 * after the first message of the open exchange, and a running respond activation
 * has not read it. The room steers every running respond activation, so a message
 * waits until each one has read it. A line that has no `steer` step yet waits too,
 * because the executor decides it later. Nothing waits while no activation runs,
 * and an ended activation holds nothing. `reads` holds the steps by activation id.
 * Known edge: a line stays shown until the activation ends when a seat reads it
 * through a room tool, or when a host restart loses the pass step.
 */
export function waitingMessages(input: {
	messages: readonly Message[];
	exchange: OpenExchange | undefined;
	person: string | undefined;
	reads: ReadonlyMap<string, ActivationSteps>;
}): WaitingMessage[] {
	const { messages, exchange, person, reads } = input;
	const running = (exchange?.activations ?? []).filter(
		(activation) => activation.outcome.kind === 'running' && activation.purpose === 'respond',
	);
	if (!exchange || person === undefined || running.length === 0) return [];
	return messages.flatMap((message) => {
		if (message.kind !== 'said' || message.from !== person || message.seq <= exchange.from)
			return [];
		const unread = running.some((activation) => !hasRead(reads.get(activation.id), message.seq));
		return unread ? [{ seq: message.seq, text: firstLine(message.text) }] : [];
	});
}
