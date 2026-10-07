# Breakout rooms

**A breakout room runs one task in the background while the room that
opened it continues.** A specialist opens it for a task that needs many steps
and whose result the room does not need for its next step. A person can
compare it to a parallel thread. Ambion's
[canvas design](https://github.com/ambionframework/ambion/blob/main/docs/canvas.md)
holds the contract for the tools, the bridge, and the limits.

## Where each part lives

| Part             | Where                             | What it holds                                         |
| ---------------- | --------------------------------- | ----------------------------------------------------- |
| The twins        | `src/domain/definitions.ts`       | `twinOf`, `BREAKOUT_TEAM`, and the rules of the twins |
| The skills       | `src/domain/skills.ts`            | `specialistSkills`, which both seats of a pair use    |
| The wiring       | `src/host/rooms.ts`               | `canvas.tools()`, and the `agents` of each root room  |
| The view         | `src/host/rooms.ts`               | `breakout` in the `RoomView` of a breakout room       |
| The terminal     | `src/terminal/state/breakouts.ts` | The count, the label, and the order of the room list  |
| The addressing   | `src/host/host.ts`                | `deliver` seats no specialist in a breakout room      |
| The tool phrases | `src/view/tool-phrases.ts`        | `breakout`, `tell`, `archive`, and `report`           |
| The accounts     | `workstation/accounts`            | The Unix accounts of the twins, in no device group    |
| The checks       | `test/breakout.test.ts`           | The tools, the prompts, and the path of one task      |
| The host checks  | `test/host-breakout.test.ts`      | The view, the watchers, and the messages of a person  |

## The twins

**Each specialist has a twin that does its tasks.** A twin is the seat of a
specialist in a breakout room. It has the name `<specialist>-bg`:
`researcher-bg` and `engineer-bg`. `twinOf` makes the name, and
`BREAKOUT_TEAM` lists the twins. A root room seats the agents that its
`agents` list names, and `create` names the specialists. No root room seats
a twin. A breakout room seats it at `broadcast`.

- **Its identity:** the field `twinIdentity` of the specialist, when it
  has one. The Engineer twin writes and tests scripts and reads data. When
  the field is absent, the identity of the specialist, then one sentence
  that says the twin does one task in a breakout room and reports the
  result. The Researcher twin has that identity.
- **Its tools:** the workspace tools, and `canvas.tools()`. It has no
  widget tools. The canvas refuses `breakout`, `tell`, and `archive` in a
  breakout room.
- **Its skills:** the skills of the specialist.
- **Its rules:** the shared rules, the groups `Project`, `Evidence`, and
  `Constraints` of the specialist, and the breakout rules. It has no group
  `Background`, no `Speaking` rule of the specialist, and no room-only rule.
- **Its model:** the model and the thinking level of the specialists.
- **Its account:** the Unix account with the name of the twin on the
  workstation.

## Where each rule lives

**Each rule has one home.**

| Rule                                                             | Home                                 | Holder          |
| ---------------------------------------------------------------- | ------------------------------------ | --------------- |
| When Ambion allows a breakout room, `tell`, `archive`, the reply | Ambion guidance of the canvas bundle | Each specialist |
| When to open a breakout room, and what to put in the brief       | The group `Background`               | Each specialist |
| Examples of a breakout task                                      | The `Background` rules of the seat   | Each specialist |
| Which twin to seat: the own twin of the specialist               | The group `Background`               | Each specialist |
| A rule that needs the person or the devices                      | `roomOnly` of the specialist         | Each specialist |
| That no person is in the room                                    | The breakout rules, `Speaking`       | Each twin       |
| What the twin does when the brief lacks an input                 | The breakout rules, `Speaking`       | Each twin       |
| How to send the result                                           | The breakout rules, `Speaking`       | Each twin       |
| What the twin cannot do                                          | The breakout rules, `Constraints`    | Each twin       |
| The project, the evidence, and the skills of a specialist        | The groups of the specialist         | Both seats      |
| Project, evidence, and the limits of the person                  | The shared groups                    | Every seat      |

The group `Background` states Workbench's own policy: which task leaves the
room and which task stays. Ambion's guidance states the mechanism, so the
Workbench text does not repeat it.

The shared `Background` rule names no example. The Researcher names the
tasks of research: compare the datasheets of several parts, or draft a test
plan. The Engineer names the tasks of code: write and test a script, or read
the data files of a capture.

**Each specialist seats its own twin.** The `Background` rule of a
specialist names that twin: `researcher-bg` for the Researcher, `engineer-bg`
for the Engineer. The Engineer has no rule to seat the Researcher twin. It
asks the Researcher with `to` for a limit, a choice between parts, or a test
plan. The Researcher can then open its own breakout room. This gives one
route for research.

## The room-only rules

**A rule that needs the person or the devices holds only in the main
room.** The specialist spec has an optional field `roomOnly`, with rules for
the groups. The specialist follows them. Its twin does not. The Engineer has
two: ask the person before the first run that turns on an output of a
device, and name the hands-on work that a physical setup needs. The rule that
bans a change outside a script from a template stays in `Constraints`, so
both seats follow it.

**The twin works with no person.** The first breakout rule in `Speaking`
says that no person is in the room. The twin asks the person for no input and
waits for no reply. The breakout rule in `Constraints` tells the twin to
report a step that needs a device or the person.

## Why a twin has no access to the devices

**A task that drives a device stays in the room of the Engineer.** The
accounts of the twins are in no device group. The Dockerfile gives
`dialout`, `video`, `plugdev`, and `audio` to `engineer` alone, so a twin
cannot open a serial port, a camera, or a power supply. A skill that drives a
device runs in a breakout room only on its simulator, when it has one. A task
that needs the person for an approval, hands-on work, or a photo also stays
in the room, because a breakout room has no person.

## How a result comes back

1. The specialist calls `breakout` with a name, a goal, a message, and the
   twin. It says in one line what runs, and it continues.
2. The twin does the task, and calls `report` once with its refs.
3. The report lands in the parent room, addressed to the opener, with the
   text `breakout <room>: ...`.
4. The opener reads the refs of the report, calls `archive`, and says the
   result to the room.

**A report is the claim of a twin.** The opener checks its refs before it
says the result. A twin that lacks an input reports what is missing as
its result.

**A person sees the breakout rooms in the room list.** The view of a breakout
room names its parent and its opener. An archived room does not start again.
The host refuses `resume` on it. A person can send a message to a twin in a
breakout room that is running. The host seats no specialist there.

## In the terminal

**The terminal shows two facts and adds no layer.** The person sees that
background work runs, and sees how to open it.

- **The count:** while the open room has breakout rooms that run, the status
  row under the input shows a dim count at the right, such as
  `2 in background`. A breakout room runs when the host holds its live room.
  A stopped parent or a failed start leaves none, so the count does not
  include it. The count turns coral while one running room has an open
  exchange. On a narrow terminal, the row drops the count after the other
  counts and before the keys hint. The row shows no count when no breakout
  room runs.
- **The label:** in a breakout room, the right edge of the participants row
  reads `breakout of <parent>`. An archived room adds `done` or `failed`.
- **The room palette:** Ctrl+R and `/room ` list each root room, then its
  breakout rooms. The detail of a breakout row is `working`, `running`,
  `stopped`, `done`, or `failed`, then the goal. A room that the host does
  not run shows `stopped`. The list shows an archived breakout room only for
  the open room, or for the parent of the open room. `/room <name>` opens
  the breakout room.
- **The seats:** in a breakout room, `@` offers the agents that the room
  seats, which are twins. The mention check uses the same agents. A
  root room offers every specialist.
- **An archived room:** the terminal opens it to read, and does not enter
  it. A message there fails with `<room> is archived. It takes no message.`
- **The refresh:** the session calls `watchRooms` of the host once, when it
  starts, and ends the watch when it leaves. The host calls back when a room
  opens, starts, stops, or is archived. A widget or an answer calls nothing.
  Each call reads the room list again, and calls during a read join into one
  more read. The slow poll of the room list covers the rest, such as the
  open exchange of a breakout room.
