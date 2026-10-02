# Which band does the stock firmware set?

**Why it matters:** The station map of path B depends on the band.

**What answers it:** Read register 0x03 of the tuner over I²C with a Pico,
before the firmware runs.
