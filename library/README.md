# Library

**This directory holds the datasheets and the manuals of the parts on the
bench, in Markdown.** The specialists read these files before they claim a
specification. Each file names its part, its key limits, and its source.
The figures are JPEG files in `images/`. A specialist reads a figure with
`read`, and the tool sends the picture to the model.

## Files

| File                        | What it covers                                           | Source                                      |
| --------------------------- | -------------------------------------------------------- | ------------------------------------------- |
| `fm-radio-kit-manual.md`    | The kit: parts, tools, 28 assembly steps, use, conflicts | The seller's manual PDF (15 pages)          |
| `fm-radio-kit-schematic.md` | The circuit of the kit, net by net, from the picture     | The product page picture                    |
| `fm-radio-kit-product.md`   | The parameters and the detail views of the product page  | Four pictures of the product page           |
| `rda5807fp.md`              | The FM tuner chip: pins, I²C, registers, a worked tune   | RDA Microelectronics datasheet, Rev. 1.2    |
| `stc8g1k17.md`              | The microcontroller: pins, I²C pins, ISP, limits         | STC8G series manual (867 pages)             |
| `hxj8002.md`                | The 8002 audio amplifier: pins, limits, bridge, shutdown | 8002 datasheet V1.0                         |
| `3641as.md`                 | The 4-digit display: pinout and limits                   | XLITX datasheet                             |
| `xc6206-662k.md`            | The 3.3 V regulator on the tuner module (low confidence) | The kit schematic, and a secondary web page |
| `tp4056.md`                 | The probable charging chip of the rechargeable kit       | Top Power datasheet                         |

## Rules for these files

- **A file states its source and its conversion date.** A value that comes
  from a secondary page, or from a picture that is read by eye, says so.
- **A conflict between two sources stays in the file.** Each file has a
  conflicts or an open points section. Do not remove a conflict until a
  reading or a photo settles it.
- **A measurement is not a datasheet value.** A datasheet gives a limit. A
  script that reads a device gives a reading.
- **Rights:** the tuner datasheet carries a notice that forbids
  distribution without permission of RDA. The other documents are
  summaries in our words with the vendor's numbers. Read the original
  before you rely on a value for a design.

## How to add a part

1. Put the summary in `<part>.md`, with the source, the date, the key
   facts, the pins, the limits, and the open points.
2. Put the figures that a photo check needs in `images/`, as JPEG files
   under 200 KB.
3. Add a row to the table above.
