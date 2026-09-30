# FM radio kit: schematic

**This file transcribes the schematic of the kit.** The seller's product
page shows the schematic as one picture with three blocks: the main
circuit, the radio module, and the amplifier module. Read the picture
first, then use the tables below to find a net.

- **Source:** the "Digital display circuit diagram" picture of the product
  page. The picture is small, so every value below is read by eye.
- **Confidence:** medium. Check each net against the board before you rely
  on it. A value that the picture does not settle carries a **?**.
- **Converted:** 2026-09-29.

![Digital display circuit diagram](images/kit-schematic.jpg)

Figure file: `/library/images/kit-schematic.jpg`.

## The main circuit

| Ref      | Part                  | Role                                                            |
| -------- | --------------------- | --------------------------------------------------------------- |
| U1       | STC8G1K, 16 pins      | Microcontroller: buttons, display, and the I²C master           |
| M1       | RDA5807FP-M           | Tuner module, 11 pins. Its inner circuit is the radio block     |
| M2       | 8002-M                | Amplifier module, 5 pins: IN, GND, VDD, VO+, VO−                |
| LED1     | 3641AS                | 4-digit 7-segment display, red, common cathode                  |
| R1 to R7 | 47 Ω (manual, step 1) | Series resistors between the microcontroller and the display    |
| S1 to S4 | Tactile switches      | V−, V+, CH−, CH+ (the silkscreen order, left to right)          |
| S5       | Toggle switch         | Battery in one position, micro-USB in the other                 |
| C1 to C5 | 100 µF electrolytic   | Supply and audio coupling (five in the manual, step 11)         |
| PJ1      | PJ-342A               | 3.5 mm headphone jack                                           |
| USB1, M3 | Micro-USB, 3P header  | The 3.7 V charging module connects at M3 (rechargeable version) |
| BT1      | 4.5 V battery (3 AAA) | Main supply                                                     |
| Speaker  | 4 Ω, 3 W              | On VO+ and VO− of M2                                            |

### The supply

- **BT1 (4.5 V)** feeds the net **VDD** through the switch S5. The picture
  marks 3.7 V on the USB side of S5 and 4.5 V on the battery side.
- **VDD** feeds M1 (pin 10, VCC), M1 (pin 11, EN), and M2 (VDD).
- **The net 3V3** feeds U1 (pin 6, Vcc/AVcc/VREF+). M1 pin 7 is also named
  3V3. The radio block makes 3V3 from VCC with the regulator U2 (662K).
  See the radio block below.
- **Grounds:** GND on every module and on U1 pin 8.

### The microcontroller U1 (STC8G1K, 16 pins)

The pin names come from the STC8G1K17 pin table (`stc8g1k17.md`). The labels
on the right of each pin are the net names of the picture.

| U1 pin | Port | Net in the picture   | What it does                                 |
| ------ | ---- | -------------------- | -------------------------------------------- |
| 1      | P1.0 | D5                   | Display drive line                           |
| 2      | P1.1 | D6                   | Display drive line                           |
| 3      | P1.6 | D7                   | Display drive line                           |
| 4      | P1.7 | S0                   | Display drive line                           |
| 5      | P5.4 | (none)               | Reset or I/O. The picture draws a wire **?** |
| 6      | Vcc  | 3V3                  | Supply                                       |
| 7      | P5.5 | (a wire to S3 or S4) | Button line **?**                            |
| 8      | GND  | GND                  | Ground                                       |
| 9      | P3.0 | (S2 side) **?**      | Button line, and the UART RxD for ISP        |
| 10     | P3.1 | (S1 side) **?**      | Button line, and the UART TxD for ISP        |
| 11     | P3.2 | SCLK                 | I²C clock to M1 pin 8 (I2CSCL_4)             |
| 12     | P3.3 | SDA                  | I²C data to M1 pin 9 (I2CSDA_4)              |
| 13     | P3.4 | D1                   | Display drive line                           |
| 14     | P3.5 | D2                   | Display drive line                           |
| 15     | P3.6 | D3                   | Display drive line                           |
| 16     | P3.7 | D4                   | Display drive line                           |

- **Each button connects one microcontroller pin to GND.** The pins for
  S1 to S4 are P3.1, P3.0, P5.5, and one more pin that the picture does
  not settle (P5.4 is the likely one). **Trace the four buttons on the board
  with a multimeter** before path A or path C relies on them.
- **The display uses eight lines** (D1 to D7 and S0) through the seven
  47 Ω resistors. A 4-digit display needs more lines in a plain
  multiplex, so the drive is probably a shared-line scheme. The picture
  does not settle the scheme **?**.
- **The I²C pins carry no pull-up resistor in the picture.** Whether the
  board has any is an open fact. The internal 4 kΩ pull-ups of the
  STC8G1K17 pins are switchable.

### The tuner module M1 (RDA5807FP-M, 11 pins)

| M1 pin | Name  | Connects to                                        |
| ------ | ----- | -------------------------------------------------- |
| 1      | FMIN  | The antenna ANT (through the module input network) |
| 2      | GPIO2 | Not used in the picture                            |
| 3      | GPIO3 | Not used in the picture                            |
| 4      | LOUT  | C3 (100 µF) to the jack PJ1, and to M2 IN          |
| 5      | ROUT  | C4 (100 µF) to the jack PJ1                        |
| 6      | GND   | GND                                                |
| 7      | 3V3   | The net 3V3 (see the supply above)                 |
| 8      | SCLK  | U1 pin 11 (P3.2)                                   |
| 9      | SDA   | U1 pin 12 (P3.3)                                   |
| 10     | VCC   | VDD                                                |
| 11     | EN    | VDD                                                |

### The jack PJ1 (PJ-342A)

PJ1 takes the left and right audio from C3 and C4. The picture shows a
switched contact, so the speaker path cuts off when a plug is inserted. The
manual says the sound moves to the headphones then (page 15).

## The radio module block

The block shows the circuit inside M1. It has the chip U1 (RDA5807 in a
SOP16 package), the crystal Y1, a small discrete input stage (Q1 with the
coils L1 and L2), and the regulator U2.

| Ref (radio block)  | Value or part        | Role                                                      |
| ------------------ | -------------------- | --------------------------------------------------------- |
| U1                 | RDA5807              | The tuner chip. SOP16 pins as in the block of the picture |
| Y1                 | Crystal              | The 32.768 kHz reference on RCLK (pin 9)                  |
| U2                 | 662K                 | 3.3 V regulator. Pin 1 Vin, pin 2 Vss, pin 3 Vout         |
| Q1, L1, L2         | Transistor and coils | The FM input stage on FMIN                                |
| C1 to C5, R1 to R3 | Small parts          | Bias, coupling, and bypass. Values are unreadable         |
| D1, R3             | LED and resistor     | A power indicator on the 3V3 net **?**                    |

The pin table of the chip in the block:

| Pin | Name  | Note                    | Pin | Name  | Note                 |
| --- | ----- | ----------------------- | --- | ----- | -------------------- |
| 1   | GPIO1 |                         | 16  | GPIO2 |                      |
| 2   | GND   |                         | 15  | GPIO3 |                      |
| 3   | RFGND |                         | 14  | GND   |                      |
| 4   | FMIN  |                         | 13  | Lout  | **see the conflict** |
| 5   | GND   | EN is drawn on the line | 12  | Rout  | **see the conflict** |
| 6   | GND   |                         | 11  | GND   |                      |
| 7   | SCLK  | From the module pin 8   | 10  | 3V3   | VDD of the chip      |
| 8   | SDA   | From the module pin 9   | 9   | RCLK  | With the crystal Y1  |

## The amplifier block (8002)

The picture shows the amplifier chip U1 (8002, 8 pins). C1 and R1 are in
the input path, R2 and C3 in the feedback path, C2 and C4 on the bypass
pin, and SHUTDOWN goes to GND.

| Pin | Name in the picture | Datasheet name (`hxj8002.md`) |
| --- | ------------------- | ----------------------------- |
| 1   | SHUTDOWN (to GND)   | SD                            |
| 2   | BYPASS              | BYP                           |
| 3   | +IN                 | +IN                           |
| 4   | −IN                 | −IN                           |
| 5   | VO+                 | Vo1 ("negative output")       |
| 6   | VDD                 | VDD                           |
| 7   | GND                 | GND                           |
| 8   | VO−                 | Vo2 ("positive output")       |

## Conflicts

- **Left and right on the tuner pins.** The kit picture puts Lout on pin
  13 and Rout on pin 12. The RDA5807FP datasheet top view puts ROUT on pin
  13 and LOUT on pin 12, and its pin table says "LOUT, ROUT 13, 12". The
  first radio has one speaker with one input, so the swap changes nothing
  for mono. It matters for a stereo capture on the jack.
- **Sign of the amplifier outputs.** The picture calls pin 5 VO+ and pin 8
  VO−. The 8002 datasheet calls pin 5 the negative output and pin 8 the
  positive output. A speaker works with either sign. Keep the manual's
  red and black wires (step 24).
- **The shutdown pin.** The picture ties SHUTDOWN to GND. The 8002
  datasheet enters shutdown on a high level, so GND keeps the amplifier on.
- **Supply level.** See the conflicts of `fm-radio-kit-manual.md`.
