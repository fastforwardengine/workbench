# Workbench: an agentic lab workspace

A shared workspace where humans and specialized agents collaborate on
electrical engineering, hardware, and electrochemistry — from technical
questions and designs to experiments and measured results.

This is the initial scaffold of Workbench. It runs on
[Ambion](https://github.com/ambionframework/ambion), the collaboration
kernel, at its 0.1.0 release. The layout and the terminal follow
[Ambion's own runnable example](https://github.com/ambionframework/ambion/tree/main/examples/workbench),
with a lab domain of its own: one bench battery-characterization kit, five
specialists, and a place for the Instruments and Data Analysis specialists
to grow into once their resources exist.

## Specialized agents

| Agent                   | Scope of responsibility                                                                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Datasheets Agent**    | Find and interpret datasheets, manuals, application notes, and chemical safety data sheets. Compare specifications, identify operating limits, and cite exact sources and revisions.                                  |
| **Design Agent**        | Develop and troubleshoot circuits, assemblies, materials, and formulations. Perform calculations and simulations, propose changes, and explain tradeoffs and failure hypotheses.                                      |
| **Experiments Agent**   | Turn questions into test plans. Define procedures, variables, controls, measurement requirements, and acceptance criteria. Coordinate execution and recommend follow-up tests.                                        |
| **Instruments Agent**   | Configure and operate connected equipment within approved procedures and limits. Check readiness, monitor runs, capture instrument settings and measurements, and request physical setup or intervention from humans. |
| **Data Analysis Agent** | Convert measurements into reproducible results. Check data quality, visualize signals, fit models, quantify uncertainty, and compare runs against expectations.                                                       |

**The Instruments and Data Analysis agents wait on a resource this scaffold
does not build yet:** a live equipment connection, and analysis tooling.
Each holds only the workspace tools today, and its instructions say so
plainly to a person, instead of claiming a reading or a fit it cannot back.
Give each its own resource, on the pattern of `src/domain/instrument.ts`, to grow
it into the role its identity already names.

## User-facing assistant

The Assistant is the user's primary point of contact. It understands the
request, brings together the right specialists, and communicates the
outcome.

- **Clarify:** Establish the goal, relevant context, and constraints. Ask
  questions only when needed.
- **Select:** Assign the smallest useful set of agents and provide a clear
  brief.
- **Stay available:** Surface meaningful progress, blockers, and requests
  for human input or approval.
- **Steer exceptionally:** Let specialists collaborate directly. Intervene
  only when the conversation stalls, drifts from the goal, or needs a
  decision about scope or ownership.
- **Synthesize:** Return a concise answer covering results, supporting
  evidence, unresolved questions, and recommended next steps. Preserve
  material uncertainty and disagreement.

Technical responsibility remains with the specialists; priorities and
consequential decisions remain with humans.

## Shared workspace

Agents collaborate through shared projects, designs, test plans, runs,
samples, equipment records, and results. Scheduling, task ownership, and
history are workspace capabilities.

Users can address a specialist directly or give the Assistant a goal.
Either way, the work produces traceable artifacts and a clear result
without requiring the user to manage every agent interaction.

## Run

**One command starts the rooms and the terminal in one process.** The
rooms run while the terminal runs. When you quit, the host ends your visit
and closes the rooms. The journals stay on disk.

Install with Node 26.4 or later, and set a provider key:

```sh
pnpm install
cp .env.example .env   # then fill in ANTHROPIC_API_KEY, or OPENAI_API_KEY, or both
pnpm start                    # uses ./.data
pnpm start ./bench --as priya   # a directory, and a person
```

`pnpm start` runs Node with `--experimental-ffi`, which OpenTUI needs. A
directory with no `rooms.db` gets the three sample rooms and the
datasheets. A directory that has one resumes its rooms, including a room
you created and a room you stopped.

Workbench adds one person named for the account running it (see
[The team](#the-team)), and opens straight to that person. Set `WORKBENCH_USER`,
or pass `--as <person>`, to open as someone else instead.

**`WORKBENCH_MODEL` switches every seat between providers.** `WORKBENCH_MODEL=anthropic`
runs `anthropic/claude-sonnet-5`, and needs `ANTHROPIC_API_KEY`.
`WORKBENCH_MODEL=openai` runs `openai/gpt-5.6-luna`, and needs `OPENAI_API_KEY`.
Any other value passes through as a full Pi model id,
`provider/model-id`, for a provider these two presets do not name. The
default is the `anthropic` preset. `src/domain/families.ts` holds both presets.

**A seat with no key does not run, and the others do.** At start, Fast
Forward Engine prints one line for each seat whose family has no key. The
header of the terminal marks that seat with `no key`. An activation of that
seat fails at once with the name of the missing variable, and the room
keeps running.

## The team

**One assistant coordinates five specialists, and every seat runs on Pi
today.** The assistant answers ordinary messages, brings in a specialist,
and writes the closing summary.

| Agent             | Scope                                                              | Family | Resource today             |
| ----------------- | ------------------------------------------------------------------ | ------ | -------------------------- |
| **Assistant**     | Understands the request, seats a specialist, and returns a summary | Pi     | Workspace, lab, instrument |
| **Datasheets**    | Reads `/library` and states exact limits with their source         | Pi     | Workspace, lab, instrument |
| **Design**        | Chooses parts and values, and shows the calculation                | Pi     | Workspace, lab, instrument |
| **Experiments**   | Turns a question into a short, repeatable test plan                | Pi     | Workspace, lab, instrument |
| **Instruments**   | Names what a person must do by hand; no equipment connected yet    | Pi     | Workspace only             |
| **Data Analysis** | Names the metric to read by hand; no analysis tooling yet          | Pi     | Workspace only             |

Every seat shares one model, the one `WORKBENCH_MODEL` selects. A specialist
that needs its own model, or a different provider's agent loop entirely
(`@ambionframework/claude` or `@ambionframework/codex`, for a
reasoning-effort control Pi does not expose), can move there;
`src/domain/families.ts` is the one place that assignment would change. See the
Ambion documentation for every executor.

### One tool set, one filesystem, no native tool

**Every full specialist holds the same tools and reaches the same
filesystem, and Pi has no native tool of its own.** One list of bundles
serves the assistant and the four full specialists: the workspace, the
lab, and the instrument tools, in that order. All seats share one
workspace instance, so a file that one agent writes is the file that
another agent reads.

`test/tool-set.test.ts` checks this on the scripted tier. The live test
`test/live/tool-set.test.ts` asks each seat for its tool list, writes a
file with one seat and reads it with another, and asks each seat for
`/etc/hosts`.

## Tests

**The scripted tier needs no key and no network.** Run it with
`pnpm test`. It gives the Pi seats a scripted model stream.

**The live tier runs each scenario on the real Pi family.** Run it with
`pnpm test:live`. It costs money. Treat every live run as spend: run the
smallest thing that answers the question, and prove the scripted tier
first. The whole live tier skips when no key is set.

## The rooms

**Three rooms share one kit.** Each goal shows a distinct collaboration
pattern. Each room offers a suggested prompt.

| Room               | Pattern                           | Starting work                                                     |
| ------------------ | --------------------------------- | ----------------------------------------------------------------- |
| `characterization` | Datasheet check → design decision | Discharge-test the 18650 cell and choose its load resistor        |
| `cycling`          | Design → test plan                | Plan a charge and discharge cycling test with a thermocouple      |
| `budget`           | Datasheet check → power budget    | Add up the standby current and confirm the charge module's margin |

## The workspace

**Every room shares one directory workspace.** It holds the datasheets and
the team's artifacts.

```text
.data/
  rooms.db          Room journals and the host room catalog
  lab.db            The projects, test_plans, runs, results, and operations tables
  workspace/
    library/        The datasheets, copied from library/
    shared/         kit.md and notes.md, the team's artifacts
    home/           Agent home directories
```

The datasheets are simplified summaries for a runnable scaffold. They are
not the manufacturer datasheets. This project connects no real hardware or
instruments yet, so every measurement is a planned value.

## What persists

**Room journals and workspace files have separate owners.** Each room has
its own journal. All rooms share one workspace resource. A deliberately
stopped room stays stopped across a restart. The host restores previously
running rooms with the same definitions.

The terminal sends each message with a key. A retry uses the same key, so
a lost acknowledgement adds no duplicate message. This does not make tool
effects exactly once: SQLite records and file changes are not one
transaction.

## Restart

1. Send a message and wait for its acceptance.
2. While an agent works, quit with `/quit`, or stop the process.
3. Run `pnpm start` with the same directory.

A crash writes no departure. A reconnecting join restores the visit
without another arrival. The default lease expiry is 60 seconds, so lost
local work can pause before it continues.

The person picker is a local convention, not authentication. A deployed
application must authenticate people and control access to rooms and
workspace resources.

## Layout

**`src/` is laid out in layers, and an import points down only.** Biome
refuses the rest (see `biome.jsonc`).

```text
domain/     the vocabulary: people, specialists, rooms, the lab schema, the instruments
view/       formatting the record for display: text, steps, a timeline, refs, a database preview
host/       what a host owns: the room catalog, approvals, files, the Lab facade — over domain and view
terminal/   the OpenTUI terminal: session state and every widget — over host, domain, and view
main.ts     the entry point, which composes domain and terminal
```

## Files

| File                           | What                                                               |
| ------------------------------ | ------------------------------------------------------------------ |
| `src/domain/definitions.ts`    | The assistant, the five specialists, and the people                |
| `src/domain/families.ts`       | The executor family and the key of each seat                       |
| `src/domain/scenarios.ts`      | The rooms, the workspace seed, the lab schema, and the instruments |
| `src/domain/instrument.ts`     | The simulated bench instruments and their approval step            |
| `src/view/text.ts`             | One line of text fitted to a width, with an ellipsis               |
| `src/view/steps.ts`            | The steps of an activation, and the cost of a run                  |
| `src/view/timeline.ts`         | The record grouped into questions, threads, and summaries          |
| `src/view/refs.ts`             | The refs of a message: parse, resolve, and one chip                |
| `src/view/database.ts`         | The SQLite preview: tables and their first rows                    |
| `src/host/names.ts`            | The room name and goal rules                                       |
| `src/host/unavailable.ts`      | The execution of a family that has no key                          |
| `src/host/approvals.ts`        | The instrument operations that wait for an answer                  |
| `src/host/rooms.ts`            | The host lifecycle and the room catalog                            |
| `src/host/files.ts`            | The workspace list and one file preview                            |
| `src/host/host.ts`             | The host API the terminal calls in process                         |
| `src/terminal/session-text.ts` | The terminal's fixed text: help, done messages, an empty room      |
| `src/terminal/attention.ts`    | What a person owes the room: replies and approvals                 |
| `src/terminal/feed.ts`         | The room feed: one read at a time                                  |
| `src/terminal/commands.ts`     | The slash commands and their suggestions                           |
| `src/terminal/session.ts`      | The terminal state and commands, without OpenTUI                   |
| `src/terminal/header-fit.ts`   | What the header rows show at one width                             |
| `src/terminal/brand.ts`        | The product name and the terminal palette                          |
| `src/terminal/composer.ts`     | The composer, room chip, and palette                               |
| `src/terminal/palette.ts`      | The palette state: rows, the picked row, and dismissal             |
| `src/terminal/browser.ts`      | The files panel state: search, matches, chosen file                |
| `src/terminal/files-panel.ts`  | The files panel beside the conversation                            |
| `src/terminal/header.ts`       | The panel above the conversation: room, goal, people, pattern      |
| `src/terminal/transcript.ts`   | The conversation, with open and closed threads                     |
| `src/terminal/draw.ts`         | The painter: header, conversation, and composer chrome             |
| `src/terminal/keys.ts`         | The input: mode, browse selection, and key routing                 |
| `src/terminal/tui.ts`          | The terminal: layout, keys, and the run loop                       |
| `src/main.ts`                  | The entry point                                                    |
| `library/`                     | The datasheets                                                     |

## Toolchain

**`pnpm check` is the gate: format, then types, then lint, then test.**
Run it, and `pnpm format`, before every push.

| Command             | Purpose                                                |
| ------------------- | ------------------------------------------------------ |
| `pnpm check`        | `check:format` → `check:types` → `check:lint` → `test` |
| `pnpm format`       | Apply Biome's fixes, then Prettier's                   |
| `pnpm check:format` | Verify Prettier formatting                             |
| `pnpm check:types`  | `tsc --noEmit`                                         |
| `pnpm check:lint`   | Biome, with warnings as errors, then Knip              |
| `pnpm test`         | The scripted tier                                      |
| `pnpm test:live`    | The live tier; costs money                             |

Biome lints (`biome.jsonc`) and enforces the layering above with
`noRestrictedImports`, one override per layer; Prettier formats
(`prettier.config.js`): tabs, single quotes, width 100, semicolons. Knip
(`knip.json`) finds an export or a dependency nothing reaches. No
explicit `any`, no non-null assertion, no unused import or variable, and
cognitive complexity stays at 10 in source, 15 in tests — the same limits
[Ambion](https://github.com/ambionframework/ambion) holds itself to
(`docs/toolchain.md` §7 in that repository).

## What is next

This is a scaffold, not the finished lab. The natural next steps, in
order:

1. **Build the Instruments resource.** A real equipment connection, on the
   pattern of `src/domain/instrument.ts`, behind the same `operate` and
   `approve_operation` tools, or a new pair suited to a live driver.
2. **Build the Data Analysis resource.** A fit, a plot, or a data-quality
   check over the `results` table, exposed as a tool bundle.
3. **Grow the terminal.** `/files` already renders a Markdown datasheet and
   a SQLite table; a plotted result or an image preview is the natural
   next panel.
4. **Widen the kit.** The library, the lab schema, and the rooms describe
   one bench project. A second project is a second set of library files
   and a second `scenarios.ts` entry, not a new mechanism.

## License

Apache License 2.0. See [`LICENSE`](LICENSE).
