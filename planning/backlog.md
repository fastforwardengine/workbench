# Backlog

Work after today, roughly in the order it likely comes. Nothing here is
scheduled; move an item to `status.md` under "What runs" once it ships,
and add a line to `decisions.md` if it changed the shape of the project.

## Verify what has not been run yet

- [ ] Run `pnpm start` once and confirm the terminal actually draws,
      accepts a message, and shows a reply. It typechecks and the unit
      tests pass, but nobody has looked at it running.
- [ ] Run `pnpm test:live` for at least one scenario, on purpose, to
      confirm a real model reaches the room and a summary publishes with a
      real cost. Costs money; run the smallest thing first
      (`vitest run --config vitest.live.config.ts test/live/engine.test.ts`).

## Build the two stub resources

- [ ] **Instruments.** A real equipment connection, on the pattern of
      `src/domain/instrument.ts`: a resource with an `env`, tools behind it, and
      provenance on every row. Decide first whether it drives the same
      `operations` table with `operate`/`approve_operation`, or needs its
      own shape for a live driver's readings.
- [ ] **Data Analysis.** A fit, a plot, or a data-quality check over the
      `results` table, exposed as a tool bundle. Decide the smallest
      useful first tool: likely a fit of one metric across the runs of one
      project, given `lab:///results` already lets a person read the raw
      rows by hand.
- Once either exists, give that specialist the full bundle
  (`workspace.tools()`, `lab.tools()`, plus the new one) instead of the
  workspace-only stub bundle, and drop the "no resource" line from its
  instructions.

## Grow the terminal

- [ ] A plotted result or an image preview in the files panel, once Data
      Analysis can produce one. `/files` already renders a Markdown
      datasheet and a SQLite table; a plot is the natural third form.
- [ ] A brand kit of its own. The palette in `src/terminal/brand.ts` is a
      placeholder; `examples/workbench` reads the Ambion repository's brand
      kit, which this standalone project does not have.

## Widen the domain

- [ ] A second bench project: a second `scenarios.ts` entry, a second set
      of library files, and a decision on whether it shares the lab
      database and workspace of the first, or needs its own. The current
      code assumes one shared workspace and one lab database across every
      room; this is untested with two projects.
- [ ] Reconsider the two-person default team (`priya`, `noor`, `jae`, plus
      the automatic account person) once more than one real person uses
      the project. The person picker is a local convention, not
      authentication (see `README.md`, "Restart").

## Project hygiene

- [x] A Biome and Prettier config of this project's own, and the layered
      `src/` directory structure Biome's `noRestrictedImports` holds.
      See `decisions.md` §6.
- [ ] CI: run `pnpm check` on push, holding back `test:live`. Never run
      `pnpm test:live` on a pull request; it costs money and needs a key.
- [ ] Decide whether to move a specialist to
      `@ambionframework/claude` or `@ambionframework/codex` for a
      capability Pi does not have (Codex's reasoning-effort control, or a
      harness's built-in tools under policy). See `decisions.md` §3 for
      why this was tried once and reverted; a future attempt should keep
      the whole team on one family unless a specific specialist needs
      the move, to avoid re-splitting every scripted test across two
      scripted executions.
