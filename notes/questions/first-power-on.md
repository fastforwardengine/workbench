# What do VDD, 3V3, and the current read at the first power-on?

**Why it matters:** The manual, the schematic, and the datasheets disagree
about the supply limit.

**What answers it:** The first power-on of the first kit uses USB, through
the charging module (`build/first-kit.md`). Read VDD and the net 3V3 with a
multimeter. It also shows whether the module powers the radio with no
cell. The HM310P gives the idle and full-volume current later. Snapshot the
readings.
