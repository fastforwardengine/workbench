---
name: write-a-test-plan
description: Turn a question into a numbered, repeatable test plan in the notes of the team. Use it when a person asks for a plan, a procedure, or an acceptance criterion.
---

1. Follow the `keep-notes` skill to get `~/notes` and to pull. Read
   `~/notes/plans/README.md` for the format of a plan, when the file
   exists.
2. Write the plan in `~/notes/plans/<test>.md`. Name the file for the test,
   such as `press-ch-plus.md`.
3. Fill each section of the format: the question, the setup, the variable,
   the controls, the measurement, the limits, the procedure, and the pass
   criterion. A section holds one topic.
4. Give each limit a value and a source. Follow the cite-a-limit skill for a
   limit that `/library` covers. Do not invent a value.
5. Mark each value that you cannot give yet with `TBD`. Name the limit and
   the datasheet that must supply it, for example the maximum rated
   current from the datasheet of the part.
6. Give the pass criterion as a number with a unit.
7. Commit and push with the `keep-notes` skill. A push keeps the work.
8. Reply with the plan, also when another specialist already answered part
   of the question. Cite the pushed commit in `refs`, in the form that the
   git guidance gives. Recommend a follow-up test when the result raises a
   new question.
