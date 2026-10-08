---
name: guide-a-build-step
description: Guide the person through one step of a build, with the parts, the places, the orientation, and the check. Use it when a person starts or continues the assembly of a kit.
---

1. Follow the `keep-notes` skill to get `~/notes` and to pull. Read
   `~/notes/build/README.md` for the format, and `~/notes/build/<kit>.md`
   for the kit. When the file does not exist, create it with the title
   `# Build: <kit>`. When the file has no plan for the step, fill it from the
   datasheets in `/library` and the photos of the kit. Mark each value that
   you cannot give with `TBD`.
2. Give one small step at a time: find the next step that is not done.
   Tell the person its parts, with the name and the value of each, the
   place of each part (the silkscreen label), and its orientation.
3. Name the risk of the step: heat, reversed polarity, or a short between
   pins. Say what the person does first, such as switching the power off.
   The power stays off until the person confirms the checks of the step.
4. Ask the person to do the step and to report, and say what the person
   must check before the next step. For a polarized part, run the check of
   step 5 before the person solders it. Do not go on until the person says
   that the step is done.
5. Run the check of the step. For a polarized part, apply `check-a-photo`:
   read `~/.skills/check-a-photo/SKILL.md`.
6. Record in `~/notes/build/<kit>.md` at once only a failed check, a
   reading, or a change from the plan. When the person pauses or the build
   ends, set the State of the finished steps. Add the Evidence refs of the
   checked steps: the snapshot refs of the photos in the room. Skip this
   when the person told you not to edit files.
7. When you changed the file, commit and push it with the `keep-notes`
   skill. A push keeps the work.
