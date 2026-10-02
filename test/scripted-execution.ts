import type { Execution } from '@ambionframework/ambion/hosting';
import { type PiExecutionOptions, piExecution } from '@ambionframework/pi';

/**
 * Scripted replies run through Pi in memory. The result holds one execution
 * for each family, so the script drives every seat. The assistant is a Pi
 * seat. The specialists are Codex seats, and the second execution rewrites
 * each of them to a Pi seat. This helper makes no live request.
 */
export function scriptedExecution(stream: PiExecutionOptions['stream']): Execution[] {
	if (!stream) throw new Error('A scripted stream is required. Live model calls are forbidden.');
	const execution = piExecution({ stream, sessions: 'memory' });
	const codexSeats: Execution = {
		kind: 'codex',
		connector(host) {
			const connector = execution.connector(host);
			return {
				connect(room, request) {
					const definition = {
						...request.definition,
						executor: {
							...request.definition.executor,
							kind: 'pi',
							model: 'openai/gpt-6-luna',
							thinking: 'low',
						},
					};
					return connector.connect(room, { ...request, definition });
				},
			};
		},
	};
	return [execution, codexSeats];
}
