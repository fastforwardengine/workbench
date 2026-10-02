# Does the stock firmware enable RDS?

**Why it matters:** RDS gives the name of a station, which the team can check
against its tuning.

**What answers it:** Read register 0x02 bit 3 and register 0x0A bit 15 over
I²C.
