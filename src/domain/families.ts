import type { PiOptions } from '@ambionframework/pi';

/**
 * The executor family of each seat, and the credential that family needs.
 *
 * Every seat runs on Pi today, not on `@ambionframework/codex` or
 * `@ambionframework/claude`. `WORKBENCH_MODEL` switches the model between
 * providers; `MODEL_PRESETS` names the two this project has a key for.
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
};

/** The short names `WORKBENCH_MODEL` accepts, each for one Pi model id. */
const MODEL_PRESETS: Readonly<Record<string, string>> = {
	anthropic: 'anthropic/claude-sonnet-4-5',
	openai: 'openai/gpt-5.6-luna',
};

/**
 * The model every seat runs on. `WORKBENCH_MODEL` switches it: `anthropic` and
 * `openai` are the two presets above, and any other value passes through as
 * a Pi model id, `provider/model-id`, for a provider this project has no
 * preset for. The default is the `anthropic` preset.
 */
export function piModel(env: Environment = process.env): string {
	const choice = env.WORKBENCH_MODEL;
	if (!choice) return MODEL_PRESETS.anthropic ?? 'anthropic/claude-sonnet-4-5';
	return MODEL_PRESETS[choice] ?? choice;
}

/** The thinking level of every seat. Pi sends it to the provider of the model. */
export const THINKING: NonNullable<PiOptions['thinking']> = 'low';

/** The environment variable that holds the key of a family. */
export function keyVariable(_family: Family, env: Environment = process.env): string {
	const model = piModel(env);
	const provider = model.slice(0, Math.max(model.indexOf('/'), 0));
	return `${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`;
}

/** True when the environment holds the key of a family. */
export const hasKey = (family: Family, env: Environment = process.env): boolean =>
	Boolean(env[keyVariable(family, env)]);

/** The seats whose family has no key, each with the variable it needs. */
export function unavailableSeats(
	env: Environment = process.env,
): { seat: string; family: Family; variable: string }[] {
	return Object.entries(seatFamilies)
		.filter(([, family]) => !hasKey(family, env))
		.map(([seat, family]) => ({ seat, family, variable: keyVariable(family, env) }));
}

/** One line per seat that cannot run. An empty list means every seat can run. */
export const describeUnavailable = (env: Environment = process.env): string[] =>
	unavailableSeats(env).map(
		({ seat, family, variable }) =>
			`Seat '${seat}' cannot run: ${variable} is not set, and the ${family} family needs it.`,
	);
