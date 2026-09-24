# Workbench brand assets

This directory holds the logos, icons, applications, tokens, and fonts from
the Workbench brand kit, version 1.0. It does not hold the full kit. The
full kit adds a brand guide PDF, a distinctiveness review, a messaging
page, and the generator script.

## Contents

- **`logos/svg`** holds the scalable masters: horizontal, stacked, mark, and
  descriptor layouts, each in primary, reverse, ink, and white versions.
- **`logos/png`** holds sRGB screen exports of the same layouts, for tools
  that do not accept SVG.
- **`icons`** holds the favicon set, the Apple and Android touch icons, the
  web manifest, and GitHub avatar exports in light and dark.
- **`applications`** holds the GitHub social preview image (1280 x 640), the
  README banner, the lab label template, the signal pattern, and the
  terminal theme specimen. Each has an SVG master.
- **`tokens`** holds the brand colors and type scale as CSS custom
  properties (`workbench.css`) and as a JSON token file
  (`workbench.tokens.json`). `contrast-checks.json` records the contrast
  ratios of the terminal palette.
- **`fonts`** holds `SpaceGrotesk-Variable.ttf` and `IBMPlexMono-Regular.ttf`,
  each with its SIL Open Font License. Keep each font with its license.

## Asset rules

Each logo has a transparent background and built-in clear space of 60 units
around the 240-unit-wide mark. Do not crop that space away. Primary artwork
belongs on white or paper. Reverse artwork belongs on ink or similar dark
fields.

The minimum visible mark size is 32 px. The horizontal logo needs a canvas
of at least 220 px. The descriptor logo needs at least 640 px. Use
`icons/favicon.svg` below 32 px.

Use Space Grotesk 400 for body text, 500 for labels, and 700 for headings.
Use IBM Plex Mono 400 for technical labels and identifiers. The lettering
in the logo files is outlined, so do not retype it. The licenses do not
grant rights to the Workbench name or logo.

The brand amber is an accent, or a background for dark text. Do not use it
for small text on paper. The terminal uses a separate, brighter palette.

## Web integration

Serve the `icons` directory from a public path. The example below assumes
`/brand/icons/`.

```html
<link rel="icon" href="/brand/icons/favicon.svg" type="image/svg+xml" />
<link rel="alternate icon" href="/brand/icons/favicon.ico" />
<link rel="apple-touch-icon" href="/brand/icons/apple-touch-icon.png" />
<link rel="manifest" href="/brand/icons/site.webmanifest" />
<meta name="theme-color" content="#1B252A" />
```

## Terminal palette

The brand kit proposes a terminal palette in its `tokens/brand.ts`. This
directory does not include that file. `src/terminal/brand.ts` keeps the
current placeholder palette. Nobody has verified the proposed palette in
OpenTUI yet.

## Source

The full brand kit is available from the project's brand owner on request.
