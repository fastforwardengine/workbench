# Next

**The next work is one use case: an LED parameter sweep.** A power
supply drives an LED through a range of currents. A camera measures the
light at each step. The supply and the camera connect to a workstation.
It is the first use case on real hardware.

The activities below come in order. Each one ends with a result that a
person can check. Check off an item when it ships, and remove an activity
when every item is done. `backlog.md` holds the work that is not
immediately actionable.

## 1. Decide the hardware

- [ ] Name the power supply, its interface (such as SCPI over USB or
      LAN), and its current and voltage ranges.
- [ ] Name the camera, its interface (such as a USB camera), and the
      controls that the sweep holds fixed: exposure, gain, and white
      balance.
- [ ] Name the LED and its maximum forward current.

**Done when** `library/` holds a datasheet summary for the LED, the
supply, and the camera, and each limit cites its source.

## 2. Make the sweep the project of the lab

- [x] Add a `led-sweep` room to `src/domain/scenarios.ts`, with its goal
      and its seats: Datasheets, Experiments, and Instruments at
      `broadcast`.
- [ ] Describe the bench in `/shared/kit.md`: the parts of step 1, the
      connections, and the house rules. The seed holds a placeholder.
- [ ] Give the room goal the LED limit from the datasheet.

**Done when** a person opens the `led-sweep` room, and a specialist
cites the LED limit from `/library`.

## 3. Write the test plan

- [ ] Experiments writes the plan from the `test-plan` template: the
      variable (the LED current), its range and step, the camera controls,
      the settle time, the frames at each step, and the current limit.

**Done when** the plan is on a pushed branch of a fork of
`templates/test-plan`.

## 4. Add the `led-sweep` template

- [ ] Follow `docs/templates.md`. The template holds a script that steps
      the supply, reads the camera at each step, and writes one CSV row
      for each step: the current, the voltage, and the brightness.
- [ ] It has a simulated mode that needs no hardware.
- [ ] It refuses a setpoint above the limit in its configuration.
- [ ] Its `README.md` tells the agent to start the sweep with a `name`.
      `bash` then returns while the sweep runs as a background process.
      The agent reads the end with `wait` or `status`. The sweep of
      Ambion's example, `templates/firmware-sketch/sweep`, shows the
      pattern.
- [ ] Its `README.md` tells the agent to commit the CSV of each run and
      push the branch. The pushed CSV is the record of the run.

**Done when** the simulated mode writes a CSV, and a scripted test checks
it. The test starts the sweep in one exchange and reads its end in a
later one, as the sweep test in Ambion's example `tool-set.test.ts` does.

## 5. Connect the workstation

- [ ] Define the host, the network, and the accounts. Ambion's
      `@ambionframework/workstation` runs the shell of each agent over SSH,
      with one Unix account for each agent.
- [ ] Replace `justGitBackend` with `workstationGitBackend` from the same
      package. One account on the workstation, such as `lab-git`, owns
      every repository. Each agent clones and pushes with its own `git` over
      SSH, and the host opens no port.
- [ ] Move the bash backend from the local just-bash directory to the
      workstation.

**Done when** an agent forks `led-sweep`, clones it on the workstation,
and runs the simulated mode there.

## 6. Give the sweep to Instruments

- [ ] Instruments prepares the sweep, runs it, and reports the run: the
      branch, the CSV, and the brightness against the current.

**Done when** a scripted room runs the sweep in simulated mode, and an
eval in `test/live` grades the report of Instruments.

## 7. Run the sweep on the bench

- [ ] A person asks for the sweep in the `led-sweep` room.
- [ ] The sweep script refuses a setpoint above the limit of the LED.

**Done when** the CSV of a real sweep is on a pushed branch, and the
summary of the room cites the plan and the run.
