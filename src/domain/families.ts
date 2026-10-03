import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PiOptions } from '@ambionframework/pi';

/**
 * The executor family of each seat, and the credential that family needs.
 *
 * Every seat runs on Pi today, not on `@ambionframework/codex` or
 * `@ambionframework/claude`. `WORKBENCH_MODEL` switches the model between
 * providers; `MODEL_PRESETS` names the three this project has a login for.
 * Codex is the family with a reasoning-effort control, and is future work;
 * see `docs/codex.md` in the Ambion documentation when that need is real.
 */
export type Family = 'pi';

/** The environment variables a run reads. */
export type Environment = Readonly<Record<string, string | undefined>>;

/** The seats that run on a family. Every seat is Pi today. */
export const seatFamilies: Readonly<Record<string, Family>> = {
	assistant: 'pi',
	datasheets: 'pi',
	experiments: 'pi',
	instruments: 'pi',
	builder: 'pi',
};

/** The provider of the ChatGPT Plus and Pro subscription in Pi. */
export const CHATGPT_PROVIDER = 'openai-codex';

/** The short names `WORKBENCH_MODEL` accepts, each for one Pi model id. */
const MODEL_PRESETS: Readonly<Record<string, string>> = {
	anthropic: 'anthropic/claude-sonnet-4-5',
	openai: 'openai/gpt-5.6-luna',
	chatgpt: `${CHATGPT_PROVIDER}/gpt-6-luna`,
};

/**
 * The file that holds the Pi sign-ins. `WORKBENCH_PI_CREDENTIALS` names
 * another file. `workbench login` writes this file.
 */
export function piCredentialsPath(env: Environment = process.env): string {
	return (
		env.WORKBENCH_PI_CREDENTIALS || join(env.HOME || homedir(), '.ambion', 'pi', 'credentials.json')
	);
}

/** True when the credential file holds a sign-in for `provider`. A file that is missing or invalid counts as no sign-in. */
function hasSignIn(provider: string, env: Environment): boolean {
	try {
		const stored: unknown = JSON.parse(readFileSync(piCredentialsPath(env), 'utf8'));
		return typeof stored === 'object' && stored !== null && Boolean(Reflect.get(stored, provider));
	} catch {
		return false;
	}
}

/**
 * The model every seat runs on. `WORKBENCH_MODEL` switches it: `anthropic`,
 * `openai`, and `chatgpt` are the presets above, and any other value passes
 * through as a Pi model id, `provider/model-id`. With no value, the default is
 * the `chatgpt` preset when the credential file holds a ChatGPT sign-in, and
 * the `anthropic` preset otherwise.
 */
export function piModel(env: Environment = process.env): string {
	const choice = env.WORKBENCH_MODEL;
	if (choice) return MODEL_PRESETS[choice] ?? choice;
	const preset = hasSignIn(CHATGPT_PROVIDER, env) ? 'chatgpt' : 'anthropic';
	return MODEL_PRESETS[preset] ?? 'anthropic/claude-sonnet-4-5';
}

/** The thinking level of every seat. Pi sends it to the provider of the model. */
export const THINKING: NonNullable<PiOptions['thinking']> = 'low';

/** The provider of a Pi model id: the text before the first slash. */
const providerOf = (model: string): string => model.slice(0, Math.max(model.indexOf('/'), 0));

/** The environment variable that holds the key of a family. */
export function keyVariable(_family: Family, env: Environment = process.env): string {
	return `${providerOf(piModel(env)).toUpperCase().replace(/-/g, '_')}_API_KEY`;
}

/** True when the model has a key in the environment or a sign-in in the credential file. */
export const modelHasLogin = (model: string, env: Environment = process.env): boolean =>
	Boolean(env[`${providerOf(model).toUpperCase().replace(/-/g, '_')}_API_KEY`]) ||
	hasSignIn(providerOf(model), env);

/** True when a family can run: the environment holds its key, or the credential file holds its sign-in. */
export const hasLogin = (_family: Family, env: Environment = process.env): boolean =>
	modelHasLogin(piModel(env), env);

/** The line that tells the person how to give a family a login. */
function loginAdvice(family: Family, env: Environment = process.env): string {
	if (providerOf(piModel(env)) === CHATGPT_PROVIDER) return 'Run `workbench login`.';
	return `Set ${keyVariable(family, env)} in the environment or in .env, or run \`workbench login\` for ChatGPT.`;
}

/** The seats whose family has no login, each with the variable it needs. */
export function unavailableSeats(
	env: Environment = process.env,
): { seat: string; family: Family; variable: string }[] {
	return Object.entries(seatFamilies)
		.filter(([, family]) => !hasLogin(family, env))
		.map(([seat, family]) => ({ seat, family, variable: keyVariable(family, env) }));
}

/** The reason a family cannot run, with the way to fix it. */
export const describeMissingLogin = (family: Family, env: Environment = process.env): string =>
	`The ${family} family has no login. ${loginAdvice(family, env)}`;

/** One line per seat that cannot run. An empty list means every seat can run. */
export const describeUnavailable = (env: Environment = process.env): string[] =>
	unavailableSeats(env).map(
		({ seat, family }) => `Seat '${seat}' cannot run: ${describeMissingLogin(family, env)}`,
	);
