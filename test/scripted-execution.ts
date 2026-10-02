import type { Execution } from '@ambionframework/ambion/hosting';
import { type PiExecutionOptions, piExecution } from '@ambionframework/pi';

/** Existing scripted replies run through Pi in memory. This execution makes no live request. */
export function scriptedExecution(stream: PiExecutionOptions['stream']): Execution {
	if (!stream) throw new Error('A scripted stream is required. Live model calls are forbidden.');
	const execution = piExecution({ stream, sessions: 'memory' });
	return {
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
}
