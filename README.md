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
codex login                       # host ChatGPT login; or set CODEX_API_KEY
workbench                         # data in ./.data
workbench ./bench                 # another directory
```

**The `workbench` command reads `.env` in the working directory.** A
variable that the environment already sets keeps its value.

## Run from the repository

```sh
pnpm install
codex login                       # or codex login --device-auth
cp .env.example .env              # optional model or API key override
pnpm start                        # data in ./.data
pnpm start ./bench                # another directory
```

- **Every seat runs on Codex with `gpt-6-luna`.** `WORKBENCH_MODEL`
  accepts a Codex model identifier without a provider prefix.
  Light reasoning maps to `modelReasoningEffort: 'low'`.
  [Ambion's Codex guide](https://github.com/ambionframework/ambion/blob/v0.5.0/docs/codex.md)
  states the supported options.
- **The seats use the host login.** Run `codex login` (`npx @openai/codex login` if needed), or set
  `CODEX_API_KEY`. A key takes precedence over the login file.
  `CODEX_HOME` selects the host login folder when set.
- **Codex keeps seat state in `~/.ambion/codex`.** The adapter links the
  host login into that folder. Host tools, skills, and MCP settings stay
  outside the seats. Workspace tools reach the local or remote workstation.
- **A seat without a login does not run.** The header marks it `no login`.
  The failure states how to sign in. For a keyring login, set
  `cli_auth_credentials_store = "file"` in the host Codex configuration,
  then run `codex login` again. The adapter validates the credential and
  model when an activation starts.
- **The terminal opens as the person named for your OS account.** That
  person is the one person of Workbench.
- **A new data directory gets the four radio rooms and the library.** An
  existing one resumes its rooms and has no radio rooms. Move an older
  data directory away, or add a room with `/new radio-kit`.
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

**Three specialists hear every message in a new room, at `broadcast`. The
Builder listens at `named`: it wakes when the assistant or a specialist
addresses it, and not for a message from you. The assistant writes the
closing summary.** Every seat runs on Codex.

| Seat        | Work                                                   | Tools     |
| ----------- | ------------------------------------------------------ | --------- |
| Assistant   | Seats and unseats specialists, and summarizes          | None      |
| Datasheets  | States limits from `/library`, with the source         | Workspace |
| Experiments | Writes a short, repeatable test plan                   | Workspace |
| Instruments | Prepares and runs the bench scripts, and reports a run | Workspace |
| Builder     | Guides an assembly, and checks each part from a photo  | Workspace |

**The workspace tools are the only tools.** They read and write files,
run shell commands as background processes, fork the git templates, and
snapshot a file into a stable ref.
The shell has `sqlite3`, so a specialist makes a database when a result
needs one. A bench script comes from a template.

## The lab

- **Rooms:** one for each phase of the FM radio. A room seats every
  specialist. The owners of the phase hear every message, at `broadcast`.
  The others listen at `named`, and wake when the assistant or an owner
  addresses them. `/new` adds a room with the four default seats. The
  Builder listens at `named` there.

  | Room             | Phase                                          | Owners                   |
  | ---------------- | ---------------------------------------------- | ------------------------ |
  | `radio-kit`      | Know the kit, and support the first hand build | Builder, Datasheets      |
  | `radio-tune`     | Hear the radio, tune it: path A and path B     | Instruments, Experiments |
  | `radio-build`    | Guide the build of the second kit              | Builder, Instruments     |
  | `radio-firmware` | Path C: new firmware                           | Instruments, Datasheets  |

- **State of the bench:** the Git repository `shared/notes` holds facts,
  decisions, and questions with their sources and confidence. Every specialist
  clones it, reads its README.md, and commits and pushes changes.
  [Notes](docs/notes.md) describes the layout and workflow.
- **Workspace:** one directory for every room. It holds `/library`,
  `/shared`, `/attachments`, and a home for each agent.
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
  picture. The files panel shows a picture, also from a snapshot ref.
- **Keys:** Ctrl+C clears the composer, and it cancels a new room that
  waits for its goal. In a side panel it closes the panel. Ctrl+D leaves
  the terminal when the composer is empty, and `/quit` also leaves. The
  rooms stop with the terminal.
- **Staged pictures:** a row above the composer names the files that wait
  for your next message. Press Enter on an empty composer to send them
  alone, with the text `Attached <names>`. A bare `@name` sends them to
  that seat. A failed send keeps the files staged. Ctrl+C on an empty
  composer drops the attachments, and so does a switch to another room.
- **Templates:** git repositories that an agent forks and pushes to. See
  [`docs/templates.md`](docs/templates.md).
- **Skills:** a folder of skills for each specialist, in `skills/`. See
  [`docs/skills.md`](docs/skills.md).

The library holds no datasheet yet, and no real hardware is connected.
Every measurement is a planned value.

## Develop

| Command          | What it does                                              |
| ---------------- | --------------------------------------------------------- |
| `pnpm check`     | Format, types, lint, and the scripted tests. CI runs it.  |
| `pnpm format`    | Writes the formatting and the lint fixes                  |
| `pnpm test`      | The scripted tests: no key, no network                    |
| `pnpm test:live` | The evals: needs a Codex login and judge key; costs money |
| `pnpm build`     | Writes the bundle of the npm package, `dist/main.mjs`     |

**`src/` has four layers, and an import points down only.** Biome holds
the rule.

```text
domain/     the person, the specialists, the room, the templates, and the skills
view/       projections of the room record: steps, timeline, refs
host/       rooms, files, processes, and the git backend
terminal/   the OpenTUI terminal, in three layers of its own
  state/      what it knows and does: the session, the commands, the browsers. No OpenTUI.
  widgets/    what it draws: the transcript, the composer, the panels
  app/        what wires and drives them: the keys, the painter, the surfaces, the entry
```

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
