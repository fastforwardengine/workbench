# Notes

**The notes are one git repository that every specialist commits to.** They
hold what the team concludes from the library and from its readings: the
facts of the bench, the decisions, and the questions that stay open. A
disagreement between two seats lives on a branch until evidence or the
person settles it.

**Status: implemented.** Ambion 0.5.0 registers `shared/notes` on the local
and workstation backends. The package supplies the first files. Registration
keeps all later commits and branches when Workbench starts again.

## The library and the notes

**The library holds what comes in. The notes hold what the team decides.**

| Part      | Holds                                                        | Who writes                   |
| --------- | ------------------------------------------------------------ | ---------------------------- |
| `library` | Datasheets, the kit manual, the schematic, and their figures | The package, at each start   |
| `notes`   | Facts, decisions, and questions, each with its source        | Every specialist, by commits |
| Templates | The starting files of a task                                 | The package, at each start   |
| Snapshots | The bytes of a file, such as a reading, a frame, or a clip   | Any seat, with `snapshot`    |

- **The library is read-only.** On a workstation, the mode of `/library`
  (2750, owned by the host account) keeps a seat from writing there. On the
  local directory backend nothing stops a write, and the host rewrites
  `/library` at each start, so an edit does not last. A conclusion from a
  datasheet goes into the notes, with the library file as its source.
- **A note cites the library, and the library never cites a note.** A
  library file states its own conflicts and open points. The notes settle
  them.
- **The notes hold no raw data.** A reading, a frame, or a clip goes in as a
  snapshot ref. The note cites the ref.

## How a seat reaches the notes

1. `repos` lists `shared/notes` with its description.
2. `clone` puts a working copy in the home, such as `~/notes`. The `origin`
   of the clone accepts pushes from every seat.
3. The seat works with `git` in `bash`, and with `read`, `write`, and `edit`.
4. A push persists the work. A seat pushes before it finishes.

The `keep-notes` skill states the loop below. No tool enforces the layout.
The conventions live in the notes themselves, in `README.md`, and every seat
reads that file first.

**A specialist adds to the notes by default.** A specialist stops when the
person tells it not to edit files.

## The layout

**The folders follow the subject.** A note has one home, and every seat
edits it there.

```text
notes/
  README.md           the conventions, and who looks after each folder
  parts/              one file for each part: stc8g1k17.md, rda5807fp.md
  circuit/            nets and blocks: power.md, i2c.md, display.md, buttons.md
  instruments/        one file for each device: hm310p.md, brio.md
  radio/              what the radio does: bands.md, stations.md, current.md
  build/              one file for each kit: the plan and record of steps
  plans/              one file for each test plan
  decisions/          one file for each decision, named by date and subject
  questions/          one file for each open question
```

**Each folder has a steward.** Anyone writes anywhere. The steward keeps
the format of the folder, splits a file that grows long, and merges
duplicate claims with their sources intact. The steward settles the
disputes of its area when evidence exists.

| Folder                             | Steward    |
| ---------------------------------- | ---------- |
| `parts/`, `circuit/`, `plans/`     | Researcher |
| `instruments/`, `radio/`, `build/` | Engineer   |
| `decisions/`, `questions/`         | Researcher |

The assistant has no file or git tool. It cites the commits and the
branches of the notes in its summaries.

## A note

**A note file has a title and a list of claims.** One claim is one bullet.
The bullet holds the statement, its source, and its confidence. Git holds
the time. The commit author is the seat, and the seat sets it: a seat runs
`git config user.name <its name>` in its clone. On a workstation the git
account names the agent only in the reflog.

```markdown
# STC8G1K17

- **The four buttons sit on P3.1, P3.0, P5.4, and P5.5** (V−, V+, CH−, CH+).
  Source: library/fm-radio-kit-schematic.md. Confidence: medium.
- **P5.4 is also the reset pin, when a download enables it.**
  Source: library/stc8g1k17.md. Confidence: medium.
```

| Field      | Rule                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| Statement  | One fact, in plain language. A value carries its unit                                                 |
| Source     | A library path, a snapshot ref, a commit ref, or a message ref (`ambion://room/<room>/message/<seq>`) |
| Confidence | `high`: a reading or a cited photo. `medium`: a datasheet or a schematic. `low`: a guess              |

**A measurement counts only when a script read it from a device.** The
source is the snapshot ref of the file that the script wrote. Every other
value is a planned value, and the claim says so.

**A claim of the person cites the room message** in which the person said
it. The confidence is `high` for what the person did or saw, and `medium`
for what the person remembers.

## The loop of a seat

1. **Pull, and read.** Read `README.md` and the folder for the task. To see
   what changed since the last look, run `git log --since` or
   `git diff <last seen>..origin/main`.
2. **Write small.** Add a claim, or change a claim of your own. Commit at
   each step.
3. **Name the commit.** Use the form `<folder>: <what and why>`, such as
   `circuit: buttons on P3.1, P3.0, P5.4, P5.5`.
4. **Push.** When git rejects the push, pull with rebase and push again.
   Two seats that edited the same lines get a merge conflict. The seat that
   meets it keeps both edits and pushes.
5. **Cite.** Put the commit ref in `refs` of the message that relies on
   the note. The terminal opens a commit ref.

## Disputes

**A disagreement is a branch.** Two sources can give two values for one
fact: a datasheet against a reading, or the camera against the person. The
notes keep both until evidence settles it.

- **Never rewrite or delete the claim of another seat on `main` to settle a
  disagreement.** `main` keeps the claim that stands. Only a resolution
  merge replaces it.
- **A seat that disagrees pushes a branch** named `dispute/<topic>`, such
  as `dispute/i2c-address`. The branch holds the seat's own claim, its
  source, and the claim it disputes, cited by path. It stops at this claim.
- **Any seat adds evidence** by committing to the branch. The branch is the
  thread of the dispute.
- **The open disputes are the unmerged branches.**
  A seat lists them after `git fetch`: `git branch -r` shows every
  `origin/dispute/*` branch, and `git log origin/main..origin/dispute/<topic>`
  prints the commits that `main` lacks. An empty result means the dispute
  is resolved. A seat reads the list before it acts on a topic. The
  `repos` tool shows only the first five branches, so use `git`.
- **A dispute stays open** until evidence or the person settles it.
  The steward of the area does not settle it by preference.
- **A dispute branch stays by convention.** Every specialist must keep it
  and must not force push it. Ambion refuses deletion and non-fast-forward
  pushes on the default branch. It permits those operations on other branches.

**A resolution is a merge.** The merge commit names the winner and its
evidence in its message. The commands below work in the shell of every seat,
including the just-bash `git`, which lacks `merge -s` and `--no-commit`.

| Outcome                    | The commits                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| The branch is right        | `git merge --no-ff origin/dispute/<topic>`. Keep the claim of the branch when the merge conflicts |
| `main` is right            | The same merge, then a second commit that removes the claim of the branch and cites the evidence  |
| Both hold, in two contexts | The same merge, with both claims kept and the context of each stated                              |

The message of the resolving commit begins `resolved:` and cites the
evidence, such as a snapshot ref of a reading or the room message in which
the person decided. A resolution that rests on preference is invalid.

**The person decides what evidence cannot.** A choice of limit, a risk to
accept, or a preference is the person's. The person says so in the room.
The steward records the message ref in the merge commit.

## What stays out of the notes

- **Raw readings, frames, and clips.** They are snapshots. A note cites the
  ref.
- **The record of the room.** The journal keeps it. A note keeps the
  conclusion, and cites the message.
- **Secrets.** No key, token, or password.
- **Source documents.** They belong to the library.

## The first content

**The package supplies claims from the library and its open questions.**
The files in `notes/` use the subject folders above.

**The repository starts from the packaged notes.** Registration does not
migrate the earlier workspace state. Registration seeds the repository only
once. Later starts keep its commits and branches. New claims go into `shared/notes`.
`/shared/kit.md` holds the project and house rules.

## Later

- **A notes panel in the terminal:** the recent commits, the open disputes,
  and the questions.
- **A reminder for a seat** that lists the commits since its last look.
- **A wake on push:** a change to the notes wakes the seat it concerns.
  Ambion has no push hook yet, so the host can poll the tip of `main` and
  call `room.post`.
