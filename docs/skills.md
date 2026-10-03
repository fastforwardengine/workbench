# Skills

**A skill tells one specialist how to do one task.** Each skill is a folder
in the [agentskills.io](https://agentskills.io) format: a `SKILL.md` with a
name and a description, and the files that its steps use. The model sees the
name and the description of each skill in its guidance. It reads the rest
when the task matches. Ambion's
[skills page](https://github.com/ambionframework/ambion/blob/main/docs/skills.md)
holds the contract.

## Where each part lives

| Part       | Where                          | What it holds                                           |
| ---------- | ------------------------------ | ------------------------------------------------------- |
| The skills | `skills/<specialist>/<skill>/` | `SKILL.md`, and any scripts, references, and assets     |
| The loader | `src/domain/skills.ts`         | `agentSkills`, which reads one folder with `loadSkills` |
| The wiring | `src/domain/definitions.ts`    | `workspace.tools({ skills })` in each specialist        |
| The check  | `test/skills.test.ts`          | The folders, the guidance, and the copy into the home   |

**Each specialist has its own folder.** The folder name is the name of the
specialist. The assistant has no file or shell tool, so it has no folder.

## The skills today

| Specialist | Skill                    | Task                                                             |
| ---------- | ------------------------ | ---------------------------------------------------------------- |
| Researcher | `cite-a-limit`           | State a limit with its source, or say the library has none       |
| Researcher | `compare-parts`          | Compare the specifications of parts, and name the deciding limit |
| Researcher | `write-a-test-plan`      | Fill the `test-plan` template, and push it                       |
| Engineer   | `scan-the-bench`         | Find the devices with the `device-scan` template                 |
| Engineer   | `drive-the-power-supply` | Run a power supply with the `psu` template, within its limits    |
| Engineer   | `observe-the-camera`     | Capture and keep a camera frame with the `usb-camera` template   |
| Engineer   | `guide-a-build-step`     | Guide one step of a build, with the `build-procedure` template   |
| Engineer   | `check-a-photo`          | Check the placement and orientation of a part from a photo       |

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

1. Make a folder `skills/<specialist>/<skill>/`. The name has 1 to 64
   characters of `a-z`, `0-9`, and single hyphens.
2. Add a `SKILL.md`. It starts with a frontmatter that holds `name`, which
   equals the folder name, and `description`. The description states the task
   and when to use the skill.
3. Write the steps as a numbered list. Put a script in `scripts/`, and
   start it with a `#!` line.
4. Name the skill in the instructions of the specialist in
   `src/domain/definitions.ts`, when a rule must hold on every activation.
5. Add the skill to the table above.

**A script runs in the shell of the specialist.** On a workstation, it runs
as the account of the specialist, with the programs of the server. Write
each script for the programs that the workstation has. The host reads the
bytes of each file, so an asset can be binary.
