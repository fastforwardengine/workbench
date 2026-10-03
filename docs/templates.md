# Templates and the git backend

**The workspace has a git server, and the host registers the templates of
this repository on it.** An agent forks a template, clones the fork into
its home, edits it, commits, and pushes a branch. A push keeps the work
across a restart of the host. Ambion's
[git backend page](https://github.com/ambionframework/ambion/blob/main/docs/git.md)
holds the contract, the tools, and the credentials.

## Where each part lives

| Part                 | Where                      | What it holds                                          |
| -------------------- | -------------------------- | ------------------------------------------------------ |
| The files            | `templates/<name>/`        | The files that a fork starts with, text only           |
| The registry         | `src/domain/templates.ts`  | The name, description, use, and specialists of each    |
| The git backend      | `src/host/repositories.ts` | `labRepositories`, which registers every template      |
| The wiring           | `src/host/rooms.ts`        | The `git` backend of the workspace, in `<data>/git.db` |
| The registry check   | `test/templates.test.ts`   | The check of directories to entries                    |
| The flow of an agent | `test/tool-set.test.ts`    | A scripted seat forks `test-plan` and pushes a branch  |

**The host runs the git server in its own process.** The bash backend is
the local just-bash directory under `<data>/workspace`, and its `git`
reaches the server in process. No network takes part.

## Add a template

1. Make a directory `templates/<name>/`. The name matches
   `^[a-z0-9][a-z0-9._-]{0,63}$`.
2. Add a `README.md` with the numbered steps an agent follows. End with
   "Commit, and push your branch. A push keeps the work."
3. Add the other files. Mark each value the agent fills in with `TBD`.
4. Add an entry to `templates` in `src/domain/templates.ts`. The
   `description` shows in `repos`. The `use` is a noun phrase, such as "a
   test plan". The `specialists` get one instruction line that names the
   template.

## Change a template

**Edit the files in place.** At the next start, the host registers the
new files. The git backend moves `templates/<name>` to a new commit whose
parent is the old tip. A changed `description` replaces the old one.

**A fork keeps the commit it came from.** A room that works on a fork does
not see the change. A new fork starts from the new commit.

**No tool rewrites a template.** `.prettierignore` holds `templates/`.
`templateFiles` skips `.git`, `.DS_Store`, `__pycache__`, and `.pyc`
files, so a file that a tool writes beside a template does not change it.
The `psu` and `usb-camera` templates store a file `gitignore` with the same
Python lines, because npm and pnpm drop a `.gitignore` from a package. The
host registers it as `.gitignore`, so a `git add -A` in a fork does not
commit bytecode.

## The templates today

| Template          | Use                                    | Specialists |
| ----------------- | -------------------------------------- | ----------- |
| `test-plan`       | A test plan                            | Researcher  |
| `device-scan`     | A scan of the connected devices        | Engineer    |
| `usb-camera`      | Images and sound from a USB camera     | Engineer    |
| `psu`             | Control of a programmable power supply | Engineer    |
| `build-procedure` | A build procedure for a kit            | Engineer    |

`planning/next.md` names the next one: an `fm-radio` template that tunes
the radio. The `build-procedure` template holds the shape of the build
procedure for the FM radio kit.

The `usb-camera` template follows the
[Ambion 0.5.0 camera-chat lifecycle](https://github.com/ambionframework/ambion/tree/v0.5.0/examples/camera-chat).
It captures frames with Python and V4L2 on the workstation. It records
clips from the microphone of the camera with ALSA. One process owns the
USB device and serves two sensors, `camera` and `microphone`. The Engineer forks and
saves the server, starts it with `bash`, waits for READY, and then uses
`connect` and `observe`. Each successful observation saves a manifest and a
frame or a clip in the snapshot store. The in-process just-bash backend has no sensor
endpoints. The [template README](../templates/usb-camera/README.md) gives
the steps for replacement, rollback, and restoration.

**Two tests validate the `usb-camera` protocol.** Both open no camera. The
commands exist in the Workbench repository only.

- `pnpm exec vitest run test/usb-camera-protocol.test.ts` runs Ambion's
  `sensorConformance` and the standard digest-verifying client against both
  sensors of the server. The test fixes the clock of the acquisition.
- `WORKBENCH_WORKSTATION=.workstation/workstation.json pnpm exec vitest run
test/usb-camera-workstation.test.ts` checks these steps: fork, save,
  start, connect, observation by a second account, cancellation, and
  restoration after a change to an export.

**One test validates the `psu` protocol.** `pnpm exec vitest run
test/psu-sensor-protocol.test.ts` runs Ambion's `sensorConformance` and the
standard digest-verifying client against `sensor.py`. The test serves a
fixed scenario on the simulated supply, with two channels and a fixed set of
sample times. It opens no hardware. The
[template README](../templates/psu/README.md) gives the steps to start the
sensor.
