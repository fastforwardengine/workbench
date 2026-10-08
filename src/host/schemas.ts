import { readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/** The name of the guide, in the data directory. */
const SCHEMAS = 'schemas.md';

/** What the host keeps in each known entry of the data directory. */
const ENTRIES: Record<string, string> = {
	'rooms.db': 'SQLite. The room journals and the canvas table. The schema is below.',
	'rooms.db-wal': 'SQLite. The write-ahead log of `rooms.db`.',
	'rooms.db-shm': 'SQLite. The shared memory of `rooms.db`.',
	'activations.jsonl':
		'JSON lines. One line for each step of each activation. The format is below.',
	'git.db': 'SQLite. The git repositories of the workspace, such as the templates and the notes.',
	workspace: 'Folder. The files of the workspace: the shared folders and the home of each seat.',
	[SCHEMAS]: 'Markdown. This file. The host writes it again at each start.',
};

const ACTIVATIONS = `## activations.jsonl

**One line is one Ambion \`TracedStep\`.** The host adds no field. A line has
these fields:

- \`room\`: the room that the activation ran in.
- \`seat\`: the seat that ran the activation.
- \`exchange\`: the seq of the message that opened the exchange. A line
  outside an exchange has no \`exchange\`.
- \`step\`: the step, with the stamp fields below.

**The stamp of \`step\`.** \`activation\` is the id of the activation. \`pass\` is
the number of the pass. \`index\` is the place in the pass, from zero. \`at\` is
the ISO time of the runtime clock.

**The key of an activation is \`room\` and \`activation\`.** An activation id is
unique in one data directory only.

**\`step.type\` has these values:**

| Type          | Fields                                                              |
| ------------- | ------------------------------------------------------------------- |
| \`pass\`        | \`input\` (\`view\` or \`delta\`), \`through\` (the last seq that the pass read)  |
| \`input\`       | \`part\` (\`system\` or \`record\`), \`text\`                                   |
| \`thinking\`    | \`text\`, \`final\`. The log keeps the start of each block                  |
| \`text\`        | \`text\`, \`final\`                                                       |
| \`tool_call\`   | \`call\`, \`name\`, \`input\`, \`parent\` (optional)                            |
| \`tool_result\` | \`call\`, \`output\`, \`error\` (optional), \`parent\` (optional)                |
| \`approval\`    | \`call\`, \`answer\` (\`allow\` or \`deny\`)                                  |
| \`room\`        | \`call\`, \`intent\`, \`result\`, \`seq\` (optional). The answer to a commit      |
| \`steer\`       | \`seq\`, \`consumed\`. A message that landed during the activation          |
| \`usage\`       | Token counts, and \`cost\` when known                                   |
| \`session\`     | The harness, the model, and the tools that the session ran with       |
| \`notice\`      | \`level\` (\`info\` or \`warning\`), \`text\`, \`data\` (optional)                 |
| \`end\`         | \`stop\` (\`stopped\`, \`length\`, or \`cut\`), \`failure\` (optional)             |

**\`failure\` is \`{ "cause": string, "message": string }\`.** An \`end\` step
has it when the activation failed.

**An activation that has no \`end\` line stopped with the process.** The room
retries it under a new activation id. The log has no line for an activation
that no seat claimed.

Examples:

\`\`\`sh
# The activations that failed, with the reason.
jq -c 'select(.step.type=="end" and .step.failure) | {room, seat, at: .step.at, failure: .step.failure}' activations.jsonl

# The tool calls of one room, in order.
jq -c 'select(.room=="build" and .step.type=="tool_call") | [.seat, .step.name]' activations.jsonl

# The steps of one activation.
jq -c 'select(.room=="build" and .step.activation=="message:4:engineer:1")' activations.jsonl
\`\`\`
`;

/** The entries of the data directory, one line each. */
async function listing(directory: string): Promise<string> {
	const found = await readdir(directory, { withFileTypes: true });
	const names = new Set([...found.map((entry) => entry.name), SCHEMAS]);
	return [...names]
		.sort()
		.map((name) => `- \`${name}\`: ${ENTRIES[name] ?? 'Not known to the host.'}`)
		.join('\n');
}

/** The CREATE statement of each table and index of `rooms.db`, sorted by name. */
function statements(database: DatabaseSync): string {
	const rows = database
		.prepare('SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name, type')
		.all() as { sql: string }[];
	return rows.map(({ sql }) => `${sql};`).join('\n\n');
}

/** The text of the guide for one data directory. */
async function schemasText(database: DatabaseSync, directory: string): Promise<string> {
	return `<!-- The host generates this file at each start. Edits are lost. -->

# The data directory

${await listing(directory)}

## rooms.db

\`\`\`sql
${statements(database)}
\`\`\`

${ACTIVATIONS}`;
}

/** Write \`schemas.md\` in the data directory. An old file is overwritten. */
export async function writeSchemas(database: DatabaseSync, directory: string): Promise<void> {
	await writeFile(resolve(directory, SCHEMAS), await schemasText(database, directory));
}
