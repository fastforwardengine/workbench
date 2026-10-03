# Workbench

**A shared lab workspace where people and specialists work on electrical
engineering, hardware, and electrochemistry.** It runs on
[Ambion](https://github.com/ambionframework/ambion) 0.5.0, the
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
  (`anthropic/claude-sonnet-4-5`), `openai` (`openai/gpt-5.6-luna`),
  `chatgpt` (`openai-codex/gpt-6-luna`), or a full Pi model ID. With no
  value, the default is `chatgpt` after `workbench login`, and `anthropic`
  before it. Every seat thinks at the `low` level (`THINKING` in
  `src/domain/model.ts`).
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
- **Ambion 0.5.0 opens no journal of 0.4.0.** Move an older data directory
  away, and start again. A workstation needs `workstation/setup.sh` again:
  `workstation.json` names the `snapshots` folder now.

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

**Two specialists hear every message in a new room, at `broadcast`. The
assistant writes the closing summary.** Every seat runs on Pi.

| Seat       | Work                                                                   | Tools     |
| ---------- | ---------------------------------------------------------------------- | --------- |
| Assistant  | Seats and unseats specialists, and summarizes                          | None      |
| Researcher | States limits from `/library`, with the source, and writes a test plan | Workspace |
| Engineer   | Watches the bench, runs the bench scripts, and guides a build          | Workspace |

**The workspace tools are the only tools.** They read and write files,
run shell commands as background processes, fork the git templates, and
snapshot a file into a stable ref.
The shell has `sqlite3`, so a specialist makes a database when a result
needs one. A bench script comes from a template.

## The lab

- **Rooms:** the seeded room `build` holds every phase of the FM radio, in
  this order:
  1. Know the kit, and support the first hand build.
  2. Tune the radio: path A and path B.
  3. Guide the build of the second kit.
  4. Write new firmware: path C.

  Every room seats both specialists at `broadcast`. `/new` adds a room with
  the same two seats.

- **State of the bench:** the Git repository `shared/notes` holds facts,
  decisions, and questions with their sources and confidence. Every specialist
  clones it, reads its README.md, and commits and pushes changes.
  [Notes](docs/notes.md) describes the layout and workflow.
- **Workspace:** one directory for every room. It holds `/library`,
  `/shared`, `/attachments`, and a home for each specialist.
- **Addressing:** start a message with `@name` to wake one seat: the
  assistant or a specialist. Type `@` to list them with their attention in
  the room. The host seats a specialist at `named` first when the room has not
  seated it. Start with `@@` to send a
  leading at sign. A message takes one mention, and a second one stays
  in the text.
- **Pictures:** `/attach <path>` copies a local file of up to 8 MiB into
  `/attachments`, snapshots it, and cites the snapshot in your next
  message. Paste the path of a picture into an empty composer, and it fills
  `/attach` for you. A specialist reads the copy with `read` and receives the
  picture. The files panel shows a picture, also from a snapshot ref. A
  terminal with Kitty graphics also shows up to four thumbnails under a
  message that cites a picture or a sensor manifest.
- **Camera viewfinder:** `/camera` shows a pane beside the conversation with
  the latest frame of the connected `camera` sensor, its age, and the sensor
  name. The pane takes one third of the terminal width, and the frame keeps
  its 16:9 shape. A second `/camera` hides it. The composer stays active while
  the pane shows. The pane reads the sensor every 3 seconds while it shows.
  Each read is a normal `observe`, which the sensor server logs. The workspace
  keeps no snapshot of it. The pane uses the slot of the side panels: the
  files and processes panels cover it and stop the reads, and it shows again
  when they close. A terminal under 100 columns does not show it. When no
  camera is connected, the pane asks you to have the Engineer connect one. The
  pane needs a terminal with Kitty graphics, such as Ghostty.
- **Keys:** Ctrl+C clears the composer, and it cancels a new room that
  waits for its goal. In a side panel it closes the panel. Ctrl+D leaves
  the terminal when the composer is empty, and `/quit` also leaves. The
  rooms stop with the terminal.
- **Staged pictures:** a row above the composer names the files that wait
  for your next message. Press Enter on an empty composer to send them
  alone, with the text `Attached <names>`. A bare `@name` sends them to
  that seat. A failed send keeps the files staged. Ctrl+C on an empty
  composer drops the attachments, and so does a switch to another room.
- **Templates:** git repositories that a specialist forks and pushes to. See
  [`docs/templates.md`](docs/templates.md).
- **Skills:** a folder of skills for each specialist, in `skills/`. See
  [`docs/skills.md`](docs/skills.md).

The library holds the datasheets and the manual of the kit parts, and no
real hardware is connected. Every measurement is a planned value.

## Develop

| Command          | What it does                                             |
| ---------------- | -------------------------------------------------------- |
| `pnpm check`     | Format, types, lint, and the scripted tests. CI runs it. |
| `pnpm format`    | Writes the formatting and the lint fixes                 |
| `pnpm test`      | The scripted tests: no key, no network                   |
| `pnpm test:live` | The evals on the simulator: needs a key, and costs money |
| `pnpm build`     | Writes the bundle of the npm package, `dist/main.mjs`    |

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
