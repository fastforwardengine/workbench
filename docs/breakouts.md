# Breakout rooms

**A breakout room runs one task in the background while the room that
opened it continues.** A specialist opens it for a task that needs many steps
and whose result the room does not need for its next step. A person can
compare it to a parallel thread. Ambion's
[canvas design](https://github.com/ambionframework/ambion/blob/main/docs/canvas.md)
holds the contract for the tools, the bridge, and the limits.

## Where each part lives

| Part             | Where                             | What it holds                                          |
| ---------------- | --------------------------------- | ------------------------------------------------------ |
| The worker       | `src/domain/definitions.ts`       | `worker`, `WORKER_TEAM`, and the rules of the worker   |
| The skills       | `src/domain/skills.ts`            | `workerSkills`: the shared skills and the Researcher's |
| The wiring       | `src/host/rooms.ts`               | `breakout: { team }`, and the bundles of the canvas    |
| The view         | `src/host/rooms.ts`               | `breakout` in the `RoomView` of a breakout room        |
| The terminal     | `src/terminal/state/breakouts.ts` | The chip, the label, and the order of the room list    |
| The addressing   | `src/host/host.ts`                | `deliver` seats no specialist in a breakout room       |
| The tool phrases | `src/view/tool-phrases.ts`        | `breakout`, `tell`, `archive`, and `report`            |
| The account      | `workstation/accounts`            | The Unix account `worker`, in no device group          |
| The checks       | `test/breakout.test.ts`           | The tools, the prompts, and the path of one task       |
| The host checks  | `test/host-breakout.test.ts`      | The view, the watchers, and the messages of a person   |

## The worker

**One definition, `worker`, does the tasks.** It is the worker team of the
canvas. No root room seats it. A breakout room seats it at `broadcast`.

- **Its tools:** the workspace tools, and `report`. It has no widget tools
  and no tool to open a breakout room.
- **Its skills:** the shared skills and the skills of the Researcher.
- **Its model:** the model and the thinking level of the specialists.
- **Its account:** the Unix account `worker` on the workstation.

## Where each rule lives

**Each rule has one home.**

| Rule                                                             | Home                                  | Holder          |
| ---------------------------------------------------------------- | ------------------------------------- | --------------- |
| When Ambion allows a breakout room, `tell`, `archive`, the reply | Ambion guidance of the opener bundle  | Each specialist |
| When to open a breakout room, and what to put in the brief       | The group `Background`                | Each specialist |
| Examples of a breakout task                                      | The `Background` rules of the seat    | Each specialist |
| What the worker does when the brief lacks an input               | The group `Speaking` of the worker    | The worker      |
| How to send the result                                           | The group `Speaking` of the worker    | The worker      |
| What the worker cannot do                                        | The group `Constraints` of the worker | The worker      |
| Project, evidence, and the limits of the person                  | The shared groups                     | Every seat      |

The group `Background` states Workbench's own policy: which task leaves the
room and which task stays. Ambion's guidance states the mechanism, so the
Workbench text does not repeat it.

The shared `Background` rule names no example. The Researcher names the
tasks of research: compare the datasheets of several parts, or draft a test
plan. The Engineer names the tasks of code: write and test a script, or read
the data files of a capture. The Engineer still asks the Researcher with `to`
for a limit, a choice between parts, or a test plan.

## Why the worker has no access to the devices

**A task that drives a device stays in the room of the Engineer.** The
account `worker` is in no device group. The Dockerfile gives `dialout`,
`video`, `plugdev`, and `audio` to `engineer` alone, so the worker cannot
open a serial port, a camera, or a power supply. A task that needs the
person for an approval, hands-on work, or a photo also stays in the room,
because a breakout room has no person.

## How a result comes back

1. The specialist calls `breakout` with a name, a goal, a message, and the
   worker. It says in one line what runs, and it continues.
2. The worker does the task, and calls `report` once with its refs.
3. The report lands in the parent room, addressed to the opener, with the
   text `breakout <room>: ...`.
4. The opener reads the refs of the report, calls `archive`, and says the
   result to the room.

**A report is the claim of a worker.** The opener checks its refs before it
says the result. A worker that lacks an input reports what is missing as
its result.

**A person sees the breakout rooms in the room list.** The view of a breakout
room names its parent and its opener. An archived room does not start again.
The host refuses `resume` on it. A person can send a message to a worker in a
breakout room that is running. The host seats no specialist there.

## In the terminal

**The terminal shows two facts and adds no layer.** The person sees that
background work runs, and sees how to open it.

- **The chip:** while the open room has breakout rooms that run, its header
  shows a dim chip after the participants, such as `⇉ 2 in background`. A
  breakout room runs when the host holds its live room. A stopped parent or
  a failed start leaves none, so the chip does not count it. The chip turns
  coral while one running room has an open exchange. The chip drops before
  the participant names on a narrow terminal. It shows no text when no
  breakout room runs.
- **The label:** in a breakout room, the right edge of the participants row
  reads `breakout of <parent>`. An archived room adds `done` or `failed`.
- **The room palette:** Ctrl+R and `/room ` list each root room, then its
  breakout rooms. The detail of a breakout row is `working`, `running`,
  `stopped`, `done`, or `failed`, then the goal. A room that the host does
  not run shows `stopped`. The list shows an archived breakout room only for
  the open room, or for the parent of the open room. `/room <name>` opens
  the breakout room.
- **The seats:** in a breakout room, `@` offers the agents that the room
  seats, which is the worker. The mention check uses the same agents. A
  root room offers every specialist.
- **An archived room:** the terminal opens it to read, and does not enter
  it. A message there fails with `<room> is archived. It takes no message.`
- **The refresh:** the session calls `watchRooms` of the host once, when it
  starts, and ends the watch when it leaves. The host calls back when a room
  opens, starts, stops, or is archived. A widget or an answer calls nothing.
  Each call reads the room list again, and calls during a read join into one
  more read. The slow poll of the room list covers the rest, such as the
  open exchange of a breakout room.
