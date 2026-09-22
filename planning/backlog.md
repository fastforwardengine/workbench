# Backlog

Work after today, roughly in the order it likely comes. Nothing here is
scheduled; move an item to `status.md` under "What runs" once it ships,
and add a line to `decisions.md` if it changed the shape of the project.

## Verify what has not been run yet

- [x] Run `pnpm start` once and confirm the terminal actually draws,
      accepts a message, and shows a reply. Done on the `openai` preset;
      see `status.md`.
- [x] Run `pnpm test:live` for at least one scenario. Done on the `openai`
      preset; both scenarios pass. Found and fixed a test bug in
      `test/live/engine.test.ts` (checked prose for "library" instead of
      the summary's `refs`).
- [ ] Get `pnpm start` and `pnpm test:live` passing on the `anthropic`
      preset too — the account behind `ANTHROPIC_API_KEY` in `.env` is
      out of credit, so only `openai` has been proven live.

## Build the two stub resources

- [ ] **Instruments.** A real equipment connection. It drives the same
      `operations` table with `operate`/`approve_operation`; the
      infrastructure already proves that shape (provenance, the
      limit-and-approval flow, `lab.use()`'s serialization). What's left
      is picking real hardware and writing one `InstrumentDriver` for it,
      then giving the `instruments` specialist the full bundle. See
      `docs/instrument.md` for the seam design.
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
