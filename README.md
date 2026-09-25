# Workbench

**A shared lab workspace where people and specialists work on electrical
engineering, hardware, and electrochemistry.** It runs on
[Ambion](https://github.com/ambionframework/ambion) 0.3.0 and follows
[Ambion's example](https://github.com/ambionframework/ambion/tree/main/examples/workbench).
It is a scaffold. [`planning/next.md`](planning/next.md) holds the next
work: an LED parameter sweep on real hardware.

## Run

Use Node 26.4 or newer.

```sh
pnpm install
cp .env.example .env              # set ANTHROPIC_API_KEY, OPENAI_API_KEY, or both
pnpm start                        # data in ./.data
pnpm start ./bench --as priya     # another directory, and another person
```

- **`WORKBENCH_MODEL`** selects the model of every seat: `anthropic`
  (the default, `anthropic/claude-sonnet-5`), `openai`
  (`openai/gpt-5.6-luna`), or a full Pi model ID.
- **A seat whose key is not set does not run.** The header marks it
  `no key`, and the other seats keep running.
- **The terminal opens as the person named for your OS account.** Set
  `WORKBENCH_USER` or pass `--as` to open as another person.
- **A new data directory gets the sample rooms and the datasheets.** An
  existing one resumes its rooms.

## The team

**An assistant brings in the specialists and writes the closing
summary.** Every seat runs on Pi.

| Seat          | Work                                                     | Tools                      |
| ------------- | -------------------------------------------------------- | -------------------------- |
| Assistant     | Clarifies the request, seats specialists, and summarizes | Workspace, lab, instrument |
| Datasheets    | States limits from `/library`, with the source           | Workspace, lab, instrument |
| Design        | Chooses parts and values, and shows the calculation      | Workspace, lab, instrument |
| Experiments   | Writes a short, repeatable test plan                     | Workspace, lab, instrument |
| Instruments   | Names what a person does by hand; no equipment yet       | Workspace                  |
| Data Analysis | Names the metric to read by hand; no analysis tools yet  | Workspace                  |

## The lab

- **Rooms:** `characterization`, `cycling`, and `budget`. Each one works
  on the 18650 cell kit.
- **Workspace:** one directory for every room. It holds `/library`,
  `/shared`, and a home for each agent. The `sql` tool reaches a shared
  database.
- **Lab database:** the `projects`, `test_plans`, `runs`, `results`, and
  `operations` tables. Two simulated instruments wait for approval above
  their limits.
- **Templates:** git repositories that an agent forks and pushes to. See
  [`docs/templates.md`](docs/templates.md).

The datasheets are summaries, and no real hardware is connected. Every
measurement is a planned value.

## Develop

| Command          | What it does                                             |
| ---------------- | -------------------------------------------------------- |
| `pnpm check`     | Format, types, lint, and the scripted tests. CI runs it. |
| `pnpm format`    | Writes the formatting and the lint fixes                 |
| `pnpm test`      | The scripted tests: no key, no network                   |
| `pnpm test:live` | The live tests: needs a key, and costs money             |

**`src/` has four layers, and an import points down only.** Biome holds
the rule.

```text
domain/     people, specialists, rooms, the lab schema, instruments, templates
view/       projections of the room record: steps, timeline, refs
host/       rooms, approvals, files, and the git backend
terminal/   the OpenTUI terminal
```

## License

Apache License 2.0. See [`LICENSE`](LICENSE).
