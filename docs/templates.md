# Templates and the git backend

**The workspace has a git server, and the host registers the templates of
this repository on it.** A specialist forks a template, clones the fork into
its home, edits it, commits, and pushes a branch. A push keeps the work
across a restart of the host. Ambion's
[git backend page](https://github.com/ambionframework/ambion/blob/main/docs/git.md)
holds the contract, the tools, and the credentials.

## Where each part lives

| Part                     | Where                      | What it holds                                           |
| ------------------------ | -------------------------- | ------------------------------------------------------- |
| The files                | `templates/<name>/`        | The files that a fork starts with, text only            |
| The registry             | `src/domain/templates.ts`  | The name and description of each                        |
| The git backend          | `src/host/repositories.ts` | `labRepositories`, which registers every template       |
| The wiring               | `src/host/rooms.ts`        | The `git` backend of the workspace, in `<data>/git.db`  |
| The registry check       | `test/templates.test.ts`   | The check of directories to entries                     |
| The flow of a specialist | `test/tool-set.test.ts`    | A scripted seat forks `device-scan` and pushes a branch |

**The host runs the git server in its own process.** The bash backend is
the local just-bash directory under `<data>/workspace`, and its `git`
reaches the server in process. No network takes part.

## Add a template

1. Make a directory `templates/<name>/`. The name matches
   `^[a-z0-9][a-z0-9._-]{0,63}$`.
2. Add a `README.md` with the numbered steps a specialist follows. End with
   "Commit, and push your branch. A push keeps the work."
3. Add the other files. Mark each value the specialist fills in with `TBD`.
4. Add an entry to `templates` in `src/domain/templates.ts`. The
   `description` shows in `repos`.
5. Name the template in the `SKILL.md` of the skill that forks it.
   `test/templates.test.ts` checks that a skill names each template.

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

The `usb-camera` template follows the
[Ambion 0.7.0 camera-chat lifecycle](https://github.com/ambionframework/ambion/tree/v0.7.0/examples/camera-chat).
It streams MJPEG frames from the camera with `v4l2-ctl`, and keeps a frame
in a ring in RAM when the scene changed. A change rule on a grey copy of
each frame decides this, and Pillow makes the copy. The server writes no
camera frame to disk. It records clips from the microphone of the camera
with ALSA. One process owns the USB device and serves two sensors,
`camera` and `microphone`. The server follows the sensor protocol,
version 2. The Engineer forks and saves the server, and starts it with
`bash` under the name `camera`. The workspace gives the process a port in
`$PORT`. The Engineer then reads the sensors with `fetch`, and shows the
camera to the person with a `frame` widget that names the handle. Each
fetched observation, frame, and clip goes into the snapshot store. The
in-process just-bash backend has no sensor endpoints. The
[template README](../templates/usb-camera/README.md) gives the steps for
replacement, rollback, and restoration.

**Two tests validate the `usb-camera` protocol.** Both open no camera. The
commands exist in the Workbench repository only.

- `pnpm exec vitest run test/usb-camera-protocol.test.ts` runs the
  sensor protocol checks of Workbench against both sensors of the
  server. The test fixes the clock of the receipt time.
- `WORKBENCH_WORKSTATION=.workstation/workstation.json pnpm exec vitest run
test/usb-camera-workstation.test.ts` checks these steps: fork, save,
  start, `fetch` by a second account, cancellation, and restoration of a
  snapshot.

**One test validates the `psu` protocol.** `pnpm exec vitest run
test/psu-sensor-protocol.test.ts` runs the sensor protocol checks of
Workbench against `sensor.py`. The test serves a
fixed scenario on the simulated supply, with two channels and a fixed set of
sample times. It opens no hardware. The
[template README](../templates/psu/README.md) gives the steps to start the
sensor.
