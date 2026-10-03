# The project

**Workbench holds one bench project: an FM radio kit.** The person builds
the first kit by hand. The team then tunes the radio in three ways, and
guides the build of a second kit. The room `build` holds every phase, in order:

1. Know the kit, and support the hand build of the first one.
2. Hear the radio, and tune it: path A (buttons and camera) and path B (I²C).
3. Guide the build of the second kit, and its first power-on.
4. Path C: new firmware for the microcontroller.

**The notes hold the state of the bench.** They are the git repository
`shared/notes`. Clone it and read its README.md before you act, in any room.

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
- A HANMATEK HM310P power supply, a Logitech BRIO camera, and a USB microphone.
- To buy: a Raspberry Pi Pico for paths A and B. For path C, a 3.3 V
  USB-to-serial adapter and a spare STC8G1K of the exact type.

## House rules

- Read the datasheet in /library before you state a limit. Cite the path.
- A measurement counts only when a script read it from a device. Cite the
  file that the script wrote. Every other value is a planned value.
- The first power-on of the second kit goes through the HM310P, with a current
  limit. Stop at once on an abnormal current.
- The power stays off until the checks of the build pass.
- Record a decision in the notes, in `decisions/`, unless the person told you not to edit files.
