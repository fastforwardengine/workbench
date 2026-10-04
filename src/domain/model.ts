import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PiOptions } from '@ambionframework/pi';

/**
 * The model of every seat, and the login it needs.
 *
 * Every seat runs on Pi. `WORKBENCH_MODEL` switches the model between
 * providers. `MODEL_PRESETS` names the four that this project has a login
 * for.
 */

/** The environment variables a run reads. */
export type Environment = Readonly<Record<string, string | undefined>>;

/** The provider of the ChatGPT Plus and Pro subscription in Pi. */
export const CHATGPT_PROVIDER = 'openai-codex';

/** The short names `WORKBENCH_MODEL` accepts, each for one Pi model id. */
const MODEL_PRESETS: Readonly<Record<string, string>> = {
	anthropic: 'anthropic/claude-sonnet-4-5',
	openai: 'openai/gpt-6.1-sol',
	chatgpt: `${CHATGPT_PROVIDER}/gpt-6.1-sol`,
	luna: `${CHATGPT_PROVIDER}/gpt-6-luna`,
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
 * `openai`, `chatgpt`, and `luna` are the presets above, and any other value passes
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

/**
 * The thinking level of every seat. Pi sends it to the provider of the model.
 * `low` is the lightest level that GPT-6.1 Sol accepts.
 */
export const THINKING: NonNullable<PiOptions['thinking']> = 'low';

/** The provider of a Pi model id: the text before the first slash. */
const providerOf = (model: string): string => model.slice(0, Math.max(model.indexOf('/'), 0));

/** The environment variable that holds the key of a provider. */
const keyVariableOf = (provider: string): string =>
	`${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`;

/** The environment variable that holds the key of the model. */
export function keyVariable(env: Environment = process.env): string {
	return keyVariableOf(providerOf(piModel(env)));
}

/** True when the model has a key in the environment or a sign-in in the credential file. */
export const modelHasLogin = (model: string, env: Environment = process.env): boolean =>
	Boolean(env[keyVariableOf(providerOf(model))]) || hasSignIn(providerOf(model), env);

/** The line that tells the person how to give the model a login. */
function loginAdvice(env: Environment): string {
	if (providerOf(piModel(env)) === CHATGPT_PROVIDER) return 'Run `workbench login`.';
	return `Set ${keyVariable(env)} in the environment or in .env, or run \`workbench login\` for ChatGPT.`;
}

/** The reason the model cannot run, with the way to fix it. It is undefined when the model has a login. */
export function missingLogin(env: Environment = process.env): string | undefined {
	const model = piModel(env);
	if (modelHasLogin(model, env)) return undefined;
	return `The model ${model} has no login. ${loginAdvice(env)}`;
}
