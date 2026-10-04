---
name: check-a-photo
description: Check the placement and the orientation of a part from a photo of the bench camera, or from a photo that the person attached. Use it before a polarized part is soldered, and when the person asks whether a part sits right.
---

1. Take a photo with the camera when it can show the part: follow
   `observe-the-camera`. Ask the person to attach a photo only when the
   camera cannot show the part. `/attach <path>` copies it into the
   workspace and cites it in the next message. Ask for a photo from above,
   in good light, with the mark of the part and the marking of the board in
   view.
2. Read the frame or the file with `read`. The tool sends the picture to
   you. The snapshot ref of an attachment names its path under
   `/attachments`. The snapshot ref of a frame names its path under
   `~/.fetch/camera/`.
3. A polarized part is any part with a right way round: a diode, an LED,
   an electrolytic or tantalum capacitor, a transistor, a voltage
   regulator, a chip with or without a socket, a module or a header with a
   marked pin 1, or a connector.
4. Say what you see: the part, its place, and the mark that shows its
   orientation, such as a stripe, a notch, a dot, a longer lead, or a pin 1
   marking.
5. Compare it with the step of the procedure and with the datasheet in
   `/library`. Cite both.
6. Answer with one word first: pass, fail, or unclear. Then give the
   evidence, and cite the snapshot ref of the photo.
7. Answer unclear, and ask for a new photo, when the mark of the part or
   the marking of the board is not visible, or when the light hides it. A
   part can cover the marking of the board: ask the person to show it before
   the part goes in, or from another angle. Do not guess an orientation.
8. Say that a part sits right only when a photo or a measurement that you
   cite shows it. Never answer pass for a part that the photo does not
   show. Never answer pass for a part when you have only the text of the
   procedure and no photo.
