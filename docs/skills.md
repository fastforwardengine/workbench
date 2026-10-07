# Skills

**A skill tells one specialist how to do one task.** Each skill is a folder
in the [agentskills.io](https://agentskills.io) format: a `SKILL.md` with a
name and a description, and the files that its steps use. The model sees the
name and the description of each skill in its guidance. It reads the rest
when the task matches. Ambion's
[skills page](https://github.com/ambionframework/ambion/blob/main/docs/skills.md)
holds the contract.

## Where each part lives

| Part       | Where                          | What it holds                                                 |
| ---------- | ------------------------------ | ------------------------------------------------------------- |
| The skills | `skills/<specialist>/<skill>/` | `SKILL.md`, and any scripts, macros, references, and assets   |
| The shared | `skills/shared/<skill>/`       | A skill that every specialist receives                        |
| The loader | `src/domain/skills.ts`         | `specialistSkills`, which reads two folders with `loadSkills` |
| The worker | `src/domain/skills.ts`         | `workerSkills`, which reads the folders of the Researcher     |
| The wiring | `src/domain/definitions.ts`    | `workspace.tools({ skills })` in each specialist and worker   |
| The check  | `test/skills.test.ts`          | The folders, the guidance, and the copy into the home         |
| The macros | `test/skill-macros.test.ts`    | Each macro in a scripted room, and the guidance that lists it |

**Each specialist has its own folder.** The folder name is the name of the
specialist.

**The folder `skills/shared/` holds the skills of every specialist.** It
holds `keep-notes`. A specialist receives its own skills and the shared
skills. A skill of the specialist replaces a shared skill of the same name.
The folder `shared` names no specialist.

**The worker of a breakout room has no folder.** `workerSkills` gives it
the skills of `skills/shared/` and of `skills/researcher/`. No skill of
these two folders drives a device, and the worker has no access to the
devices. A skill that drives a device goes in the folder of the Engineer.
[Breakout rooms](breakouts.md) describes the worker.

## How a specialist reads a skill

1. The host reads each folder once, when it opens the rooms. A skill that
   breaks a rule of agentskills.io stops the start with an error that names
   the file.
2. At the start of each respond activation, the workspace makes `~/.skills` in the
   home of the specialist hold the files of its skills.
3. The specialist reads `~/.skills/<skill>/SKILL.md` with `read`, and runs a
   script of the skill with `bash`.

**A skill and a template do different jobs.** A skill is the same for every
activation, and the specialist does not change it. A template is a
repository that the specialist forks and changes. A skill can tell the
specialist to fork a template. The instructions of the specialist name the
skills, and the skill names the template.

## Add a skill

1. Make a folder `skills/<specialist>/<skill>/`, or `skills/shared/<skill>/`
   for a skill of every specialist. The name has 1 to 64
   characters of `a-z`, `0-9`, and single hyphens.
2. Add a `SKILL.md`. It starts with a frontmatter that holds `name`, which
   equals the folder name, and `description`. The description states the task
   and when to use the skill.
3. Write the steps as a numbered list. Put a script in `scripts/`, and
   start it with a `#!` line.
4. Name the skill in the instructions of the specialist in
   `src/domain/definitions.ts`, when a rule must hold on every activation.
5. Run `pnpm test`. `test/skills.test.ts` checks each folder and each
   description.

**A script runs in the shell of the specialist.** On a workstation, it runs
as the account of the specialist, with the programs of the server. Write
each script for the programs that the workstation has. The host reads the
bytes of each file, so an asset can be binary.

## Add a macro

**A macro is a script that chains workspace tools in one call.** It lives in
`skills/<specialist>/<skill>/macros/<name>.js`. Ambion reads it with the
skill. The seat guidance lists each macro with its description. A seat runs
it with `compose({ macro: '<skill>/<name>', args })`.

**The file starts with a header in a block comment.** The line `/*---`
opens it and the line `---*/` closes it. Between them is YAML with three
fields:

- `description`: what the macro does and returns.
- `uses`: the list of tool names that the macro calls.
- `args`: a JSON Schema object for the arguments.

The rest of the file is the body of an async function. It reads the global
`args`, and calls a tool as `await tools.<name>({ ... })`. The call returns
the typed `details` of the tool. The body has no clock and no I/O except
tools. It returns a JSON value. A process tool (`bash`, `wait`, `cancel`)
rejects when the process ends with a code other than 0. The error holds the
result in `details`.

**A macro may use only a tool that every seat of the skill has.** Ambion
stops the start when a macro names a missing tool. The `fetch` tool exists
only on a backend with endpoints, so the just-bash backend of the tests has
no `fetch`. A macro that uses `repos` needs a backend with a git server.

**Choose the form by the judgment that the procedure needs:**

| The procedure                                              | The form               |
| ---------------------------------------------------------- | ---------------------- |
| Chains workspace tools, with no judgment between the calls | A macro                |
| Runs in the shell only                                     | A script in `scripts/` |
| Needs judgment, or needs the person                        | Prose in `SKILL.md`    |

Test each macro in `test/skill-macros.test.ts`. The test runs the macro
with `compose` in a scripted room.
