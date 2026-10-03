---
name: cite-a-limit
description: State a specification, rating, or operating limit of a part with its source. Use it when a person or a specialist asks for a limit or a value from a datasheet.
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
