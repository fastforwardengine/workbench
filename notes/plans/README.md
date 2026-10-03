# Plans

One file for each test: `plans/<test>.md`, such as `plans/press-ch-plus.md`.
A plan is short and repeatable: a technician runs it without a question.
The Researcher writes the plan with the `write-a-test-plan` skill.

## Format

Start the file with the title `# Test plan: <test>`. Then write these
sections, in this order.

| Section          | Holds                                                         |
| ---------------- | ------------------------------------------------------------- |
| `Question`       | The one question that the test answers                        |
| `Setup`          | A table of the device and each instrument: model, source      |
| `Variable`       | The one value that the test changes, its range, and its step  |
| `Controls`       | Each value that stays fixed, and how the test holds it        |
| `Measurement`    | A table: quantity, instrument, unit, and resolution           |
| `Limits`         | A table: limit, value, and the `library/` source of the value |
| `Procedure`      | Numbered steps                                                |
| `Pass criterion` | The result that answers the question, as a number with a unit |

The test stops at once when a value reaches a limit. State this sentence
under the table of limits.

## Rules

- **Cite each limit.** Give the datasheet in `library/` for each limit. Do
  not invent a value.
- **Mark a missing value `TBD`.** Name the limit and the datasheet that must
  supply it.
- **Give the pass criterion as a number with a unit.**
- **Keep one plan for one question.** Write a second file for a follow-up
  test.
