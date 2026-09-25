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

- [ ] Describe the bench in `/shared/kit.md`: the parts, the connections,
      and the house rules.
- [ ] Add a `led-sweep` room to `src/domain/scenarios.ts`, with its goal
      and its seats.
- [ ] Replace the simulated instruments with the ones the sweep uses,
      such as `led-current`, with the limit from the LED datasheet.
- [ ] Decide what happens to the three battery rooms: keep them as
      examples, or remove them.

**Done when** a person opens the `led-sweep` room, and a specialist
cites the LED limit from `/library`.

## 3. Write the test plan

- [ ] Experiments writes the plan from the `test-plan` template: the
      variable (the LED current), its range and step, the camera controls,
      the settle time, the frames at each step, and the current limit.

**Done when** the plan is on a pushed branch of a fork of
`templates/test-plan`, and a `test_plans` row names it.

## 4. Add the `led-sweep` template

- [ ] Follow `docs/templates.md`. The template holds a script that steps
      the supply, reads the camera at each step, and writes one CSV row
      for each step.
- [ ] It has a simulated mode that needs no hardware.
- [ ] It refuses a setpoint above the limit in its configuration.
- [ ] Its `README.md` tells the agent to start the sweep with a `name`.
      `bash` then returns while the sweep runs as a background process.
      The agent reads the end with `wait` or `status`. The sweep of
      Ambion's example, `templates/firmware-sketch/sweep`, shows the
      pattern.

**Done when** the simulated mode writes a CSV, and a scripted test checks
it. The test starts the sweep in one exchange and reads its end in a
later one, as the sweep test in Ambion's example `tool-set.test.ts` does.

## 5. Decide how a sweep reaches the lab database

- [ ] Choose one path. Either the supply goes through `operate` and its
      limit, with a real `InstrumentDriver` per `docs/instrument.md`, or
      the sweep script records its rows after the run.
- [ ] Each sweep is one `runs` row. Each step gives `results` rows: the
      current, the voltage, and the brightness.

**Done when** a simulated sweep leaves one run and its results in the lab
database, with provenance.

## 6. Connect the workstation

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

## 7. Give the sweep to its specialists

- [ ] Instruments prepares the sweep, runs it, and reports the run.
- [ ] Data Analysis reads the results and states the brightness against
      the current.
- [ ] Give both specialists the full bundle, and remove the "no
      resource" line from their instructions.

**Done when** the tool-set test shows both specialists with the full
bundle, and a scripted room runs the sweep in simulated mode.

## 8. Run the sweep on the bench

- [ ] A person asks for the sweep in the `led-sweep` room.
- [ ] The operation above any limit waits for the approval of that
      person.

**Done when** a real sweep is in the lab database, and the summary of the
room cites the plan, the run, and the results.
