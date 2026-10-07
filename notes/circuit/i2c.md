# The I²C bus

- **The microcontroller is the master. SCL is U1 pin 11 (P3.2) and SDA is U1
  pin 12 (P3.3), joined to the tuner module pins 8 and 9.** Source:
  datasheets/fm-radio-kit-schematic.md. Confidence: medium.
- **The schematic picture shows no external pull-up resistor on either line.**
  Source: datasheets/fm-radio-kit-schematic.md. Confidence: low.
- **The bus runs at 3.3 V. A second master, such as a Pico, must use 3.3 V
  levels.** Source: datasheets/rda5807fp.md and datasheets/stc8g1k17.md. Confidence:
  medium.
