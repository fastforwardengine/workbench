# Notes of the team

**These notes hold what the team knows and decides about the FM radio
bench.** Every specialist reads them and commits to them. The library
(`/library`) holds the source documents and is read-only. A note cites the
library file that it rests on. The `keep-notes` skill states the git steps.

## Layout

| Folder         | Holds                                                 | Steward    |
| -------------- | ----------------------------------------------------- | ---------- |
| `parts/`       | One file for each part                                | Researcher |
| `circuit/`     | Nets and blocks: power, I²C, buttons, audio, display  | Researcher |
| `instruments/` | One file for each device on the bench                 | Engineer   |
| `radio/`       | What the radio does: bands, stations, current         | Engineer   |
| `build/`       | One file for each kit: the plan and record of steps   | Engineer   |
| `plans/`       | One file for each test plan                           | Researcher |
| `decisions/`   | One file for each decision, named by date and subject | Researcher |
| `questions/`   | One file for each open question                       | Researcher |

Anyone writes anywhere. The steward keeps the format of the folder, splits
a file that grows long, and merges duplicate claims with their sources
intact.

## A claim

The files of `plans/` and `build/` follow the format of the README of
their folder. In every other file, one claim is one bullet:

```markdown
- **The four buttons sit on P3.1, P3.0, P5.4, and P5.5.** Source:
  library/fm-radio-kit-schematic.md. Confidence: medium.
```

- **Source:** a `library/` path, a snapshot ref, a commit ref, or a room
  message ref (`ambion://room/<room>/message/<seq>`). Write the path of a
  library file as `library/<file>`. Cite a file that can change by its
  snapshot ref.
- **Confidence:** `high` for a reading or a cited photo, `medium` for a
  datasheet or a schematic, `low` for a guess.
- **A reading** is a value that the house rules of `/shared/kit.md` count.
  Cite its snapshot ref.
- **A claim of the person** cites the room message. Git records who wrote
  the claim and when.

## Disputes

**A disagreement is a branch.** Never rewrite or delete a claim of another
seat on `main`. Push a branch `dispute/<topic>` with your own claim and your
evidence. Any seat adds evidence by committing to the branch. Never rewrite
or delete a dispute branch.

**A resolution is a merge.** Run `git merge --no-ff origin/dispute/<topic>`
on `main`. When `main` was right, add a second commit that removes the claim
of the branch. The message begins `resolved:` and cites the evidence: a
snapshot ref of a reading, or the room message in which the person decided.
The person decides what evidence cannot. A resolution that rests on
preference is invalid.

## Out of the notes

Raw readings, frames, and clips are snapshots: the note cites the ref. The
journal keeps the record of the room: a note keeps the conclusion and cites
the message. No key, token, or password goes in a note.
