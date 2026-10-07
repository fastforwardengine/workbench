# Breakout rooms

**A breakout room runs one task in the background while the room that
opened it continues.** A specialist opens it for a task that needs many steps
and whose result the room does not need for its next step. A person can
compare it to a parallel thread. Ambion's
[canvas design](https://github.com/ambionframework/ambion/blob/main/docs/canvas.md)
holds the contract for the tools, the bridge, and the limits.

## Where each part lives

| Part             | Where                        | What it holds                                          |
| ---------------- | ---------------------------- | ------------------------------------------------------ |
| The worker       | `src/domain/definitions.ts`  | `worker`, `WORKER_TEAM`, and the rules of the worker   |
| The skills       | `src/domain/skills.ts`       | `workerSkills`: the shared skills and the Researcher's |
| The wiring       | `src/host/rooms.ts`          | `breakout: { team }`, and the bundles of the canvas    |
| The view         | `src/host/rooms.ts`          | `breakout` in the `RoomView` of a breakout room        |
| The addressing   | `src/host/host.ts`           | `deliver` seats no specialist in a breakout room       |
| The tool phrases | `src/view/tool-phrases.ts`   | `breakout`, `tell`, `archive`, and `report`            |
| The account      | `workstation/accounts`       | The Unix account `worker`, in no device group          |
| The checks       | `test/breakout.test.ts`      | The tools, the prompts, and the path of one task       |
| The host checks  | `test/host-breakout.test.ts` | The view, the watchers, and the messages of a person   |

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
| How to send the result                                           | The group `Speaking` of the worker    | The worker      |
| What the worker cannot do                                        | The group `Constraints` of the worker | The worker      |
| Project, evidence, and the limits of the person                  | The shared groups                     | Every seat      |

The group `Background` states Workbench's own policy: which task leaves the
room and which task stays. Ambion's guidance states the mechanism, so the
Workbench text does not repeat it.

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
says the result. A worker that lacks an input reports what is missing. The
opener answers with `tell`.

**A person sees the breakout rooms in the room list.** The view of a breakout
room names its parent and its opener. An archived room does not start again.
The host refuses `resume` on it. A person can send a message to a worker in a
breakout room that is running. The host seats no specialist there.
