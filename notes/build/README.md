# Build

One file for each kit: `build/<kit>.md`, such as `build/first-kit.md` and
`build/second-kit.md`. The file holds the plan of each step and its record.
The Engineer guides the build of the first kit by voice, with the
microscope. The team guides the build of the second kit with every sensor.
The Engineer keeps the files, with the `guide-a-build-step` skill.

## Format

Start the file with the title `# Build: <kit>`. Then write these sections.

**Before you start.** List the tools. State the safety rule: the power stays
off until the checks of the build pass.

**One section for each step, `## Step <n>: <title>`.** A step is small: the
person does it in a few minutes, and checks it before the next one. The
section holds a plan and a record.

| Plan or record | Holds                                                       |
| -------------- | ----------------------------------------------------------- |
| Plan           | A table of the parts: name, value, place, orientation, mark |
| Plan           | `Risk:` the hazard of the step, such as heat or a short     |
| Plan           | `Check:` what the person can verify before the next step    |
| Record         | `State:` `todo`, `done`, or `blocked`                       |
| Record         | `Evidence:` a snapshot ref of a photo, or a reading         |

**First power-on.** Give the source of power, the expected current from the
datasheets, and the current limit of the supply. Stop at once when the
current reaches the limit. A source with no set limit, such as USB, needs a
stop rule: the signs that stop the power at once.

## Rules

- **Give each part its place.** The place is the silkscreen label of the
  board.
- **Give each polarized part its orientation and its mark.**
- **Cite each value.** Give the datasheet in `library/` for each value and
  each orientation.
- **Mark a missing value `TBD`.** Replace it when the datasheet or a photo
  supplies it.
- **Set `State: done` only with evidence.** Cite the snapshot ref.
