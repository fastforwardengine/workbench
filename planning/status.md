# Status

**Workbench is a scaffold.** It runs today. This page states what it
does, so a reader does not have to read the code to find out.

## What it is

Workbench is an agentic lab workspace for electrical
engineering, hardware, and electrochemistry. It runs on
[Ambion](https://github.com/ambionframework/ambion) 0.2.0, the
collaboration kernel, and it ports the layout, host, and OpenTUI terminal
of Ambion's own runnable example onto a lab domain of its own.

## The team

One assistant and five specialists, every seat on Pi:

| Agent         | Scope                                                           | Resource today             |
| ------------- | --------------------------------------------------------------- | -------------------------- |
| Assistant     | Understands the request, seats a specialist, returns a summary  | Workspace, lab, instrument |
| Datasheets    | Reads `/library` and states exact limits with their source      | Workspace, lab, instrument |
| Design        | Chooses parts and values, and shows the calculation             | Workspace, lab, instrument |
| Experiments   | Turns a question into a short, repeatable test plan             | Workspace, lab, instrument |
| Instruments   | Names what a person must do by hand; no equipment connected yet | Workspace only             |
| Data Analysis | Names the metric to read by hand; no analysis tooling yet       | Workspace only             |

`WORKBENCH_MODEL` switches every seat between two presets: `anthropic`
(`anthropic/claude-sonnet-5`) and `openai` (`openai/gpt-5.6-luna`). The
default is `anthropic`. Any other value passes through as a full Pi model
id. `src/domain/families.ts` holds the presets and the one key check per family.

Four people: `priya` (hardware lead), `noor` (electrochemistry lead),
`jae` (lab technician), and one added automatically for the account
running the process (`node:os` `userInfo().username`). The terminal opens
straight to that automatic person unless `WORKBENCH_USER` or `--as` names
someone else.

## The domain

One bench project: characterizing an 18650 Li-ion cell.

- **Library** (`library/`): five datasheet summaries — the cell, a
  TP4056-based charge and protection module, a power resistor bank, a
  K-type thermocouple, and JST-PH connectors and silicone wire.
- **Lab database** (`lab.db`): `projects`, `test_plans`, `runs`,
  `results`, `operations`, apart from the room journals.
- **Instruments**: two simulated bench instruments, `discharge-current`
  (2000 mA limit) and `charge-voltage` (4.2 V limit), behind `operate` and
  `approve_operation`. An operation above its limit waits for the owner of
  the exchange.
- **Rooms**: `characterization` (datasheet check → design decision),
  `cycling` (design → test plan), `budget` (datasheet check → power
  budget).

## What runs

- `pnpm check` passes clean: Prettier, `tsc --noEmit`, Biome (including
  the layering rule below) with warnings as errors, Knip, and 166
  scripted tests. No key and no network.
- The project has run `pnpm start` and `pnpm test:live` end to end, on
  the `openai` preset (`WORKBENCH_MODEL=openai`); the
  `ANTHROPIC_API_KEY` in `.env` is out of credit. The terminal draws,
  accepts a message, seats a specialist, and publishes a cited summary
  with a real cost. Both live scenarios in `test/live/engine.test.ts`
  pass.
- That run found one test bug, now fixed. The `characterization`
  scenario checked `summary.text` for the word "library," but the
  assistant cites what it relies on in the message's `refs` field
  (`file:///library/...`), per the `shared` instructions in
  `src/domain/definitions.ts`. The test now checks `refs`.

## Layout

This layout mirrors `examples/workbench` in the Ambion repository, laid
out in layers. `src/domain/` (`definitions.ts`, `scenarios.ts`,
`instrument.ts`, `families.ts`) holds the vocabulary. `src/view/`
formats the record for display (`steps.ts`, `timeline.ts`, `refs.ts`,
`database.ts`, `text.ts`). `src/host/` (`host.ts`, `rooms.ts`,
`files.ts`, `approvals.ts`, `names.ts`, `unavailable.ts`) is what a host
owns. `src/terminal/` is the OpenTUI terminal, over the three layers
below it.

`src/main.ts` composes domain and terminal. Biome's `noRestrictedImports`
refuses an import that points up. `test/` stays flat, on the Ambion
repository's own convention. See the "Files" table and the "Layout"
diagram in `README.md` for the one-line purpose of each module.

**The steps of an activation live in the host process.** Ambion 0.2.0
sends each step to a `TraceLogger`. The host keeps the steps of the
latest 200 activations in memory (`stepLog` in `src/view/steps.ts`). A
restart loses them, so the terminal shows no steps for an activation
from an earlier run.

## Toolchain

Biome lints (`biome.jsonc`), Prettier formats (`prettier.config.js`),
and Knip finds dead code (`knip.json`). These are the same tools, the
same rules, and the same limits that
[Ambion](https://github.com/ambionframework/ambion) holds its own source
to: cognitive complexity 10 in source and 15 in tests, no explicit
`any`, and no non-null assertion. `pnpm check` is the gate: format,
types, lint, test, in that order.

## Not built yet

- The Instruments and Data Analysis specialists are stubs: workspace tools
  only, and instructions that say plainly they have no resource to back a
  reading or a fit. See `backlog.md`.
- No CI. `pnpm check` is run by hand.
