# CLAUDE.md

Guidance for Claude Code in this repository.

## Project

Workbench is a shared workspace where humans and specialists collaborate
on electrical engineering, hardware, and electrochemistry. It runs on
[Ambion](https://github.com/ambionframework/ambion), the collaboration
kernel, and follows Ambion's own runnable example (`examples/workbench`)
with a lab domain of its own: one bench battery-characterization kit,
five specialists, and an assistant that coordinates them.

pnpm workspace, ESM only, TypeScript, Node 26.4 or newer (the OpenTUI
floor).

| Path           | What                                                                             |
| -------------- | -------------------------------------------------------------------------------- |
| `src/domain`   | The lab domain: instruments, operations, model families, scenario definitions    |
| `src/view`     | Read-only projections over the room journal: the timeline, steps, refs           |
| `src/host`     | The room host: rooms, approvals, file handling, name assignment                  |
| `src/terminal` | The OpenTUI terminal: layout, keys, the composer, the transcript                 |
| `docs/`        | Design pages, such as `instrument.md`, the instrument driver interface           |
| `planning/`    | `decisions.md` (why, in order), `backlog.md`, `status.md` — read before a change |

Import rules run upward only: `domain` and `view` are independent leaves;
`host` depends on both; `terminal` depends on all three. Biome holds this
with a `noRestrictedImports` override per layer. Cognitive complexity: max
10 in source, 15 in tests. No explicit `any`, no non-null assertion, no
unused import or variable.

## Commands

- `pnpm start` — run the terminal.
- `pnpm check` — format, types, lint, and the scripted test tier, in that
  order.
- `pnpm test` — the scripted tier: no key, no network.
- `pnpm test:live` — the live tier: needs a real model key.
- `pnpm format` — write formatting and lint fixes.

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
   **specialist** is a named agent role (Datasheets, Design, Experiments,
   Instruments, Data Analysis); a **family** is the executor a seat runs on
   (Pi, Claude, Codex); a **resource** is a shared tool implementation
   (workspace, lab, instrument). Do not use "agent" where "specialist" or
   "seat" names the thing more exactly.
5. **Simple tenses.** Present for how things work, imperative for
   instructions.
6. **Keep articles and relative pronouns.** "The seat that waits", not
   "seat waits".
7. **No noun clusters over three words.** Break them with prepositions.
8. **No slang, no metaphor, no ellipsis.** State the mechanism.

Also: state facts, not claims. If a command or feature does not exist yet,
say so plainly. Wrap Markdown prose at about 78 columns; Prettier preserves
it.

Optimize every page for a human scanning it:

- A bold lead names each point. A reader of only the bold leads gets the
  page's claims.
- An enumeration is a bulleted or numbered list. Tabular facts are a table.
- A paragraph stays under six lines of prose. Split at the natural break.
- A diagram is welcome when it shows the mechanism. GitHub renders Mermaid.

### Voice

Write to get the job done. Do not educate, persuade, or lecture along the
way. The reader wants the mechanism, once, and then the next mechanism.

The reader has built an agent and has not yet met the scaling problems
Ambion tackles. Ground a claim in what they have lived, then extrapolate
to the scale they have not. Keep the field's vocabulary; do not flatten it
to plain English.

- Banned words: "load-bearing", "seam".
- No contrastive framing as a rhetorical device: avoid "X, not Y",
  "X rather than Y", "X instead of Y", "X — never Y". Say what a thing is
  or does. A plain negative fact is fine when the reader needs it ("A
  human has no tools").
- Do not restate a point in a second formulation. One statement per point.

`README.md`, `docs/`, and `planning/` follow these rules. Hold every edit
to the same standard.
