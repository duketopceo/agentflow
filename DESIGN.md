# agentflow design direction: "Run Ledger"

Status: proposal. Logo assets are in `assets/brand/` and need owner sign-off.

## Concept

agentflow's real interface is a **journal**: one JSONL line per settled agent
call, `[index] label -> ok | null`, read in a terminal. The direction takes
that literally: a **ledger** of small, tabular, monospaced entries on a cool,
quiet canvas, with one teal accent that means "this is the run's path". It is a
developer tool people watch for minutes, not a marketing site, so it is dense,
calm and numerically aligned.

## Research method and limits

The Refero MCP was not available in this session, so the `refero-design`
skill's style/screen/flow search could not run. Per its fallback, direction
comes from named references, the product's own output and the skill's bundled
craft rules. Treat the reference lock below as a hypothesis, to be checked
against Refero styles when the tool is available.

### Reference lock

- **Primary direction:** terminal-native ledger. The existing output of
  `agentflow tail` and the journal is the design source.
- **Preserve:** monospaced tabular columns for run data; one accent colour
  used only for the live path, the cursor and links; status carried by glyph
  plus word, never colour alone; dark canvas as the default in the terminal.
- **Borrow only:** Claude Code's `/workflows` phase list (https://code.claude.com/docs/en/workflows)
  for phase-grouped progress; GitHub Actions-style one-line-per-step status rows
  for density.
- **Role rules:** teal is not a decorative gradient, not a button fill on the
  README, and not a success colour (success is green, see below).
- **Reject:** purple-to-blue "AI" gradients, robot or brain icons, glassy cards,
  swarm/constellation imagery, serif accent words.

### Decision ledger

| Decision | Source | Why |
|---|---|---|
| Monospace for all run data | the journal and `tail` output | alignment of index, label, status, elapsed |
| Single teal accent | product concept: "the path through the run" | one meaning, easy to keep rare |
| Separate success green, failure red, pending amber | status semantics | accent must not double as status |
| Glyph plus word for every status | WCAG 1.4.1 (use of colour) | colour-blind safe; works in a monochrome terminal |
| Fork-join mark | architecture: fan-out, fan-in | the one thing the runner does |
| No motion in the CLI beyond a spinner | terminal norms | log output must stay greppable |

## Tokens

All pairs were checked with the WCAG relative-luminance formula on 2026-10-10.

### Colour

| Role | Light | on Light bg | Dark | on Dark bg |
|---|---|---|---|---|
| Background | `#F6F7F9` | | `#0E1116` | |
| Surface (rows, code) | `#E8EBF0` | | `#1A1F27` | |
| Ink (text) | `#14181F` | 16.6:1 | `#E8ECF2` | 15.9:1 |
| Muted text | `#4A5260` | 7.4:1 | `#9AA4B2` | 7.5:1 |
| Accent (path, links, cursor) | `#0B6B66` | 5.9:1 | `#4FD1C5` | 10.1:1 |
| Text on accent fill | `#FFFFFF` | 6.4:1 | `#0E1116` | 10.1:1 |
| OK | `#1F7A3A` | 5.0:1 | `#5FD08A` | 9.8:1 |
| Fail | `#B3261E` | 6.1:1 | `#FF8A80` | 8.3:1 |
| Pending / null | `#8A5A00` | 5.5:1 | `#F2B84B` | 10.6:1 |

Ink on surface: 14.9:1 light, 14.0:1 dark. Every text pair clears AA (4.5:1); all but
OK-on-light clear 5.5:1.

### Type

- **Data and CLI:** the user's terminal monospace. For web and docs: `JetBrains Mono`,
  `ui-monospace`, `Liberation Mono`, `monospace`, 14/20 px, `font-variant-numeric: tabular-nums`.
- **Prose (README site, docs):** the platform sans (`system-ui`), 16/26 px, max 68ch,
  `text-wrap: pretty`; headings `text-wrap: balance`.
- **Scale (px):** 12, 14, 16, 20, 28, 40. Headings weight 600; no italics for emphasis.
- The wordmark is drawn, not set in a font (`assets/brand/wordmark.svg`).

### Space, shape

4 px base unit; 8, 12, 16, 24, 40. Radius `4` for rows and code, `0` for tables;
borders 1 px at 20% ink; no shadows. Elevation is expressed by the surface colour.

## Glyphs

Monoline, 16 px grid, 1.75 px stroke, round caps and joins, outline only
(`assets/brand/glyphs.svg`): `ok` check, `fail` cross, `running` open ring with
head, `replay` left arrow (result replayed from the journal), `cache` three bars
(content-cache hit), `cancelled` slashed ring, `null` dashed ring (call settled
as null). In a plain terminal the fallback is text: `ok`, `fail`, `...`, `replay`,
`cache`, `cancel`, `null`. Never emoji.

## Motion

- Terminal: a single-character spinner on running rows only, 100 ms frames,
  never when stdout is not a TTY or when `NO_COLOR`/`CI` is set. Completed rows never animate.
- Web/docs: 120 ms opacity or colour transitions only; honour `prefers-reduced-motion` by removing them.
- No looping decorative animation anywhere, including the README.

## Surfaces

| Surface | Exists today | Direction |
|---|---|---|
| CLI (`run`, `status`, `tail`, `list`, `doctor`) | yes | Ledger rows: `[i] label  status  elapsed  model`; align columns; phase headers as plain rules; respect `NO_COLOR` |
| TUI / live view | no (roadmap U12) | Same rows, phase-grouped, redrawn in place; no interactive controls until the runner supports them |
| README | yes | Logo on top, flat layout, one diagram, one terminal capture; no badges wall |
| Plugin / skill (`skills/agentflow/SKILL.md`) | yes | Plain text, no branding beyond the name |
| Docs site | no | Not planned; the repo `docs/` folder is the docs |
| Web UI, bar widget | no | Out of scope |

## Logo

Fork-join mark plus a lowercase drawn wordmark, as described in
`assets/brand/README.md`. Light and dark variants. Proposal only.
