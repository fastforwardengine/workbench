# RDA5807FP: the FM tuner chip

Read datasheets/rda5807fp.md for the registers and the timing.

- **The chip answers on the 7-bit I²C address 0x10 (0x20 to write, 0x21 to
  read).** Source: datasheets/rda5807fp.md, page 5. Confidence: medium.
- **The supply is 2.7 to 3.3 V.** Source: datasheets/rda5807fp.md, page 6.
  Confidence: medium.
- **The default band is 87 to 108 MHz, and the frequency is spacing × CHAN +
  87.0 MHz.** Source: datasheets/rda5807fp.md, register 0x03. Confidence: medium.
- **Pin 13 is LOUT and pin 12 is ROUT.** Source: datasheets/rda5807fp.md, top
  view, and datasheets/fm-radio-kit-schematic.md. Confidence: medium.
- **The chip has no enable pin. It powers up with the ENABLE bit of register
  0x02.** Source: datasheets/rda5807fp.md, pin table. Confidence: medium.
- **RSSI is 7 bits in register 0x0B, bits 15 to 9. The datasheet table gives
  the range as six bits, so the real range needs a reading.** Source:
  datasheets/rda5807fp.md, register 0x0B. Confidence: medium.
