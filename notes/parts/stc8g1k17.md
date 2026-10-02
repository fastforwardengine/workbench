# STC8G1K17: the microcontroller

Read library/stc8g1k17.md for the pin table and the ISP steps.

- **The chip in the kit is an STC8G1K17 in a DIP16 socket.** Source:
  library/fm-radio-kit-manual.md, page 9, and the board photo in it.
  Confidence: high.
- **The I²C clock is P3.2 (pin 11) and the data is P3.3 (pin 12).** Source:
  library/stc8g1k17.md and library/fm-radio-kit-schematic.md. Confidence:
  medium.
- **The four buttons sit on P3.1, P3.0, P5.4, and P5.5 (V−, V+, CH−, CH+).**
  Source: library/fm-radio-kit-schematic.md, zoomed reading. Confidence:
  medium.
- **P5.4 is also the reset pin when a download enables that option.** Source:
  library/stc8g1k17.md. Confidence: medium.
- **The chip has no USB download and no online debugging. It programs through
  a UART on P3.0 and P3.1.** Source: library/stc8g1k17.md, selection table,
  page 3 of the manual. Confidence: medium.
- **The supply is 1.9 to 5.5 V. The kit runs it from the 3.3 V net.** Source:
  library/stc8g1k17.md, appendix O, and library/fm-radio-kit-schematic.md.
  Confidence: medium.
