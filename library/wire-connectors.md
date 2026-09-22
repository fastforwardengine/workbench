# JST-PH connectors and silicone wire (summary)

**The kit uses 2-pin JST-PH connectors and 18 AWG silicone-jacket wire to
link the cell, the charge module, and the load.** Both parts have their own
current limit; design to the lower of the two.

## JST-PH connector

- Rated current: 1 A per pin, continuous.
- 2.0 mm pitch. Confirm polarity before connecting; the connector is not
  keyed against reverse insertion on this kit's parts.

## 18 AWG silicone wire

- Rated current: about 10 A in free air, well above the connector's limit
  and the cell's 2000 mA discharge limit.
- Rated temperature: -60 °C to 200 °C, silicone jacket.

## Design note

Because the JST-PH connector is the tighter limit at 1 A, a design that
plans a discharge current above 1 A through this connector needs a
different connector or a direct solder joint. State this margin in a
design decision.
