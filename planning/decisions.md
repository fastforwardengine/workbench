# Decisions

The choices made so far, in the order they happened, and why. Read this
before changing the family setup or the team shape; it explains why the
project is not the first thing it tried.

## 1. Port Ambion's example in full

**Choice:** Mirror every file of `examples/workbench`: the host, the
session, and the whole OpenTUI terminal. **Why:** The terminal is most of
that example's evidence that the kernel's claims hold (steps, refs,
approvals, the files panel). A minimal runner would have left those
unproven for this domain. The tradeoff is size: about 30 source files
and 18 test files before any domain logic.

## 2. All five specialists on Pi, uniform bundles, two stubs

**Choice:** Every specialist reads the same tools (workspace, lab,
instrument), except Instruments and Data Analysis, which read the
workspace only. **Why:** `examples/workbench`'s principle is "every agent
holds the same tools." Instruments and Data Analysis have no resource to
back an instrument reading or a data fit yet, so giving them the tool
would let them claim work they cannot do. The stub instructions state
this limitation plainly.

## 3. Codex for `luna`, then reverted

**Choice:** Moved the five specialists to `@ambionframework/codex`, on
`gpt-5.6-luna` at `modelReasoningEffort: 'low'`, then moved them back to
Pi. **Why:** Pi's executor has no reasoning-effort option. Only Codex
exposes `modelReasoningEffort`, and `defineAssistant` always builds a Pi
executor, so the assistant could never make that trip anyway. Splitting
the team across two families also meant every scripted test needed a
second scripted execution (`test/scripted-families.ts`) for the seats on
Codex. The original request ("not full Codex just yet") did not ask for
that. Reverted to one family, Pi, for every seat.

## 4. `WORKBENCH_MODEL` as a preset name

**Choice:** `WORKBENCH_MODEL=anthropic` or `WORKBENCH_MODEL=openai` picks
a full Pi model id from `MODEL_PRESETS` in `src/domain/families.ts`.
Anything else still passes through as `provider/model-id`. **Why:** The
two providers this project has a key for are Anthropic and OpenAI. A
one-word switch is easier to reach for than remembering
`anthropic/claude-sonnet-5` versus `openai/gpt-5.6-luna`, and it keeps
the escape hatch (a full id) for a third provider without a preset.

## 5. One automatic person, named for the OS account

**Choice:** `src/domain/definitions.ts` adds a person named
`node:os` `userInfo().username`, and `src/main.ts` opens straight to that
person when neither `WORKBENCH_USER` nor `--as` names someone else. **Why:**
The scaffold should open with no configuration on the machine that made
it, and stay correct if it runs under a different account.

## 6. `src/` laid out in layers, and the Ambion toolchain in full

**Choice:** Moved the flat 32-file `src/` into four directories —
`domain/`, `view/`, `host/`, `terminal/` — plus `main.ts` at the root.
Added Biome, Prettier, and Knip, with the same rules Ambion holds its
own source to: a `noRestrictedImports` override per layer that refuses
an upward import, a cognitive complexity budget of 10 (15 in tests), no
explicit `any`, no non-null assertion, and no unused import or variable.

**Why:** The flat layout of `examples/workbench` hides which module
depends on which. That layout works there because `examples/**/src/**`
is small, and one team wrote every file in one sitting. This project had
already grown a real dependency order: domain and view are independent
leaves, host depends on both, and terminal depends on all three. The
layers name what was already true, and Biome now holds it. Ambion's own
toolchain was the obvious source for the rules, since this project
already follows its formatting by hand.

## Open questions this leaves

- Whether a real equipment connection for Instruments, or analysis tooling
  for Data Analysis, should follow the `SqlResource` pattern of
  `src/domain/instrument.ts`, or need a resource of their own. Decide when
  building either; see `backlog.md`.
- Whether a second bench project (a second kit) is a second `scenarios.ts`
  entry or its own room-independent structure. The current layout assumes
  one shared workspace and one lab database for every room, which holds
  for one kit and has not been tested with two.
