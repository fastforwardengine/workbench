# The instrument driver seam

This is a design for real hardware, not yet built. No hardware has been
chosen. This page scopes the seam a real driver will plug into, so the
next session can build it without re-deriving the shape from scratch.

## What exists today

`src/domain/instrument.ts` is already mostly real infrastructure: the
`operations` table, provenance (`provenanceOf`), and the
limit-and-approval flow (`operate` / `approve_operation`, the
two-activation approval pattern) are all proven live — `test/live/engine.test.ts`
runs them against a real model, not a script.

The only simulated part is `readingOf(setpoint) => setpoint`: a
synchronous, infallible stand-in for what will eventually be an async,
fallible I/O call to real hardware.

`@ambionframework/workspace`'s `SqlResource.use()` already serializes
"complete operations, including connection and callback work" across
every caller sharing one `lab` resource (`resource-C46Vg2Jb.d.mts` in
the `@ambionframework/workspace` package). Since `runOperate` and
`runApprove` already run inside `lab.use(...)`, a driver call placed
inside that callback is already serialized against every other agent's
operation. **No new concurrency primitive is needed** for a first real
driver.

## The seam

Add an `InstrumentDriver` interface next to `InstrumentSpec` in
`src/domain/instrument.ts`:

```ts
export interface InstrumentDriver {
  drive(setpoint: number, signal?: AbortSignal): Promise<number>;
}
```

This is the seam. A real driver — SCPI over USB-serial, a microcontroller
protocol, whatever gets chosen — implements this and does real I/O. It is
not written yet.

Give `InstrumentSpec` an optional `driver?: InstrumentDriver`. Replace
the module-level `readingOf` with a `simulated: InstrumentDriver`
(`drive: async (setpoint) => setpoint`), used when a spec has no
`driver`. The two scenario instruments today (`discharge-current`,
`charge-voltage` in `src/domain/scenarios.ts`) keep behaving exactly as
they do now, unchanged.

Make `runOperate`'s at-or-below-limit branch, and `runApprove`'s allow
branch, `async`, and call `(spec.driver ?? simulated).drive(setpoint,
ctx.signal)` instead of `readingOf(setpoint)`. Wrap the call in
try/catch:

- **On success:** record exactly as today (`outcome: 'done'` /
  `'approved'`, with the real `reading`).
- **On rejection:** record a new outcome, `'error'`, with the caught
  message in a new nullable `error` column (added to the `operations`
  table's `CREATE TABLE` in `scenarios.ts`). Return a descriptive string
  to the agent — for example "Operation N did not run. `<name>` did not
  respond: `<message>`. Check the connection and retry, or ask a person
  to check the instrument." — and do **not** throw. A comm failure is an
  expected real-world outcome, not a programmer error, exactly like an
  over-limit setpoint is already handled (recorded and described, not
  thrown).
- Keep every existing thrown error as-is (unknown instrument, bad id, no
  open exchange) — those stay programmer/protocol errors, not driver
  outcomes.

## Tests

Add a fake `InstrumentDriver` to `test/instrument.test.ts` and two kinds
of cases:

1. A spec with a driver that returns a reading different from the
   setpoint, to prove the seam actually calls the driver instead of
   echoing it — both on the direct `operate` (at/below limit) and the
   `approve_operation` (allow) paths.
2. A driver whose `drive` rejects, to prove the operation records
   `outcome: 'error'` with the message, returns a clear non-throwing
   string, and does not throw out of the tool call.

Existing tests keep passing unchanged: specs with no `driver` fall back
to `simulated`, which behaves exactly like the old `readingOf`.

## Explicitly out of scope for this seam

- **No concrete real driver.** No `node:serialport`, SCPI, or USB-TMC
  code — nothing to write until hardware is picked.
- **No change to the `instruments` specialist.** Its stub bundle and
  instructions in `src/domain/definitions.ts` stay as they are; it still
  correctly says it has no resource, because it still doesn't. Moving it
  to the full bundle is a separate, later step — see `planning/backlog.md`.
- **No concurrency lock.** `lab.use()` already serializes.
- **No migration tooling** for the new `error` column. No migration
  system exists yet (scaffold stage, `.data/` is gitignored, no real
  persisted data survives across a schema change today) — noted, not
  solved.

## When this gets built

1. Pick the hardware and its protocol (backlog: "Build the two stub
   resources → Instruments").
2. Build the seam above.
3. Write one concrete `InstrumentDriver` for that hardware.
4. Switch the `instruments` specialist from the workspace-only stub
   bundle to the full bundle (`workspace.tools()`, `lab.tools()`,
   `instrument.tools()`), and drop the "no resource" line from its
   instructions.

## Verification, once built

- `pnpm run check:types`
- `pnpm exec vitest run test/instrument.test.ts` for the new/changed
  cases, then the full `pnpm run check` gate.
- No live run needed for the seam itself — it touches no model-facing
  behavior beyond a new possible tool-result string, which the scripted
  tests cover via the fake driver. A live run matters once a concrete
  driver exists and real hardware is on the bench.
