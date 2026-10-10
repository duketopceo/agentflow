# agentflow brand assets (proposal)

Status: **proposal.** The repo owner signs off logos; nothing here is final.
All files are hand-written SVG. No image generation, raster sources or stock icons.

| File | What |
|---|---|
| `logo.svg`, `logo-dark.svg` | Mark for light and dark surfaces |
| `wordmark.svg`, `wordmark-dark.svg` | Lowercase wordmark, "agent" in ink and "flow" in the accent |
| `glyphs.svg` | Seven status glyphs: ok, fail, running, replay, cache, cancelled, null |
| `social-card.svg` | 1200x630 card (uses a monospace font; the PNG was rendered with JetBrains Mono; the log lines are illustrative) |
| `*.png` | Previews rendered with `resvg`, optimised with `oxipng` |

## Mark construction

The mark is the product in one picture: **one input fans out to three parallel
agent branches that rejoin at one result.** Fan-out, then fan-in through the
script's synthesis step.

- Canvas `64 x 48` (viewBox `0 8 64 48`), centred on the horizontal axis `y = 32`.
- Three strokes, `5` wide, round caps and joins: a middle line `H` from `x=15` to `49`,
  and two branches at `y = 15` and `y = 49`, each entering and leaving at 45-ish degrees
  (`L23 15 H41 L49 27`), mirrored about the axis.
- Two filled nodes, radius `7`, at `x = 9` and `x = 55`: the script (source) and the
  journalled result (sink). Nodes use the accent; strokes use ink.
- Only straight lines and circles. No gradients, no text, no effects.

Size notes: crisp at 24 px and above. At 16 px the three strokes blur into a
nodes-and-lens shape that is still distinguishable from other favicons; if a
16 px favicon matters, drop the middle line in a dedicated `logo-16.svg`.

## Wordmark construction

Monoline letters (stroke `3.4`, round caps), x-height box `2..18`, ascender
`-6`, descender `26`. Bowls (`a g o`) are circles of radius 8; `e`, `n`, `t`, `f`,
`l`, `w` are single paths. Pitch is 25 units for wide letters, 21 and 15 for
narrow. The split colour (`agent` ink, `flow` accent) mirrors the two halves of the name.
The letterforms are geometric by construction, not a font; spacing is by hand.

## Palette

Ink `#14181F` / `#E8ECF2`, accent `#0B6B66` / `#4FD1C5`. See `DESIGN.md` for contrast ratios.
