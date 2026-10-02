---
name: guide-a-build-step
description: Guide the person through one step of a build, with the parts, the places, the orientation, and the check. Use it when a person starts or continues the assembly of a kit.
---

1. Read the build procedure. When there is none, fork the `build-procedure`
   template with `fork`, clone it into your home, and fill `steps.md` from
   the datasheets in `/library` and the photos of the kit. Mark each value
   that you cannot give with `TBD`.
2. Find the next step that is not done. Tell the person its parts, with
   the name and the value of each, the place of each part (the silkscreen
   label), and its orientation.
3. Name the risk of the step: heat, reversed polarity, or a short between
   pins. Say what the person does first, such as switching the power off.
4. Ask the person to do the step and to report. Do not go on until the
   person says that the step is done.
5. Run the check of the step. For a polarized part, apply `check-a-photo`:
   read `~/.skills/check-a-photo/SKILL.md`.
6. Record the step in `~/notes/build/` with the `keep-notes` skill: the
   step, its state, and the evidence, which is a snapshot ref or a reading.
   Skip this when the person told you not to edit files.
7. When you changed the procedure, commit and push your branch. A push
   keeps the work.
