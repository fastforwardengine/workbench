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
      `test/live/engine.test.ts`: it checked prose for the word
      "library" in place of the summary's `refs`.
- [ ] Get `pnpm start` and `pnpm test:live` passing on the `anthropic`
      preset too — the account behind `ANTHROPIC_API_KEY` in `.env` is
      out of credit, so the project has proven only the `openai` preset
      live.

## The first real use case: an LED parameter sweep

**A power supply drives an LED through a range of values, and a camera
measures the light at each step.** The power supply and the camera
connect to a workstation. It is the first use case on real hardware, and
the items below set the stage for it. Nothing here is built yet.

- [ ] **Decide the hardware.** Name the power supply and its interface,
      such as SCPI over USB or LAN. Name the camera and its interface,
      such as a USB camera. Add a datasheet for the LED, the supply, and
      the camera to `library/`.
- [ ] **Decide the workstation connection.** Ambion's
      `@ambionframework/workstation` runs each agent's shell over SSH on
      one server. Its git reaches the git server over HTTP, through the
      `handler` of `gitBackend` and its `url` option. The host, the
      network, and the accounts are not defined yet. Until then the bash
      backend stays the local just-bash directory, which has no Python and
      no hardware access.
- [ ] **Write a test plan for the sweep** from the `test-plan` template:
      the variable (the LED current), its range and step, the camera
      exposure as a control, and the LED current limit from its
      datasheet.
- [ ] **Add an `led-sweep` template** on the pattern of
      `docs/templates.md`. It holds a script that steps the supply, reads
      the camera at each step, and writes one CSV row for each step. It
      has a simulated mode that needs no hardware. It refuses a setpoint
      above the limit in its configuration.
- [ ] **Connect the sweep to the lab database.** Each sweep is a `runs`
      row, and each step gives `results` rows. The supply goes through
      `operate` and its limit, per `docs/instrument.md`, or the sweep
      script records its rows after the run. Decide which.
- [ ] **Give Instruments and Data Analysis the sweep.** Instruments
      prepares and runs it. Data Analysis reads the CSV and states the
      brightness against the current.

## Build the two stub resources

- [ ] **Instruments.** This needs a real equipment connection. It drives
      the same `operations` table with `operate`/`approve_operation`;
      the infrastructure already proves that shape: provenance, the
      limit-and-approval flow, and `lab.use()`'s serialization. What
      remains is picking real hardware and writing one `InstrumentDriver`
      for it, then giving the `instruments` specialist the full bundle.
      See `docs/instrument.md` for the interface design.
- [ ] **Data Analysis.** This needs a fit, a plot, or a data-quality
      check over the `results` table, exposed as a tool bundle. Decide
      the smallest useful first tool: likely a fit of one metric across
      the runs of one project, given that `lab:///results` already lets
      a person read the raw rows by hand.
- Once either exists, give that specialist the full bundle
  (`workspace.tools()`, `lab.tools()`, plus the new one) in place of the
  workspace-only stub bundle. Drop the "no resource" line from its
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
- [ ] Reconsider the three-person default team (`priya`, `noor`, `jae`,
      plus the automatic account person) once more than one real person
      uses the project. The person picker is a local convention; see
      `README.md`, "Restart".

## Project hygiene

- [x] A Biome and Prettier config of this project's own, and the layered
      `src/` directory structure Biome's `noRestrictedImports` holds.
      See `decisions.md` §6.
- [x] CI: `.github/workflows/ci.yml` runs `pnpm check` on each pull
      request and each push to `main`. It never runs `pnpm test:live`,
      which costs money and needs a key.
- [ ] Decide whether to move a specialist to `@ambionframework/claude` or
      `@ambionframework/codex` for a capability Pi does not have —
      Codex's reasoning-effort control, or a harness's built-in tools
      under policy. See `decisions.md` §3 for why the project tried this
      once and reverted it. A future attempt should keep the whole team
      on one family unless a specific specialist needs the move. This
      avoids splitting every scripted test across two scripted
      executions again.
