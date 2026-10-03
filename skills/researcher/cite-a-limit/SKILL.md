---
name: cite-a-limit
description: State a specification, rating, or operating limit of a part with its source, or compare two or more parts and find the limit that decides between them. Use it when a person or a specialist asks for a limit, a value from a datasheet, or which part fits a task.
---

1. List the files of the library with `ls /library`. Read `/library/README.md`
   when the list does not show the part.
2. Read the file of the part. Find the value, its unit, and the condition
   that the datasheet gives with it, such as the temperature.
3. State the value with its unit and its condition. Add the exact path of
   the file and the revision that the file names.
4. Cite the file in `refs`, as `file:///library/<file>`.
5. When the library does not hold the part or the value, say so. Name the
   datasheet that would answer. Do not estimate a value, and do not take
   one from memory.
6. When two files give different values for one limit, state both with
   their paths. Do not choose one.

## Compare parts

Use this section when a person asks which of two or more parts fits a task.

1. Apply the steps above to each part for each specification that the task
   needs.
2. Write one table. Each row is one specification, and each column is one
   part. Put the path of the source in the cell, beside the value.
3. Write `not in /library` in a cell that no file answers. Do not fill it.
4. Name the specification that decides. State the margin between the value
   and the requirement of the task.
5. Reply with the table and the decision. Cite each file in `refs`.
