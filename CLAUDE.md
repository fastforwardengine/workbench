# CLAUDE.md

Guidance for Claude Code in this repository.

## Project

Workbench is a shared workspace where humans and specialists collaborate
on electrical engineering, hardware, and electrochemistry. It runs on
[Ambion](https://github.com/ambionframework/ambion), the collaboration
kernel, and follows Ambion's own runnable example (`examples/workbench`)
with a lab domain of its own: a bench with a programmable supply, a
camera, and two specialists. The milestone is an FM radio that the team
helps build and then controls.

pnpm workspace, ESM only, TypeScript, Node 26.4 or newer (the OpenTUI
floor).

| Path           | What                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/domain`   | The lab domain: the person, the specialists, the room, the model, templates, skills                            |
| `src/view`     | Read-only projections over the room journal: the timeline, steps, refs                                         |
| `src/host`     | The room host: rooms, file handling, processes, name assignment                                                |
| `src/terminal` | The OpenTUI terminal, in `state/`, `widgets/`, and `app/`. The next paragraph names the rule                   |
| `templates/`   | The git templates that a specialist forks. `docs/templates.md` holds the pattern                               |
| `skills/`      | One folder of skills for each specialist, and `shared/` for all. `docs/skills.md` holds the pattern            |
| `seed/`        | The files of a new workspace, by workspace path: `seed/shared/kit.md` is `/shared/kit.md`                      |
| `notes/`       | The first files of the team notes, the shared git repository `shared/notes`. `docs/notes.md` holds the pattern |
| `workstation/` | The workstation: `macos/` runs the bash and git backends on the Mac. The container is the old path             |
| `docs/`        | Design pages, such as `templates.md`, the git templates                                                        |
| `planning/`    | `next.md` (the milestone and its activities) and `fm-radio.md` — read before a change                          |

Import rules run upward only: `domain` and `view` are independent leaves;
`host` depends on both; `terminal` depends on all three. Biome holds this
with a `noRestrictedImports` override per layer. Inside `src/terminal`,
`state/` imports no OpenTUI, no widget, and no app file. `widgets/` imports
no app file. `app/` may import both. Cognitive complexity: max
10 in source, 15 in tests. No explicit `any`, no non-null assertion, no
unused import or variable.

## Commands

- `pnpm start` — run the terminal.
- `make` — run the terminal on the workstation of this Mac. The Mac is the
  workstation. `make mac-workstation` sets it up once, with sudo, and `make`
  stops with a message until then. `make workbench` runs the old container
  workstation in `workstation/`. The `Makefile` lists the other targets.
- `pnpm check` — format, types, lint, knip, the scripted test tier, and the
  `python` stage. The stage runs `ruff check` on the Python and the Python
  suites. It needs `ruff` and Python 3.11 or newer on PATH. The floor is the
  `target-version` in `pyproject.toml`. No tool formats the Python, because
  a fork starts with the files of its template. The stages run at once. A
  failed run reports every failed stage.
  Each step has a time limit of 300 s, and the Python suites 120 s. A step
  that runs longer stops with its process tree, and the stage fails. A test
  in the scripted tier has 5 s unless it sets its own limit.
- `pnpm check --changed` — the same stages on the files that differ from
  the merge base with `origin/main`, plus staged, unstaged, and untracked
  files. Use it after a small change, and run `pnpm check` before you
  finish. The types and knip stages stay whole. The tests are the ones that
  import a changed file. A change to a config file runs every stage in full.
  It needs `origin/main`: run `git fetch origin main`.
- `pnpm test` — the scripted tier: no key, no network. The Python suites run
  in `pnpm check`. A test that needs `python3` skips on a Python below the
  floor.
- `pnpm test:live` — the live tier: evals on `@ambionframework/simulator`.
  Needs a real model key, and costs money.
- `pnpm format` — write formatting and lint fixes.
- `pnpm build` — write the bundle of the npm package, `dist/main.mjs`.
- `pnpm release` — publish `@fastforwardengine/workbench` from this machine,
  and tag the commit (README, Release). It publishes to npmjs: run it only
  when the person asks for a release.

## Writing documentation

Write all documentation, code comments, and commit messages in **ASD-STE100
Simplified Technical English**. It is the controlled-language standard for
technical writing: one meaning per word, one instruction per sentence.

Rules that carry the most weight here:

1. **Active voice.** "The host seats a specialist", not "a specialist is
   seated".
2. **Short sentences.** Max 20 words for an instruction, 25 for a
   description.
3. **One topic per paragraph**, max 6 sentences.
4. **One word, one meaning.** Pick a term and keep it. This project reuses
   Ambion's vocabulary — **room**, **seat**, **exchange**, **activation** —
   and keeps Ambion's own meaning for each: a room is the shared journal; a
   seat is where one agent sits in it; an activation is the room waking one
   seat; an exchange is a person's question and every activation until the
   room goes quiet. This project adds its own terms on top: a
   **specialist** is a named agent role (Researcher, Engineer); a **resource**
   is a shared tool implementation (the workspace).
   Do not use "agent" where "specialist" or "seat" names the thing more
   exactly.
5. **Simple tenses.** Present for how things work, imperative for
   instructions.
6. **Keep articles and relative pronouns.** "The seat that waits", not
   "seat waits".
7. **No noun clusters over three words.** Break them with prepositions.
8. **No slang, no metaphor, no ellipsis.** State the mechanism.

State facts, not claims. If a command or feature does not exist yet, say
so plainly. Wrap Markdown prose at about 78 columns; Prettier preserves it.
Also:

- Banned words: "load-bearing", "seam".
- No contrastive framing as a rhetorical device: avoid "X, not Y",
  "X rather than Y", "X instead of Y", "X — never Y". Say what a thing is
  or does. A plain negative fact is fine when the reader needs it ("A
  human has no tools").
- Do not restate a point in a second formulation. One statement per point.

Read [`docs/writing.md`](docs/writing.md) before you edit `README.md`,
`docs/`, or `planning/`. It holds the page layout and the voice.
