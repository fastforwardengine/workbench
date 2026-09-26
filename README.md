# Workbench

**A shared lab workspace where people and specialists work on electrical
engineering, hardware, and electrochemistry.** It runs on
[Ambion](https://github.com/ambionframework/ambion) 0.3.0 and follows
[Ambion's example](https://github.com/ambionframework/ambion/tree/main/examples/workbench).
It is a scaffold. [`planning/next.md`](planning/next.md) holds the next
work: an LED parameter sweep on real hardware.

## Install

Use Node 26.4 or newer, on macOS or Linux.

```sh
npm install -g @fastforwardengine/workbench
export ANTHROPIC_API_KEY=...       # or put it in .env in the working directory
workbench                         # data in ./.data
workbench ./bench                 # another directory
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
  (the default, `anthropic/claude-sonnet-4-5`), `openai`
  (`openai/gpt-5.6-luna`), or a full Pi model ID. Every seat thinks at
  the `low` level (`THINKING` in `src/domain/families.ts`).
- **A seat whose key is not set does not run.** The header marks it
  `no key`, and the other seats keep running.
- **The terminal opens as the person named for your OS account.** That
  person is the one person of Workbench.
- **A new data directory gets the `led-sweep` room and the library.** An
  existing one resumes its rooms.

## The team

**Three specialists hear every message, at `broadcast`. The assistant
writes the closing summary.** Every seat runs on Pi.

| Seat        | Work                                                   | Tools     |
| ----------- | ------------------------------------------------------ | --------- |
| Assistant   | Seats and unseats specialists, and summarizes          | None      |
| Datasheets  | States limits from `/library`, with the source         | Workspace |
| Experiments | Writes a short, repeatable test plan                   | Workspace |
| Instruments | Prepares and runs the bench scripts, and reports a run | Workspace |

**The workspace tools are the only tools.** They read and write files,
run shell commands as background processes, and fork the git templates.
The shell has `sqlite3`, so a specialist makes a database when a result
needs one. A bench script comes from a template.

## The lab

- **Room:** `led-sweep`. `/new` adds a room with the same three seats.
- **Workspace:** one directory for every room. It holds `/library`,
  `/shared`, and a home for each agent.
- **Templates:** git repositories that an agent forks and pushes to. See
  [`docs/templates.md`](docs/templates.md).

The library holds no datasheet yet, and no real hardware is connected.
Every measurement is a planned value.

## Develop

| Command          | What it does                                             |
| ---------------- | -------------------------------------------------------- |
| `pnpm check`     | Format, types, lint, and the scripted tests. CI runs it. |
| `pnpm format`    | Writes the formatting and the lint fixes                 |
| `pnpm test`      | The scripted tests: no key, no network                   |
| `pnpm test:live` | The evals on the simulator: needs a key, and costs money |
| `pnpm build`     | Writes the bundle of the npm package, `dist/main.mjs`    |

**`src/` has four layers, and an import points down only.** Biome holds
the rule.

```text
domain/     the person, the specialists, the room, and the templates
view/       projections of the room record: steps, timeline, refs
host/       rooms, files, processes, and the git backend
terminal/   the OpenTUI terminal
```

## Release

**A release publishes the head of `main` to npmjs, and tags the commit.**
Run the `Release` workflow from the Actions tab, or with
`gh workflow run release.yml`. It runs `pnpm check`, builds
`dist/main.mjs`, publishes with provenance, and pushes the tag.

**The version is `<major>.<minor>.<count>-g<hash>`,** such as
`0.1.14-g1a852f1`. `package.json` holds the base, `0.1`. The count is the
number of commits of `main`, so each release has a higher version. The
hash is the short hash of the commit. The tag is the version with a `v`.
`node scripts/release-version.ts` prints the version of the checkout.

**The workflow needs no npm token.** npm trusted publishing accepts the
identity of the workflow. The settings of the package on npmjs name the
repository `fastforwardengine/workbench` and the workflow `release.yml`.

## License

Apache License 2.0. See [`LICENSE`](LICENSE).
