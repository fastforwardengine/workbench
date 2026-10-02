import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CodexExecutionOptions, CodexOptions } from '@ambionframework/codex';

/** The executor family of each seat. */
export type Family = 'codex';
export type Environment = Readonly<Record<string, string | undefined>>;

export const seatFamilies: Readonly<Record<string, Family>> = {
	assistant: 'codex',
	datasheets: 'codex',
	experiments: 'codex',
	instruments: 'codex',
	builder: 'codex',
};

/** Codex calls light reasoning `low`. */
export const REASONING_EFFORT = 'low' satisfies NonNullable<CodexOptions['modelReasoningEffort']>;

/** The model of every seat. Codex uses a model identifier without a provider prefix. */
export function codexModel(env: Environment = process.env): string {
	const model = env.WORKBENCH_MODEL?.trim() || 'gpt-6-luna';
	if (model.includes('/') || ['anthropic', 'openai'].includes(model))
		throw new Error(
			'WORKBENCH_MODEL must name a Codex model, such as gpt-6-luna. Remove the Pi provider prefix or preset.',
		);
	return model;
}

/** Paths match the defaults of the Ambion Codex execution. */
function codexPaths(
	env: Environment = process.env,
	options: CodexExecutionOptions = {},
): { home: string; login: string | false } {
	const effective = { ...env, ...options.env };
	const hostHome = effective.HOME || homedir();
	return {
		home: resolve(options.home || join(hostHome, '.ambion', 'codex')),
		login:
			options.login === false
				? false
				: resolve(
						options.login || join(effective.CODEX_HOME || join(hostHome, '.codex'), 'auth.json'),
					),
	};
}

function readableFile(path: string): boolean {
	try {
		accessSync(path, constants.R_OK);
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** Check the presence of a credential. Codex validates it when an activation starts. */
export function hasLogin(
	env: Environment = process.env,
	options: CodexExecutionOptions = {},
): boolean {
	if ((options.env ? { ...env, ...options.env } : env).CODEX_API_KEY?.trim()) return true;
	const paths = codexPaths(env, options);
	return (
		readableFile(join(paths.home, 'auth.json')) ||
		(paths.login !== false && readableFile(paths.login))
	);
}

export const LOGIN_HELP =
	'Codex needs CODEX_API_KEY or a readable auth.json. Run codex login (or codex login --device-auth). For a keyring login, set cli_auth_credentials_store = "file" and sign in again.';

export function unavailableSeats(
	env: Environment = process.env,
	options: CodexExecutionOptions = {},
): { seat: string; family: Family }[] {
	return hasLogin(env, options)
		? []
		: Object.entries(seatFamilies).map(([seat, family]) => ({ seat, family }));
}

export const describeUnavailable = (env: Environment = process.env): string[] =>
	unavailableSeats(env).map(({ seat }) => `Seat '${seat}' cannot run: ${LOGIN_HELP}`);
