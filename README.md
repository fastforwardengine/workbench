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

**Each specialist can open a breakout room.** Its twin does a task of many
steps in the background and reports the result. The header counts the
breakout rooms that run, and Ctrl+R lists them under their parent room.
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
- **Addressing:** start a message with `@name` to wake one specialist.
  A message with no mention wakes the Engineer. Type `@` to list the
  specialists with their attention in the room. The host seats a
  specialist at `named` first when the room has not seated it. Start with
  `@@` to send a leading at sign. A message takes one mention, and a
  second one stays in the text. The chip before the input names the seats
  that hear the message, and a note shows when the host seats the named
  specialist first or the seat has no login. The rail at the left of the
  input takes one color for a command and another for a mention.
- **Status row:** the row under the input says what the room does. While a
  specialist works, it shows the seat, its step, and the time since its
  first step. At the right, it counts the background processes, the
  breakout rooms that run, and the says that wait, each only when the count
  is not zero. The keys hint follows the counts. A narrow terminal drops the
  says first, then the processes, then the breakout rooms, then the hint.
- **Pictures:** `/attach <path>` copies a local file of up to 8 MiB into
  `/attachments`, snapshots it, and cites the snapshot in your next
  message. Paste the path of a picture into an empty composer, and it fills
  `/attach` for you. A specialist reads the copy with `read` and receives the
  picture. The files layer shows a picture, also from a snapshot ref. A
  terminal with Kitty graphics also shows up to four thumbnails under a
  message that cites a picture, such as a frame that `fetch` saved.
- **Dock:** the files, the processes, the keys sheet, and the camera are
  layers of one dock at the right of the conversation. The dock takes half
  of the terminal width, has the panel background, and has one line at its
  left edge. A tabs line names the open layers, and the top one is bright.
  A new layer opens on top. A layer that is open comes to the top when you
  open it again, and the other layers keep their state below it. Only the
  top layer draws and reads. A terminal under 100 columns draws the dock over
  the right part of the conversation, only while the dock has the keys.
- **Dock keys:** the composer keeps the keys. The files, the processes, and
  the keys sheet take them when they open, and the camera leaves them with
  the composer. In a layer, Esc gives the keys back to the composer, and the
  layer stays open. In the composer, Esc closes the top layer while the dock
  shows. In the files layer, the first Esc clears the search. Ctrl+O gives
  the keys back to the dock. Tab shows the next layer. Ctrl+C closes the top
  layer while the dock has the keys, and so does `q` in every layer but the
  files. The footer shows `Esc close` while the dock shows.
- **Camera viewfinder:** `/camera` shows a layer in the dock with the
  cameras that the open room shows. The Engineer shows a camera with a
  `frame` widget after its camera server answers. The layer draws one box
  for each shown camera, four at most, stacked. A box holds the title of
  the widget, or its name, the latest frame, its age, and a note when a
  read fails. A `hide` of the widget removes its box. When the Engineer
  shows no camera, the layer says so and asks you to have the Engineer show
  the camera. When the process of a camera ends, the box says so, and it
  draws a frame again after a new `show`.
- **Camera reads:** the layer follows the room that the terminal opens. It
  reads each camera every 3 seconds while it is on top of the dock. Each
  read is a normal `GET` of `/camera/observe` and of the frame, which the
  sensor server logs. The workspace keeps no snapshot of it. The layer reads
  a process only when the author of the widget runs it. A body over 1 MiB
  for an observation, or over 16 MiB for a frame, is a failed read.
- **Camera layout:** each frame keeps its 16:9 shape. A second `/camera`
  closes the layer when it is on top. The composer stays active while the
  layer shows. Another layer on top covers the camera and stops its reads.
  The camera shows again when that layer closes. A terminal under 100
  columns does not show it, and `/camera` closes an open camera layer
  there. The layer needs a terminal with Kitty graphics, such as Ghostty.
- **Look now:** the Engineer shows each camera with the action "Look now".
  The layer draws it as a button under the box of the camera. Ctrl+L takes
  the keys, Up and Down choose a button, Enter presses it, and Esc goes
  back. A press is a message of you to the Engineer, which observes that
  camera and answers. The button is inactive when the widget is `for`
  another person, or when the room is stopped. A refusal shows its reason,
  and a press that the host could not confirm goes again as it was.
- **Keys:** Ctrl+C clears the composer, and it cancels a new room that
  waits for its goal. In the dock it closes the top layer. Ctrl+D twice
  in 2 seconds leaves the terminal from an empty composer, and `/quit`
  also leaves. The rooms stop with the terminal.
- **Voice mode:** `/voice` switches voice mode on and off. Hold Space on
  an empty composer to record, and let go to send what you said as a message.
  A press under 300 ms sends nothing. Ctrl+C drops a recording. A transcript
  goes to the room that was open when you pressed Space. When you switch
  room before it is ready, Workbench drops it and shows the words. The
  terminal records mono audio at 16 kHz. It transcribes with
  `whisper-server` of whisper.cpp, which runs on this computer. No audio
  leaves it. The terminal must report key release: Kitty and Ghostty do.

  `/voice` starts `whisper-server` on a free port of `127.0.0.1`, and the
  model stays loaded until you switch voice mode off or leave the terminal.
  The line "loading model" shows until the model is ready. A recording that
  you make before then waits for the model, and Workbench sends it when the
  model is ready. When the server ends by itself, one line shows its last
  message, and the next press of Space starts it again. When the system
  kills Workbench with SIGKILL, the server can stay. End it with
  `pkill whisper-server`.

  Set up once with `make voice`. It installs `whisper-cpp` with Homebrew
  and downloads the model of about 3 GB to
  `~/.cache/whisper/ggml-large-v3.bin`. `WORKBENCH_WHISPER_MODEL` names
  another model file, such as `ggml-large-v3-turbo.bin` for speed. Whisper
  reads the speech as English. `WORKBENCH_WHISPER_LANGUAGE` names another
  language, such as `ro`, and `auto` makes whisper detect it. The first press
  asks macOS for the microphone.

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
