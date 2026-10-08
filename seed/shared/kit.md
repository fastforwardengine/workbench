# The project

**Workbench holds one bench project: an FM radio kit.** The Engineer guides
the build of the first kit, step by step. `build/first-kit.md` in the notes
holds the plan. The seeded room `build` holds every phase. The goal
of the room lists the phases in order.

**The notes hold the state of the bench.** They are the git repository
`shared/notes`. The `keep-notes` skill states how to use them.

## Parts of the kit

These come from the product photo, the manual, and the schematic. Check each
one against the kit. The datasheets, the manual, and the schematic are in
/library. Start with /library/README.md.

- The FM tuner module: RDA5807FP-M, controlled over I²C.
- The microcontroller: STC8G1K17, 16 pins, in a DIP16 socket.
- The amplifier module: 8002. The charging module: CAI-222 in the photo,
  probably a TP4056 board.
- A 4-digit 7-segment display (3641AS), and four buttons: V−, V+, CH−, CH+.
- A speaker, a headphone jack, a telescopic antenna, and a case.

## On the bench

- Two FM radio kits, the ELEGOO Electronics Fun Kit, and soldering equipment.
- A HANMATEK HM310P power supply, a Logitech BRIO camera, a TOMLOV TM4K-AF
  microscope, and a USB microphone.
- To buy: a Raspberry Pi Pico for paths A and B. For path C, a 3.3 V
  USB-to-serial adapter and a spare STC8G1K of the exact type.

## House rules

- The first power-on of the first kit uses USB, through the charging module.
  Stop at once on smoke, a smell, a hot part, or a dark display.
- The first power-on of the second kit goes through the HM310P, with a current
  limit. Stop at once on an abnormal current.
- The power stays off until the checks of the build pass.
- Record a decision in the notes, in `decisions/`, unless the person told you not to edit files.
