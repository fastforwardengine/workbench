# Breakout rooms

**A breakout room runs one task in the background while the room that
opened it continues.** A specialist opens it for a task that needs many steps
and whose result the room does not need for its next step. A person can
compare it to a parallel thread. Ambion's
[canvas design](https://github.com/ambionframework/ambion/blob/main/docs/canvas.md)
holds the contract for the tools, the bridge, and the limits.

## Where each part lives

| Part             | Where                             | What it holds                                             |
| ---------------- | --------------------------------- | --------------------------------------------------------- |
| The definitions  | `src/domain/definitions.ts`       | One definition for each specialist, and its rules         |
| The skills       | `src/domain/skills.ts`            | `specialistSkills`, which every room of a specialist uses |
| The wiring       | `src/host/rooms.ts`               | `canvas.tools()`, and the `agents` of each root room      |
| The view         | `src/host/rooms.ts`               | `breakout` in the `RoomView` of a breakout room           |
| The terminal     | `src/terminal/state/breakouts.ts` | The count, the label, and the order of the room list      |
| The addressing   | `src/host/host.ts`                | `deliver` seats no other specialist in a breakout room    |
| The tool phrases | `src/view/tool-phrases.ts`        | `breakout`, `tell`, `archive`, and `report`               |
| The checks       | `test/breakout.test.ts`           | The tools, the prompts, and the path of one task          |
| The host checks  | `test/host-breakout.test.ts`      | The view, the watchers, and the messages of a person      |

## The seat

**A specialist has one definition for every room.** The Engineer in a root
room and the Engineer in a breakout room are the same definition: the same
identity, rules, skills, and model. The room decides who is present and
whether the room has an opener. Ambion's guidance states that part: a
question for a person goes to a present person, and a room with no person
reports it to the opener.

**A specialist seats itself in the breakout room that it opens.** The
`agents` of `breakout` names its own name. A root room seats the specialists
that its `agents` list names, and `create` names both. A breakout room seats
only the agents that the opener chose. It sees the `goal` and the `message`
of the opener, and nothing else of the parent. It shares the home of the
specialist, because the workspace keys a home by the name of the agent.

**A breakout room has no person and no device.** The rules say so, because
the account of the specialist on the workstation holds the device groups in
every room. A skill that drives a device runs in a breakout room only on its
simulator. The seat reports a step that needs a device or the person to the
opener. A task of this kind stays in the room of the person.

## Where each rule lives

**Each rule has one home.**

| Rule                                                              | Home                                 | Holder          |
| ----------------------------------------------------------------- | ------------------------------------ | --------------- |
| When Ambion allows a breakout room, `tell`, `archive`, the report | Ambion guidance of the canvas bundle | Each specialist |
| Where a question for a person goes                                | Ambion guidance of the canvas bundle | Each specialist |
| When to open a breakout room, and what to put in the brief        | The group `Background`               | Each specialist |
| Seat yourself: the own name in `agents`                           | The group `Background`               | Each specialist |
| Examples of a breakout task                                       | The group `Background`               | Each specialist |
| No person and no device in a breakout room                        | `Constraints` of the shared rules    | Every seat      |
| How to send the result, and a missing input                       | `Speaking` of the specialist rules   | Each specialist |
| No `show` in a breakout room                                      | `Constraints` of the Engineer        | Engineer        |
| Approval and hands-on work                                        | `Constraints` of the Engineer        | Engineer        |
| The project, the evidence, and the skills of a specialist         | The groups of the specialist         | Each specialist |
| Project, evidence, and the limits of the person                   | The shared groups                    | Every seat      |

The group `Background` states Workbench's own policy: which task leaves the
room and which task stays. Ambion's guidance states the mechanism, so the
Workbench text does not repeat it.

**A rule that differs by room names the room.** The approval rule and the
hands-on rule of the Engineer start with `In a root room`, because the
person is there. The report rules start with `In a breakout room`. The
Engineer holds the widget bundle but has no camera in a breakout room, so a
rule forbids `show` there.

**The Engineer asks the Researcher for research.** It has no rule to seat
the Researcher in a breakout room. It asks the Researcher with `to` for a
limit, a choice between parts, or a test plan. The Researcher can then open
its own breakout room. This gives one route for research.

## How a result comes back

1. The specialist calls `breakout` with a name, a goal, a message, and its
   own name. It says in one line what runs, and it continues.
2. The seat in the breakout room does the task, and calls `report` once
   with its refs.
3. The report lands in the parent room, addressed to the opener, with the
   text `breakout <room>: ...`.
4. The opener reads the refs of the report, calls `archive`, and says the
   result to the room.

**A report is a claim.** The opener checks its refs before it says the
result. A seat that lacks an input reports what is missing as its result.

**A person sees the breakout rooms in the room list.** The view of a breakout
room names its parent and its opener. An archived room does not start again.
The host refuses `resume` on it. A person can send a message to the seat in a
breakout room that is running. The host seats no other specialist there.

## In the terminal

**The terminal shows the breakout rooms and adds no layer.** The person
sees that background work runs, where the open room sits, and how to move
between a room and its breakout rooms.

- **The count:** while the open room has breakout rooms that run, the status
  row under the input shows a dim count at the right, such as
  `2 in background`. A breakout room runs when the host holds its live room.
  A stopped parent or a failed start leaves none, so the count does not
  include it. The count turns coral while one running room has an open
  exchange. On a narrow terminal, the row drops the count after the other
  counts and before the keys hint. The row shows no count when no breakout
  room runs.
- **The path:** in a breakout room, the room row of the header reads
  `<parent> › <short>`, such as `build › datasheets`. The parent is dim. The
  short name is the name of the room without the `<parent>-` prefix. The
  right edge of the participants row shows the state of the room with its
  mark, such as `○ running` or `✓ done`. A root room shows its pattern
  there. The terminal title uses the same path.
- **The room palette:** Ctrl+R and `/room ` show the rooms as a tree. Each
  root room has its breakout rooms under it, indented, with the short name.
  A mark before the short name gives the state: `●` working, `○` running,
  `–` stopped, `✓` done, `✗` failed, `·` archived with no result. The detail of a breakout row is the
  state word, then the goal. A room that the host does not run shows
  `stopped`. The list shows an archived breakout room only for the open
  room, or for the parent of the open room. A filter matches the full name
  or the short name. The row inserts the full name.
- **The pick:** when the palette opens, it picks one row. In a breakout
  room, it picks the parent, so Ctrl+R and then Enter go back. In a room
  with breakout rooms that run, it picks the last of them in the list. Else
  it picks the open room.
- **The seats:** in a breakout room, `@` offers the agents that the room
  seats, which is the specialist that opened the room. The mention check uses the
  same agents. A root room offers every specialist.
- **An archived room:** the terminal opens it to read, and does not enter
  it. A message there fails with `<room> is archived. It takes no message.`
- **The refresh:** the session calls `watchRooms` of the host once, when it
  starts, and ends the watch when it leaves. The host calls back when a room
  opens, starts, stops, or is archived. A widget or an answer calls nothing.
  Each call reads the room list again, and calls during a read join into one
  more read. The slow poll of the room list covers the rest, such as the
  open exchange of a breakout room.
