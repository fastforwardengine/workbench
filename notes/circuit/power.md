# The power path

Read library/fm-radio-kit-schematic.md, the supply section.

- **Micro-USB reaches only the charging module socket M3. It never reaches VDD
  directly.** Source: library/fm-radio-kit-schematic.md, zoomed reading.
  Confidence: medium.
- **Switch S5 chooses the source of VDD: the charging module output (3.7 V) or
  the battery BT1 (4.5 V).** Source: library/fm-radio-kit-schematic.md.
  Confidence: medium.
- **The regulator on the tuner module makes the net 3V3 from VDD. The tuner
  chip and the microcontroller run from 3V3.** Source:
  library/fm-radio-kit-schematic.md. Confidence: medium.
- **The 3 V line of the manual does not limit VDD. The net 3V3 must stay at
  3.3 V or below.** Source: library/fm-radio-kit-schematic.md, resolved
  conflicts. Confidence: medium.
- **The circuit has no reverse-polarity protection.** Source:
  library/fm-radio-kit-schematic.md. Confidence: medium.
