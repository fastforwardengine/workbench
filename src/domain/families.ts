import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CodexExecutionOptions, CodexOptions } from '@ambionframework/codex';
import type { PiOptions } from '@ambionframework/pi';

/** The executor family of a seat. The assistant runs on Pi. The specialists run on Codex. */
export type Family = 'pi' | 'codex';
export type Environment = Readonly<Record<string, string | undefined>>;

export const seatFamilies: Readonly<Record<string, Family>> = {
	assistant: 'pi',
	datasheets: 'codex',
	experiments: 'codex',
	instruments: 'codex',
	builder: 'codex',
};

/** Pi calls light reasoning `low`. */
export const THINKING = 'low' satisfies NonNullable<PiOptions['thinking']>;

/** Codex calls light reasoning `low`. */
export const REASONING_EFFORT = 'low' satisfies NonNullable<CodexOptions['modelReasoningEffort']>;

/**
 * The model of the specialists, as a Codex model identifier without a provider
 * prefix. `WORKBENCH_MODEL` sets it. The assistant runs the same model on Pi.
 */
export function codexModel(env: Environment = process.env): string {
	const model = env.WORKBENCH_MODEL?.trim() || 'gpt-6-luna';
	if (model.includes('/') || ['anthropic', 'openai'].includes(model))
		throw new Error(
			'WORKBENCH_MODEL must name a Codex model, such as gpt-6-luna. Remove the Pi provider prefix or preset.',
		);
	return model;
}

/** The model of the assistant: the Codex model on the `openai` provider of Pi. */
export const piModel = (env: Environment = process.env): string => `openai/${codexModel(env)}`;

/**
 * The file that holds the Pi sign-in. Ambion documents no default path.
 * `WORKBENCH_PI_CREDENTIALS` overrides this one.
 */
export function piCredentialsPath(env: Environment = process.env): string {
	return resolve(
		env.WORKBENCH_PI_CREDENTIALS?.trim() ||
			join(env.HOME || homedir(), '.ambion', 'pi', 'credentials.json'),
	);
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

/** True when the Pi credential file holds a sign-in for the `openai` provider. */
function hasPiSignIn(env: Environment): boolean {
	try {
		const stored: unknown = JSON.parse(readFileSync(piCredentialsPath(env), 'utf8'));
		return typeof stored === 'object' && stored !== null && 'openai' in stored && !!stored.openai;
	} catch {
		return false;
	}
}

/**
 * Check the presence of a credential for a family. No check makes a network
 * request. The provider validates the credential when an activation starts.
 *
 * - Pi uses a stored ChatGPT sign-in, or `OPENAI_API_KEY`. Pi prefers the sign-in.
 * - Codex uses `CODEX_API_KEY`, `OPENAI_API_KEY`, or the `auth.json` of `codex login`.
 *   The Codex execution passes `OPENAI_*` variables to Codex, and a key bills the key.
 */
export function hasLogin(
	family: Family,
	env: Environment = process.env,
	options: CodexExecutionOptions = {},
): boolean {
	if (family === 'pi') return Boolean(env.OPENAI_API_KEY?.trim()) || hasPiSignIn(env);
	const effective = options.env ? { ...env, ...options.env } : env;
	if (effective.CODEX_API_KEY?.trim() || effective.OPENAI_API_KEY?.trim()) return true;
	const paths = codexPaths(env, options);
	return (
		readableFile(join(paths.home, 'auth.json')) ||
		(paths.login !== false && readableFile(paths.login))
	);
}

/** What a person does when a family has no login. */
export const LOGIN_HELP: Readonly<Record<Family, string>> = {
	pi: 'Pi needs a ChatGPT sign-in or OPENAI_API_KEY. Run workbench login to sign in with ChatGPT.',
	codex:
		'Codex needs CODEX_API_KEY, OPENAI_API_KEY, or a readable auth.json. Run codex login (or codex login --device-auth). For a keyring login, set cli_auth_credentials_store = "file" and sign in again.',
};

/** The seats whose family has no login. */
export function unavailableSeats(
	env: Environment = process.env,
	options: CodexExecutionOptions = {},
): { seat: string; family: Family }[] {
	return Object.entries(seatFamilies)
		.filter(([, family]) => !hasLogin(family, env, options))
		.map(([seat, family]) => ({ seat, family }));
}

/** One line for each seat that cannot run, with the help of its family. */
export const describeUnavailable = (
	env: Environment = process.env,
	options: CodexExecutionOptions = {},
): string[] =>
	unavailableSeats(env, options).map(
		({ seat, family }) => `Seat '${seat}' cannot run: ${LOGIN_HELP[family]}`,
	);
