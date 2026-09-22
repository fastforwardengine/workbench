import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Attention } from '@ambionframework/ambion';

/** The rooms share one project. Each goal shows a distinct collaboration pattern. */
export const scenarios: {
	name: string;
	goal: string;
	pattern: string;
	prompt: string;
	seats: Record<string, Attention>;
}[] = [
	{
		name: 'characterization',
		goal:
			'Discharge-test the 18650 cell through a load resistor. Choose a resistor value that ' +
			'keeps the current within the cell’s safe continuous discharge limit.',
		pattern: 'Datasheet check → design decision',
		prompt:
			'Pick a load resistor to discharge-test the 18650 cell and show the current stays within its safe continuous discharge limit.',
		seats: { datasheets: 'named', design: 'named' },
	},
	{
		name: 'cycling',
		goal:
			'Plan a charge and discharge cycling test for the 18650 cell that tracks capacity over ' +
			'10 cycles, with a thermocouple on the cell.',
		pattern: 'Design → test plan',
		prompt:
			'Plan a repeatable charge and discharge cycling test for the 18650 cell that tracks capacity over 10 cycles.',
		seats: { design: 'named', experiments: 'named' },
	},
	{
		name: 'budget',
		goal:
			'Add up the standby current of the protection module and the sense circuit. Confirm the ' +
			'charge module’s output can supply it with margin.',
		pattern: 'Datasheet check → power budget',
		prompt:
			'Add up the standby current of the protection module and the sense circuit, and confirm the charge module’s output can supply it with margin.',
		seats: { datasheets: 'named', design: 'named' },
	},
];

const libraryDirectory = fileURLToPath(new URL('../../library/', import.meta.url));

/** The starter files under /shared. Existing edits always remain intact. */
const sharedFiles: Record<string, string> = {
	'shared/kit.md': `# The project

**Workbench holds one battery hardware project today: a bench
cell-characterization kit.** Read /library for the datasheets before you
claim a specification.

## Parts

- One 18650 Li-ion cell, 3.7 V nominal, 3400 mAh.
- One TP4056-based charge and protection module.
- A power resistor bank, E12 series, 1 W to 5 W.
- One K-type thermocouple, for the cell surface during a cycling test.
- JST-PH battery connectors and 18 AWG silicone wire.

## House rules

- Read the datasheet in /library before you state a limit. Cite the path.
- No real equipment is connected. Every measurement is a planned value.
- Record a decision in /shared/notes.md when the person permits file edits.
`,
	'shared/notes.md': `# Lab notes

Status: empty. Record decisions and test plans here.
`,
};

async function copyLibrary(path: string): Promise<void> {
	const entries = await readdir(libraryDirectory, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const source = resolve(libraryDirectory, entry.name);
		const target = resolve(path, 'library', entry.name);
		await mkdir(dirname(target), { recursive: true });
		await writeIfAbsent(target, await readFile(source, 'utf8'));
	}
}

async function writeIfAbsent(target: string, content: string): Promise<void> {
	try {
		await writeFile(target, content, { flag: 'wx' });
	} catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
	}
}

/** Add missing datasheets and starter files. Existing edits always remain. */
export async function seedWorkspace(path: string): Promise<void> {
	await copyLibrary(path);
	for (const [name, content] of Object.entries(sharedFiles)) {
		const target = resolve(path, name);
		await mkdir(dirname(target), { recursive: true });
		await writeIfAbsent(target, content);
	}
}

/**
 * The lab records: projects, test plans, runs, and results. Every table that
 * agents write has the provenance columns, and the resource fills them. The
 * UNIQUE constraint on a run makes a retried activation fail instead of
 * recording the run twice.
 */
export const labSchema = `
CREATE TABLE IF NOT EXISTS projects (
	name TEXT PRIMARY KEY,
	goal TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS test_plans (
	id INTEGER PRIMARY KEY,
	project TEXT NOT NULL REFERENCES projects (name),
	title TEXT NOT NULL,
	steps TEXT NOT NULL,
	agent TEXT, room TEXT, activation TEXT, exchange_owner TEXT, exchange_from TEXT, at TEXT
);
CREATE TABLE IF NOT EXISTS runs (
	id INTEGER PRIMARY KEY,
	project TEXT NOT NULL REFERENCES projects (name),
	plan_id INTEGER REFERENCES test_plans (id),
	label TEXT NOT NULL,
	agent TEXT, room TEXT, activation TEXT, exchange_owner TEXT, exchange_from TEXT, at TEXT,
	UNIQUE (activation, label)
);
CREATE TABLE IF NOT EXISTS results (
	id INTEGER PRIMARY KEY,
	run_id INTEGER NOT NULL REFERENCES runs (id),
	metric TEXT NOT NULL,
	value REAL NOT NULL,
	unit TEXT NOT NULL,
	agent TEXT, room TEXT, activation TEXT, exchange_owner TEXT, exchange_from TEXT, at TEXT
);
CREATE TABLE IF NOT EXISTS operations (
	id INTEGER PRIMARY KEY,
	instrument TEXT NOT NULL,
	setpoint REAL NOT NULL,
	outcome TEXT NOT NULL,
	request_id INTEGER REFERENCES operations (id),
	reading REAL,
	agent TEXT, room TEXT, activation TEXT, exchange_owner TEXT, exchange_from TEXT, at TEXT
);
${scenarios
	.map(
		({ name, goal }) =>
			`INSERT OR IGNORE INTO projects (name, goal) VALUES ('${name}', '${goal.replace(/'/g, "''")}');`,
	)
	.join('\n')}
`;

/** The lab tables an agent may append to. Projects stay fixed. */
export const labWritable = ['test_plans', 'runs', 'results', 'operations'] as const;

/** The simulated bench instruments. An operation above the limit needs the approval of a person. */
export const instruments = [
	{ name: 'discharge-current', quantity: 'discharge current', unit: 'mA', limit: 2000 },
	{ name: 'charge-voltage', quantity: 'charge voltage', unit: 'V', limit: 4.2 },
] as const;
