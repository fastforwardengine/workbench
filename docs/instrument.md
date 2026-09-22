# The instrument driver interface

This is a design for real hardware. The project has not picked hardware
yet. This page scopes the interface a real driver will implement, so the
next session can build it without deriving the shape again from scratch.

## What exists today

`src/domain/instrument.ts` is already mostly real infrastructure: the
`operations` table, provenance (`provenanceOf`), and the
limit-and-approval flow (`operate` / `approve_operation`, the
two-activation approval pattern). `test/live/engine.test.ts` proves all
three live, against a real model.

The only simulated part is `readingOf(setpoint) => setpoint`: a
synchronous, infallible stand-in for what will eventually be an async,
fallible I/O call to real hardware.

`@ambionframework/workspace`'s `SqlResource.use()` already serializes
"complete operations, including connection and callback work" across
every caller sharing one `lab` resource (`resource-C46Vg2Jb.d.mts` in
the `@ambionframework/workspace` package). `runOperate` and `runApprove`
already run inside `lab.use(...)`, which already serializes a driver call
placed inside that callback against every other agent's operation. **A
first real driver needs no new concurrency primitive.**

## The interface

Add an `InstrumentDriver` interface next to `InstrumentSpec` in
`src/domain/instrument.ts`:

```ts
export interface InstrumentDriver {
  drive(setpoint: number, signal?: AbortSignal): Promise<number>;
}
```

This is the interface. A real driver — SCPI over USB-serial, a
microcontroller protocol, or whichever protocol the project picks —
implements this interface and performs real I/O. The project has not
written it yet.

Give `InstrumentSpec` an optional `driver?: InstrumentDriver`. Replace
the module-level `readingOf` with a `simulated: InstrumentDriver`
(`drive: async (setpoint) => setpoint`). The code uses this fallback when
a spec has no `driver`. The two scenario instruments today
(`discharge-current`, `charge-voltage` in `src/domain/scenarios.ts`) keep
behaving exactly as they do now.

Make `runOperate`'s at-or-below-limit branch, and `runApprove`'s allow
branch, `async`. Replace the call to `readingOf(setpoint)` with
`(spec.driver ?? simulated).drive(setpoint, ctx.signal)`. Wrap the new
call in try/catch:

- **On success:** record exactly as today (`outcome: 'done'` /
  `'approved'`, with the real `reading`).
- **On rejection:** record a new outcome, `'error'`, with the caught
  message in a new nullable `error` column (added to the `operations`
  table's `CREATE TABLE` in `scenarios.ts`). Return a descriptive string
  to the agent — for example, "Operation N did not run. `<name>` did not
  respond: `<message>`. Check the connection and retry, or ask a person
  to check the instrument." Do **not** throw. A comm failure is an
  expected real-world outcome. The code records and describes it, the
  same way it already handles an over-limit setpoint.
- Keep every existing thrown error as-is (unknown instrument, bad id, no
  open exchange). Those stay programmer and protocol errors.

## Tests

Add a fake `InstrumentDriver` to `test/instrument.test.ts` and two kinds
of cases:

1. A spec with a driver that returns a reading different from the
   setpoint, to prove the interface actually calls the driver for its
   reading — both on the direct `operate` (at/below limit) and the
   `approve_operation` (allow) paths.
2. A driver whose `drive` rejects, to prove the operation records
   `outcome: 'error'` with the message, returns a clear non-throwing
   string, and does not throw out of the tool call.

Existing tests keep passing unchanged: specs with no `driver` fall back
to `simulated`, which behaves exactly like the old `readingOf`.

## Explicitly out of scope for this interface

- **No concrete real driver.** No `node:serialport`, SCPI, or USB-TMC
  code — nothing to write until the project picks hardware.
- **No change to the `instruments` specialist.** Its stub bundle and
  instructions in `src/domain/definitions.ts` stay as they are. It still
  correctly says it has no resource, because it still has none. Moving
  it to the full bundle is a separate, later step — see
  `planning/backlog.md`.
- **No concurrency lock.** `lab.use()` already serializes.
- **No migration tooling** for the new `error` column. No migration
  system exists yet: this is scaffold stage, `.data/` is gitignored, and
  no real persisted data survives a schema change today. This gap stays
  for later.

## Build order

1. Pick the hardware and its protocol (backlog: "Build the two stub
   resources → Instruments").
2. Build the interface above.
3. Write one concrete `InstrumentDriver` for that hardware.
4. Switch the `instruments` specialist from the workspace-only stub
   bundle to the full bundle (`workspace.tools()`, `lab.tools()`,
   `instrument.tools()`), and drop the "no resource" line from its
   instructions.

## Verification, once built

- `pnpm run check:types`
- `pnpm exec vitest run test/instrument.test.ts` for the new/changed
  cases, then the full `pnpm run check` gate.
- **No live run needed for the interface itself.** It touches no
  model-facing behavior beyond a new possible tool-result string, which
  the scripted tests cover with the fake driver. A live run matters once
  a concrete driver exists and real hardware is on the bench.
