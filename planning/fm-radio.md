# The FM radio kit

**The kit is a digital FM receiver in a clear case.** A tuner module does
the radio, and a small microcontroller reads the buttons and drives the
display. [`next.md`](next.md) holds the milestone that builds on it.

![The FM radio kit](fm-radio-kit.jpg)

## What the photo shows

**The parts below come from the product photo, the manual, and the
schematic.** The datasheets and the circuit are in
[`datasheets/`](../datasheets/README.md). Each part needs a check against the
kit when it arrives. Activity 2 of [`next.md`](next.md) settles them.

| Part                                              | Marking in the photo         | Role                                                                         |
| ------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------- |
| FM tuner module                                   | RDA5807FP-M                  | The receiver: tuning, demodulation, and signal strength, controlled over I²C |
| Microcontroller, 16 pins                          | STC8G1K17, in a DIP16 socket | Reads the four buttons, drives the tuner and the display                     |
| Amplifier module                                  | 8002                         | Audio to the speaker                                                         |
| Charging module                                   | CAI-222                      | Charges a 3.7 V lithium cell from micro-USB. Probably a TP4056 board         |
| 4-digit 7-segment display                         |                              | The frequency, such as 103.8                                                 |
| Buttons                                           | V−, V+, CH−, CH+             | Volume, and the previous or next station                                     |
| Speaker, headphone jack, telescopic antenna, case |                              |                                                                              |

**The board brings the bus of the tuner to its silkscreen.** The photo
shows FMIN, GPIO2, GPIO3, LOUT, ROUT, GND, 3V3, SCLK, and SDA beside the
tuner module. Paths B and C use SCLK and SDA. LOUT and ROUT give the audio
to a USB audio input.

## The three paths to agent control

| Path | How                                                                                            | The team gets                                                     | Effort |
| ---- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------ |
| A    | A Pico presses the buttons through transistors or an optocoupler. The camera reads the display | Station steps and volume. No signal strength                      | Low    |
| B    | The Pico takes the I²C bus, with the STC8G1K out of its socket                                 | Any frequency, seek, volume, and the signal strength of the tuner | Medium |
| C    | New firmware for the STC8G1K adds a serial command interface                                   | All of B, with the buttons and the display still working          | High   |

**Path A changes nothing on the board.** The Pico closes each button
through a PN2222 or the 4N35 of the ELEGOO kit. The team knows the
frequency only from the display, so the camera and its digit reading
carry path A.

The [`usb-camera` template](../templates/usb-camera/README.md) supplies
saved still frames for this check. The Engineer owns the foreground server.
Each specialist can `fetch` from the process and cite the snapshot refs
that it returns. Aim the camera at the bench so that the display is
legible. The template has no digit recognition, change detection,
automatic crop, or face blur. Those stay in the perception plan. The
specialist reports an unreadable digit as unclear.

The template also serves the microphone of the camera as the sensor
`microphone`. It records the audio output of the radio as a WAV clip with
a level series.

**Path B makes the Pico the only master of the bus.** The STC8G1K comes out
of its socket, and the Pico drives the RDA5807 directly. Both run at 3.3 V.
The display and the buttons go dark. The STC8G1K goes back in its socket to
restore the stock radio.

**Path C keeps the radio whole.** The stock firmware cannot be read back
from the STC8G1K, so a spare chip holds it. The new firmware runs on the
chip from the kit, or on a second spare.

## On hand

**The person has two FM radio kits, the ELEGOO Electronics Fun Kit, and
soldering equipment.** The first FM kit is built by hand, and carries paths
A and B. The second kit is built with the guidance of the team.

**The ELEGOO kit gives the breadboard work around the radio:** the wiring
of the Pico, the button presses of path A, and the pull-up resistors of the
bus.

![The ELEGOO Electronics Fun Kit: a breadboard, a breadboard power module, jumper wires, LEDs, resistors, capacitors, PN2222 transistors, a 74HC595, a 4N35 optocoupler, buttons, and buzzers](elegoo-kit.jpg)

| Item                                                     | For the radio                                                                                       |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Two FM radio kits                                        | The first for paths A and B, built by hand. The second for the guided build                         |
| Soldering iron, solder, flux, desoldering wick           | The assembly of both kits (activities 2 and 7 of [`next.md`](next.md))                              |
| ELEGOO kit: breadboard, jumper and Dupont wires, headers | The connections of the Pico to the radio                                                            |
| ELEGOO kit: PN2222 transistors, 4N35 optocoupler         | Path A: the Pico closes each button of the radio                                                    |
| ELEGOO kit: resistors (1 kΩ, 5.1 kΩ, 10 kΩ)              | Base resistors of the transistors, and pull-ups of SCLK and SDA when the board has none             |
| ELEGOO kit: breadboard power module                      | 5 V and 3.3 V on the breadboard, from a 9 V adapter                                                 |
| HANMATEK HM310P                                          | The first power-on of the radio, current-limited                                                    |
| Logitech BRIO camera                                     | The view of the bench, and the digits of the display in path A                                      |
| USB microphone                                           | The sound of the radio and the bench, independent of the camera                                     |
| Lambda Vector workstation: two RTX 4090, 128 GB RAM      | The workstation of the workspace, and the perception of images and sound (see [`next.md`](next.md)) |

## To get

| Item                                             | For                         | Status                  |
| ------------------------------------------------ | --------------------------- | ----------------------- |
| Raspberry Pi Pico, with pin headers              | Paths A and B               | Buy                     |
| Micro-USB data cable, for the Pico               | Paths A and B               | Buy                     |
| USB-to-serial adapter, 3.3 V (CH340 or CP2102)   | Path C                      | Buy                     |
| Spare STC8G1K, of the exact type on the board    | Path C                      | Buy                     |
| 9 V / 1 A adapter, 5.5 × 2.5 mm, center positive | The breadboard power module | Buy, if none is at hand |
| USB audio input, with a line or mic input        | Listening                   | Optional                |
| Multimeter with a PC interface                   | Guidance                    | Optional                |

## Facts to settle

**The documents in [`datasheets/`](../datasheets/README.md) settle these
facts.** The schematic picture and the datasheets give the type of the
microcontroller (STC8G1K17, DIP16), the button pins (P3.1, P3.0, P5.4, and
P5.5 for V−, V+, CH−, and CH+), the pins of the tuner outputs, and the
supply. The micro-USB port only charges the lithium cell. A 3.3 V regulator
on the tuner module feeds the tuner chip and the microcontroller.

These facts stay open:

- Whether the programming pins P3.0 and P3.1 of the STC8G1K17 reach a
  header.
- How the display is wired. The schematic shows eight drive lines, and a
  plain 4-digit display needs twelve.
- Whether the RDA5807FP decodes RDS in the stock firmware. The chip
  supports it. RDS gives the name of a station, which the team can check
  against its tuning.
- Whether the board has pull-up resistors on SCLK and SDA. The schematic
  picture shows none.
- Which band the stock firmware sets. The product page says 50 to 108 MHz,
  and the chip defaults to 87 to 108 MHz.
- The marking of the charging module, and the datasheet of the 662K
  regulator.
- The readings of the first power-on: VDD, the net 3V3, and the current of
  the radio at idle and at full volume.
