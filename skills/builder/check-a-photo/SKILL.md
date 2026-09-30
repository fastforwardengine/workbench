---
name: check-a-photo
description: Check the placement and the orientation of a part from a photo that the person attached. Use it before a polarized part is soldered, and when the person asks whether a part sits right.
---

1. Ask the person to attach a photo. `/attach <path>` copies it into the
   workspace and cites it in the next message. Ask for a photo from above,
   in good light, with the mark of the part and the marking of the board in
   view.
2. Read the file that the message cites with `read`. The tool sends the
   picture to you. The snapshot ref names its path under `/attachments`.
3. Say what you see: the part, its place, and the mark that shows its
   orientation, such as a stripe, a notch, a dot, a longer lead, or a pin 1
   marking.
4. Compare it with the step of the procedure and with the datasheet in
   `/library`. Cite both.
5. Answer with one word first: pass, fail, or unclear. Then give the
   evidence, and cite the snapshot ref of the photo.
6. Answer unclear, and ask for a new photo, when the mark of the part or
   the marking of the board is not visible, or when the light hides it. A
   part can cover the marking of the board: ask the person to show it before
   the part goes in, or from another angle. Do not guess an orientation.
7. Never answer pass for a part that the photo does not show, or for a
   part whose orientation you can compare with the text of the procedure
   alone.
