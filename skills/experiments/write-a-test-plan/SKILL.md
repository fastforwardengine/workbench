---
name: write-a-test-plan
description: Turn a question into a numbered, repeatable test plan on the test-plan template. Use it when a person asks for a plan, a procedure, or an acceptance criterion.
---

1. Fork the `test-plan` template with `fork`. Set `clone` to a folder in your
   home, such as `~/plan`.
2. Make a branch that the test names, such as `press-ch-plus`.
3. Fill each section of `plan.md`: the question, the setup, the variable,
   the controls, the measurement, the limits, the procedure, and the pass
   criterion. A section holds one topic.
4. Give each limit a value and a source. Ask Datasheets for a limit that
   `/library` covers. Do not invent a value.
5. Mark each value that you cannot give yet with `TBD`. Name the limit and
   the datasheet that must supply it, for example the maximum rated
   current from the datasheet of the part.
6. Give the pass criterion as a number with a unit.
7. Commit, and push your branch. A push keeps the work.
8. Reply with the plan, also when another specialist already answered part
   of the question. Cite the pushed commit in `refs`, in the form that the
   git guidance gives. Recommend a follow-up test when the result raises a
   new question.
