# Build: first kit

The plan of the first FM radio kit, from the 28 steps of the manual
(`library/fm-radio-kit-manual.md`). The Engineer guides each step by voice.
The person solders. The microscope (the `scope` camera) is the only camera
for every check. The bench camera and the HM310P are not on the bench for
this build.

## Before you start

**Tools:** a soldering iron of 30 to 40 W with a clean tip, solder wire of
0.8 to 1 mm (melting point about 183 °C), flush cutters, the microscope, a
multimeter, a micro-USB cable, and a 5 V USB charger. Source:
library/fm-radio-kit-manual.md, pages 4 to 6.

**Safety rule:** the power stays off until the checks of the build pass.
The radio has no reverse-polarity protection. Source:
library/fm-radio-kit-schematic.md.

**Order of work:** short parts first, then tall parts. Cut the pins after
each part. A joint takes 2 to 3 seconds. Source:
library/fm-radio-kit-manual.md, page 6.

**The microscope check:** for each polarized part, the Engineer applies
`check-a-photo` with the `scope` camera before the person solders. The
person holds the part in place and says "check this". The Engineer answers
pass, fail, or unclear. Solder only on pass. The `Scope:` line of a step
says what the frame must show.

**The places:** the place of a part is its reference in the schematic
(`library/fm-radio-kit-schematic.md`). Confirm the silkscreen label of the
board at the first step that uses it, and correct the plan when it differs.

## Parts of the kit

Count each part against this table before step 1. Record the count in the
`Counted` column. A count marked TBD comes from the bag of the kit.

| Part                    | Value or type         | Count | Place      | Source              | Counted |
| ----------------------- | --------------------- | ----- | ---------- | ------------------- | ------- |
| Resistor                | 47 Ω                  | 7     | R1 to R7   | manual, step 1      | TBD     |
| Micro-USB female socket | Micro-USB             | 1     | USB1       | manual, step 2      | TBD     |
| IC socket               | 16 pins               | 1     | U1         | manual, step 3      | TBD     |
| Toggle switch           | Power, source select  | 1     | S5         | manual, step 4      | TBD     |
| Headphone jack          | PJ-342A, 3.5 mm       | 1     | PJ1        | schematic           | TBD     |
| Crystal                 | 32.768 kHz            | 1     | M1, Y1     | manual 6, schematic | TBD     |
| Tuner module            | RDA5807FP-M, 11 pads  | 1     | M1         | manual, step 7      | TBD     |
| Display                 | 3641AS, 4 digits, red | 1     | LED1       | manual, step 10     | TBD     |
| Electrolytic capacitor  | 100 µF                | 5     | C1 to C5   | manual, step 11     | TBD     |
| Amplifier module        | 8002-M, 5 pins        | 1     | M2         | manual, step 12     | TBD     |
| Tactile switch          | 4 pins                | 4     | S1 to S4   | manual, step 13     | TBD     |
| Key cap                 |                       | 4     | S1 to S4   | manual, step 13     | TBD     |
| Microcontroller         | STC8G1K17, DIP16      | 1     | U1, socket | manual, step 14     | TBD     |
| Telescopic antenna      | 300 mm, with 3 mm nut | 1     | ANT        | manual 15, 21       | TBD     |
| Battery springs         | For 3 AAA cells       | TBD   | BT1        | manual, step 16     | TBD     |
| Battery wires           | Red and black         | 2     | BT1        | manual, step 18     | TBD     |
| Speaker                 | 4 Ω, 3 W, 40 mm       | 1     | VO+, VO−   | manual 22 to 24     | TBD     |
| Speaker wires           | Red and black         | 2     | VO+, VO−   | manual, step 22     | TBD     |
| Case, foam, screws      | Clear case            | TBD   | Case       | manual 20, 26, 27   | TBD     |
| Charging module         | Probably TP4056       | 1     | M3         | manual, page 14     | TBD     |
| Pin header              | 3P                    | 1     | M3         | manual, page 14     | TBD     |
| Female connector        | 2P, PH2.0             | 1     | Module     | manual, page 14     | TBD     |
| Lanyard                 | Nylon                 | 1     | Case       | manual, page 13     | TBD     |

- **The kit has no battery.** The rechargeable version needs a 3.7 V
  lithium cell with a protection board, about 10 × 30 × 40 mm, with a
  PH2.0 plug. Source: library/fm-radio-kit-manual.md, pages 13 and 14.
- **The last four rows belong to the rechargeable version.** Mark them 0
  when the kit has no charging module.

## Step 1: Resistors

Manual step 1. Page image: `/library/images/manual-p06.jpg`.

| Name     | Value | Place    | Orientation | Mark |
| -------- | ----- | -------- | ----------- | ---- |
| Resistor | 47 Ω  | R1 to R7 | None        | None |

Risk: heat on the board from a long contact.
Check: seven resistors sit flat, each joint is bright and cone-shaped, and
the pins are cut.
Scope: one frame of the joints, for bridges and cold joints.
State: todo
Evidence: none

## Step 2: Micro-USB socket

Manual step 2. Page image: `/library/images/manual-p06.jpg`.

| Name                    | Value     | Place | Orientation        | Mark          |
| ----------------------- | --------- | ----- | ------------------ | ------------- |
| Micro-USB female socket | Micro-USB | USB1  | Follow the outline | The footprint |

Risk: a bridge between the fine pins of the socket. USB power reaches the
radio through this socket.
Check: the socket sits flat in its outline, and no two pins touch.
Scope: before solder, the socket in its outline. After solder, the five
pins, for bridges.
State: todo
Evidence: none

## Step 3: IC socket

Manual step 3. Page image: `/library/images/manual-p07.jpg`.

| Name      | Value   | Place | Orientation                   | Mark      |
| --------- | ------- | ----- | ----------------------------- | --------- |
| IC socket | 16 pins | U1    | Notch on the silkscreen notch | The notch |

Risk: a reversed socket. The chip then goes in the wrong way at step 14.
Check: the notch of the socket and the notch of the silkscreen are at the
same end.
Scope: before solder, both notches in one frame.
State: todo
Evidence: none

## Step 4: Toggle switch

Manual step 4. Page image: `/library/images/manual-p07.jpg`.

| Name          | Value         | Place | Orientation | Mark |
| ------------- | ------------- | ----- | ----------- | ---- |
| Toggle switch | Source select | S5    | Any         | None |

Risk: heat on the middle 3 pins melts the handle.
Check: the handle moves up and down freely.
Scope: after solder, the joints, for bridges.
State: todo
Evidence: none

## Step 5: Headphone jack

Manual step 5. Page image: `/library/images/manual-p07.jpg`.

| Name           | Value           | Place | Orientation        | Mark          |
| -------------- | --------------- | ----- | ------------------ | ------------- |
| Headphone jack | PJ-342A, 3.5 mm | PJ1   | Follow the outline | The footprint |

Risk: heat melts the plastic. Too much solder at the arrow of page 7
shorts two pins.
Check: the jack sits flat, and the pins at the arrow are apart.
Scope: after solder, the pins at the arrow.
State: todo
Evidence: none

## Step 6: Crystal of the tuner module

Manual step 6. Page image: `/library/images/manual-p07.jpg`.

| Name    | Value      | Place  | Orientation | Mark |
| ------- | ---------- | ------ | ----------- | ---- |
| Crystal | 32.768 kHz | M1, Y1 | None        | None |

Risk: heat damages the crystal. Keep the pins long and the contact short.
Check: the crystal sits in Y1 of the module, with long pins.
Scope: after solder, the two joints.
State: todo
Evidence: none

## Step 7: Tuner module

Manual steps 7, 8, and 9. Page image: `/library/images/manual-p08.jpg`.

| Name         | Value       | Place | Orientation                   | Mark          |
| ------------ | ----------- | ----- | ----------------------------- | ------------- |
| Tuner module | RDA5807FP-M | M1    | Pads on the pads of the board | The footprint |

1. Tin one pad of the board.
2. Align the pads of the module with the pads of the board. Solder the
   tinned pad first, so the module cannot move.
3. Solder the other pads.

Risk: a bridge between two pads, a cold joint, or a missed pad.
Check: each of the 11 pads has a joint, and no two joints touch.
Scope: before the other pads, the alignment after the first joint. After
solder, each pad, for bridges and missed pads.
State: todo
Evidence: none

## Step 8: Display

Manual step 10. Page image: `/library/images/manual-p08.jpg`.

| Name    | Value                 | Place | Orientation                 | Mark                |
| ------- | --------------------- | ----- | --------------------------- | ------------------- |
| Display | 3641AS, 4 digits, red | LED1  | As in the picture of page 8 | Decimal points, TBD |

Risk: a reversed display shows wrong segments, and its removal is hard.
Check: the display faces as in the picture of page 8.
Scope: before solder, the display and its mark. Compare with page 8.
State: todo
Evidence: none

## Step 9: Electrolytic capacitors

Manual step 11. Page image: `/library/images/manual-p09.jpg`.

| Name                   | Value  | Place    | Orientation            | Mark                        |
| ---------------------- | ------ | -------- | ---------------------- | --------------------------- |
| Electrolytic capacitor | 100 µF | C1 to C5 | Long leg in the + hole | The stripe on the body is − |

Risk: a reversed capacitor. It can burst at power-on.
Check: on each capacitor, the long leg is in the + hole of the board.
Scope: before solder, each capacitor with its stripe and the + mark of
the board in one frame.
State: todo
Evidence: none

## Step 10: Amplifier module

Manual step 12. Page image: `/library/images/manual-p09.jpg`.

| Name             | Value          | Place | Orientation                 | Mark                   |
| ---------------- | -------------- | ----- | --------------------------- | ---------------------- |
| Amplifier module | 8002-M, 5 pins | M2    | As in the picture of page 9 | IN, GND, VDD, VO+, VO− |

Risk: a reversed module is damaged at power-on. Solder it from the back.
Check: the pin names of the module match the pin names of the board.
Scope: before solder, the pin names of the module and of the board.
State: todo
Evidence: none

## Step 11: Buttons

Manual step 13. Page image: `/library/images/manual-p09.jpg`.

| Name           | Value  | Place    | Orientation | Mark |
| -------------- | ------ | -------- | ----------- | ---- |
| Tactile switch | 4 pins | S1 to S4 | Any         | None |
| Key cap        |        | S1 to S4 | Any         | None |

Risk: a bent pin.
Check: four switches sit flat. Each key cap clicks.
Scope: after solder, the joints, for bridges.
State: todo
Evidence: none

## Step 12: Microcontroller

Manual step 14. Page image: `/library/images/manual-p09.jpg`.

| Name            | Value            | Place      | Orientation                      | Mark                |
| --------------- | ---------------- | ---------- | -------------------------------- | ------------------- |
| Microcontroller | STC8G1K17, DIP16 | U1, socket | Notch on the notch of the socket | Notch or dot, pin 1 |

Bend the pins inward a little. Press the chip into the socket. This step
has no solder.

Risk: a reversed chip, or a pin bent under the chip.
Check: the notch of the chip and the notch of the socket are at the same
end. All 16 pins are in the socket.
Scope: before pressing, both notches. After pressing, each row of pins.
State: todo
Evidence: none

## Step 13: Antenna and battery wires

Manual steps 15 to 18. Page image: `/library/images/manual-p10.jpg`.

| Name               | Value           | Place | Orientation       | Mark       |
| ------------------ | --------------- | ----- | ----------------- | ---------- |
| Telescopic antenna | 300 mm          | ANT   | As on page 10     | None       |
| Battery springs    | For 3 AAA cells | BT1   | As on page 10     | + and −    |
| Battery wire       | Red             | BT1 + | To the + terminal | Red is +   |
| Battery wire       | Black           | BT1 − | To the − terminal | Black is − |

1. Install the antenna.
2. Install the battery springs, and cut off the wire terminals.
3. Bend the wire terminals outward. Tin the + and − terminals.
4. Solder the battery wires.

Risk: reversed battery wires. The radio has no reverse-polarity
protection.
Check: the red wire is on +, and the black wire is on −, at both ends.
Scope: before solder, each wire end with the + or − mark.
State: todo
Evidence: none

## Step 14: Charging module

Manual pages 13 and 14. Page image: `/library/images/manual-p14.jpg`.
Skip this step when the kit has no charging module. USB then powers
nothing.

| Name             | Value           | Place  | Orientation              | Mark              |
| ---------------- | --------------- | ------ | ------------------------ | ----------------- |
| Pin header       | 3P              | Module | As in picture 1, page 14 | The pin row       |
| Female connector | 2P, PH2.0       | Module | As in picture 1, page 14 | The key           |
| Charging module  | Probably TP4056 | M3     | As in picture 2, page 14 | The 3 holes of M3 |

1. Solder the 3P pin header and the 2P female connector on the module.
2. Solder the module into the three holes of M3.

Risk: a reversed pin row. A module that sits too low shorts against the
board.
Check: the module faces as in picture 2 of page 14, and it sits high
enough that no joint touches the board.
Scope: before solder, the pin row against picture 1. After solder, the
gap under the module.
State: todo
Evidence: none

## Step 15: Speaker

Manual steps 22 to 24. Page images: `/library/images/manual-p11.jpg`,
`/library/images/manual-p12.jpg`. This step comes before the power-on, so
the first power-on can play a sound on the open board.

| Name         | Value           | Place | Orientation         | Mark       |
| ------------ | --------------- | ----- | ------------------- | ---------- |
| Speaker wire | Red             | VO+   | Speaker + to VO+    | Red is +   |
| Speaker wire | Black           | VO−   | Speaker − to VO−    | Black is − |
| Speaker      | 4 Ω, 3 W, 40 mm | Case  | Not yet in the case | None       |

1. Tin the speaker terminals, and solder the wires.
2. Tin the pads VO+ and VO− on the board.
3. Solder the red wire to VO+, and the black wire to VO−.

Risk: heat on the speaker terminals.
Check: red goes from speaker + to VO+, and black from speaker − to VO−.
Scope: the two pads with the wire colors.
State: todo
Evidence: none

## First power-on

**The first power-on uses the USB path. The HM310P is not on the bench.**
The person said that the kit takes its power from a USB connection.
Source: the person, in the project planning of 2026-10-08. Confidence:
medium. Ask the person to confirm in the room, and cite that message.

**USB reaches the radio only through the charging module.** USB1 feeds M3.
S5 down selects the output of M3, which is the lithium cell net (3.7 V).
S5 up selects the AAA cells. Without a charging module, USB powers
nothing. Source: library/fm-radio-kit-schematic.md, the supply.
Confidence: medium.

**Whether the module powers the radio with no cell is not known.** The
product page says that the cable charges the cell and does not power the
radio. Source: library/fm-radio-kit-product.md. Confidence: medium. The
first power-on answers it.

Expected current: TBD. No datasheet in `library/` gives the current of the
whole radio. Current limit: none, because USB has no set limit. The stop
rule below replaces the limit.

**Stop at once** on smoke, a smell, a hot part, or a display that stays
dark. To stop: move S5 up, and pull the USB cable.

**Checks before power:**

1. Every step above has `State: done` with evidence.
2. No AAA cells are in the holder. S5 is up, so the radio is off.
3. With the multimeter on resistance, read VDD to GND across C1. A reading
   near 0 Ω is a short: stop and find it. Expected value: TBD.
4. With no USB cable in, check continuity from the GND pad of the charging
   module to the board GND (U1 pin 8). Check continuity from the + output
   pad of the module to the S5 pole that S5 down connects to VDD. When
   either check fails, the module is reversed in M3: stop and fix it.
5. When a lithium cell is in use, its red wire is on + of the module.

**Power-on:**

1. Plug the USB cable into the charger and into
   USB1. The red LED of the module shows charging. With no cell, both
   LEDs can stay off (library/tp4056.md).
2. Move S5 down. Watch the board for 5 seconds. The display and the power
   LED of the tuner module light, and the speaker makes a rustling sound.
3. When the display lights and no sound comes, stop, wait about 30
   seconds, and power on again. Source: library/fm-radio-kit-manual.md,
   page 15.
4. Read VDD across C1, and 3V3 across C2, with the multimeter. VDD is 3.7
   to 4.2 V on the cell net. 3V3 is about 3.3 V. Stop when 3V3 reads above
   3.4 V. Source: library/fm-radio-kit-schematic.md.
5. Press V+ and V− to change the volume of the rustling sound. The antenna
   is not yet on the board, so the station search waits for Step 16.

Scope: one frame of the display while the radio runs.
State: todo
Evidence: the readings of VDD and 3V3 that the person reads aloud, with
the room message, and the snapshot ref of the frame.

**Later option:** the HM310P can feed the BT1 wires at 4.5 V with a
current limit, for a fault search or for the second kit.

## Step 16: Case

Manual steps 19 to 21 and 25 to 27. Page images:
`/library/images/manual-p11.jpg`, `/library/images/manual-p12.jpg`,
`/library/images/manual-p13.jpg`. Do this step after the first power-on
passes. Move S5 up, and pull the USB cable first.

1. Put the lithium cell or the AAA cells in, and put the foam on them.
2. Route the wires, and fix the board.
3. Fix the antenna with the 3 mm nut.
4. Put the speaker in its holes.
5. Snap on the case, and fix it with the screws. Do not over-tighten.

Risk: a pinched wire, or a cracked case.
Check: no wire is under a screw. Pull out the antenna, and press CH+ to
search. The radio plays a station in the case.
State: todo
Evidence: none

## Step 17: Display always on (optional)

Manual step 28. Page image: `/library/images/manual-p13.jpg`.

Bridge the two solder points on the back of the board. The display then
stays on all the time. Without the bridge, the display sleeps.

Risk: a bridge to a nearby pad.
Check: the bridge joins only the two points.
Scope: after solder, the bridge.
State: todo
Evidence: none
