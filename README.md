# Workbench

**A shared lab workspace where people and specialists work on electrical
engineering, hardware, and electrochemistry.** It runs on
[Ambion](https://github.com/ambionframework/ambion) 0.7.0, the
collaboration kernel, and follows
[Ambion's example](https://github.com/ambionframework/ambion/tree/main/examples/workbench).
**The objective now is an FM radio that the team helps build and then
controls.** The team tunes the radio in three ways: it presses its buttons,
drives its tuner chip, and replaces its firmware. It then guides the build
of a second kit, and checks each step with the camera and the instruments.
The team knows the state of the bench at all times, from its instruments,
its camera, and a microphone.
[`planning/next.md`](planning/next.md) holds the milestone, and
[`planning/fm-radio.md`](planning/fm-radio.md) the kit.

**The first project, an LED on a programmable supply, is done.** The team
drove the supply, watched the LED through the camera, swept it, and
blinked it.

## Install

Use Node 26.4 or newer, on macOS or Linux.

```sh
npm install -g @fastforwardengine/workbench
export ANTHROPIC_API_KEY=...       # or put it in .env in the working directory
workbench                         # data in ./.data
workbench ./bench                 # another directory
workbench login                   # or sign in with a ChatGPT subscription
```

**The `workbench` command reads `.env` in the working directory.** A
variable that the environment already sets keeps its value.

## Run from the repository

```sh
pnpm install
cp .env.example .env              # set ANTHROPIC_API_KEY, OPENAI_API_KEY, or both
pnpm start                        # data in ./.data
pnpm start ./bench                # another directory
```

- **`WORKBENCH_MODEL`** selects the model of every seat: `anthropic`
  (`anthropic/claude-sonnet-4-5`), `openai` (`openai/gpt-6.1-sol`),
  `chatgpt` (`openai-codex/gpt-6.1-sol`), `luna`
  (`openai-codex/gpt-6-luna`), or a full Pi model ID. With no value, the
  default is `chatgpt` after `workbench login`, and `anthropic` before it.
  The live tier (`pnpm test:live`) defaults to `luna`. Every seat thinks
  at the `low` level (`THINKING` in `src/domain/model.ts`).
- **Sign in with ChatGPT.** `workbench login` signs in with a ChatGPT
  Plus or Pro subscription through the `openai-codex` provider of Pi. It
  asks for a browser login (`1`) or a device-code login (`2`) for a host
  with no browser. The sign-in goes to `~/.ambion/pi/credentials.json`, or to the
  file that `WORKBENCH_PI_CREDENTIALS` names.
- **A seat with no login does not run.** A login is the key variable of
  the model provider, or a sign-in in the credential file. The header
  marks the seat `no login`, and the other seats keep running.
- **The terminal opens as the person named for your OS account.** That
  person is the one person of Workbench.
- **A new data directory gets the `build` room and the library.** An
  existing one resumes its rooms and has no `build` room. Move an older
  data directory away, or add a room with `/new bench`.
- **The rooms live on a canvas.** The canvas table `canvas_rooms` holds one
  row for each room, and the host resumes the rooms that ran. Workbench
  reads no room list of an earlier version.
- **Ambion 0.7.0 opens a journal of 0.6.0.** Move an older data directory
  away, and start again. A workstation needs `workstation/setup.sh` again:
  `workstation.json` names the `snapshots` folder now.
- **A room from before the removal of the assistant does not resume.**
  Its journal seats the assistant, and Ambion stops with the error
  `agent 'assistant' has no binding`. Move the data directory away, and
  start again.
- **Ambion 0.8.0 does not open a journal that holds a `posted` message.**
  A breakout report, a close notice, and a returned say wrote one in
  0.7.0. The room list then fails. Move the data directory away, and start
  again.

## Run on a local workstation

**A workstation runs the shell and the git repositories of the
specialists, one Unix account for each.** `workstation/` builds one in a
container, with `sshd` on `127.0.0.1:2222`. The journals stay in the
SQLite file of the data directory.

```sh
make                  # the workstation up, then Workbench on it
make stop             # stop the workstation; the volumes keep every file
```

**`make` does each step that is not done yet.** It installs the
dependencies, writes the keys into `.workstation/`, builds and starts the
container, waits for `sshd`, and starts Workbench with
`WORKBENCH_WORKSTATION`. The `Makefile` lists the other targets.
[`workstation/README.md`](workstation/README.md) holds the accounts, the
layout, and the tests.

## The team

**The Engineer hears every message at `broadcast`. The Researcher waits at
`named` and wakes on a directed say.** Every seat runs on Pi.

**Every message shows in the conversation, in order.** The room writes no
summary of an exchange. The person addresses the Researcher with
`@researcher`. The Engineer asks the Researcher for a limit or a test plan
with a directed say.

| Seat       | Work                                                                   | Tools     |
| ---------- | ---------------------------------------------------------------------- | --------- |
| Researcher | States limits from `/library`, with the source, and writes a test plan | Workspace |
| Engineer   | Watches the bench, runs the bench scripts, and guides a build          | Workspace |

**Each specialist can open a breakout room.** It seats itself there, does a
task of many steps in the background, and reports the result. The header
counts the breakout rooms that run, and Ctrl+R lists them under their
parent room.
See [`docs/breakouts.md`](docs/breakouts.md).

**The workspace tools do the work of the bench.** They read and write files,
run shell commands as background processes, fork the git templates, and
snapshot a file into a stable ref.
A bench script comes from a template.

## The lab

- **Rooms:** the seeded room `build` holds every phase of the FM radio, in
  this order:
  1. Know the kit, and support the first hand build.
  2. Tune the radio: path A and path B.
  3. Guide the build of the second kit.
  4. Write new firmware: path C.

  A new room seats the Engineer at `broadcast` and the Researcher at
  `named`. `/new` adds a room with the same seats. A room keeps the seats
  of its journal when the host resumes it.

- **State of the bench:** the Git repository `shared/notes` holds facts,
  decisions, and questions with their sources and confidence. Every specialist
  clones it, reads its README.md, and commits and pushes changes.
  [Notes](docs/notes.md) describes the layout and workflow.
- **Workspace:** one directory for every room. It holds `/library`,
  `/shared`, `/attachments`, and a home for each specialist.
- **Terminal:** the composer, the dock, the camera viewfinder, and voice
  mode. [Terminal](docs/terminal.md) holds the commands, the keys, and the
  design.
- **Templates:** git repositories that a specialist forks and pushes to. See
  [`docs/templates.md`](docs/templates.md).
- **Skills:** a folder of skills for each specialist, in `skills/`. See
  [`docs/skills.md`](docs/skills.md).

The library holds the datasheets and the manual of the kit parts, and no
real hardware is connected. Every measurement is a planned value.

## Develop

| Command                | What it does                                                         |
| ---------------------- | -------------------------------------------------------------------- |
| `pnpm check`           | Format, types, lint, the scripted tests, and the Python. CI runs it. |
| `pnpm check --changed` | The same stages on the changed files. For a small change.            |
| `pnpm format`          | Writes the formatting and the lint fixes                             |
| `pnpm test`            | The scripted tests: no key, no network                               |
| `pnpm test:live`       | The evals on the simulator: needs a key, and costs money             |
| `pnpm build`           | Writes the bundle of the npm package, `dist/main.mjs`                |

`pnpm check` needs `ruff` and Python 3.11 or newer on PATH. Run
`pipx install ruff` or `brew install ruff` to install `ruff`.

**The layers of `src/` and their import rules are in [CLAUDE.md](CLAUDE.md).**
Biome holds the rules.

## Release

**A release publishes the head of `main` to npmjs from your machine, and
tags the commit.** Run `pnpm release` on a clean `main` at
`origin/main`. The command checks and builds a clean worktree of the
commit, publishes it, and pushes the tag. npm asks for the sign-in in
the browser. `pnpm release --userconfig <npmrc>` publishes with another
npm configuration.

**The version is `<major>.<minor>.<count>-g<hash>`,** such as
`0.1.14-gb536c96`. `package.json` holds the base, `0.1`. The count is the
number of commits of `main`, so each release has a higher version. The
hash is the short hash of the commit. The tag is the version with a `v`.
`node scripts/release-version.ts` prints the version of the checkout, and
the release refuses a version that is not above the `latest` version on
npm.

## License

Apache License 2.0. See [`LICENSE`](LICENSE).
