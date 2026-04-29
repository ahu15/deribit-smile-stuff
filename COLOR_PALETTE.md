# Color Palette — Deribit Smile

Two themes, one set of CSS custom properties. Every colour in the UI resolves
through these tokens; no hex/rgb literals in component code.

The palette logic, in plain words:

- **Single accent per theme.** Brand colour for the strike spine in the chain,
  active states in chrome, focus rings. Currency-specific accents (BTC orange,
  ETH purple, SOL cyan) override `--accent` only inside a per-widget scope —
  they're "currency identity," not "global brand."
- **Bid warm, ask cool.** Always. On both themes. Even when warm/cool maps to
  different hues per theme, the *temperature relationship* never flips.
- **Pos / neg never compete with bid / ask.** In dark mode `--neg` is a magenta-
  red so it doesn't clash with `--bid` (orange-red). In light mode `--neg` is a
  desaturated brick-red and `--bid` is a deeper red — they're in the same
  family but the difference in saturation + lightness keeps direction signal
  legible against bid quotes.
- **Three foreground levels.** Primary, dim, mute. Per the
  [Option Chain Visual Spec](Option%20Chain%20Visual%20Spec.md): magnitude
  reads first, precision second, suffix barely.

---

## Dark — `data-theme="dark"`

Arctic's high contrast in reverse: deep blue-black ground, near-white foreground
at L=95 with the faintest cool tint. Single blue accent. Magenta-red replaces
pure red so it doesn't compete with bid/ask.

| Token | Hex | OKLCH | Use |
|---|---|---|---|
| `--bg` | `#070a10` | `oklch(0.07 0.012 250)` | App ground |
| `--bg-1` | `#0d121c` | `oklch(0.13 0.012 250)` | Pane fill |
| `--bg-2` | `#161d2c` | `oklch(0.20 0.020 250)` | Strike spine, divider |
| `--fg` | `#eaf2ff` | `oklch(0.95 0.020 250)` | Primary text / mark / strike |
| `--fg-dim` | `#9aa6ba` | `oklch(0.68 0.020 250)` | Secondary (IV, Δ) |
| `--fg-mute` | `#5a6478` | `oklch(0.45 0.015 250)` | Tertiary (OI, suffixes, headers) |
| `--accent` | `#5fb0ff` | `oklch(0.75 0.13 245)` | Strike spine, focus, active |
| `--pos` | `#5fe89a` | — | Up / positive change |
| `--neg` | `#ff6a8a` | — | Down / negative change (magenta-red, doesn't compete with bid) |
| `--bid` | `#ffa05a` | — | Bid (warm) |
| `--ask` | `#5fb0ff` | — | Ask (cool) — same hue as accent by design |
| `--itm` | `#101728` | `oklch(0.16 0.020 250)` | ITM cell shading (+6 L\* over `--bg`) |

---

## Light — `data-theme="light"`

Cool gray paper, true blue accent. Highest contrast option — best WCAG ratios.
Bid is desaturated red, ask is the brand blue.

| Token | Hex | OKLCH | Use |
|---|---|---|---|
| `--bg` | `#f4f6fa` | `oklch(0.97 0.008 240)` | App ground |
| `--bg-1` | `#e8ecf3` | `oklch(0.93 0.010 240)` | Pane fill |
| `--bg-2` | `#d2dae6` | `oklch(0.86 0.014 240)` | Strike spine, divider |
| `--fg` | `#0e1828` | `oklch(0.20 0.025 250)` | Primary text / mark / strike |
| `--fg-dim` | `#3e4a60` | `oklch(0.40 0.020 250)` | Secondary (IV, Δ) |
| `--fg-mute` | `#6a7388` | `oklch(0.55 0.015 250)` | Tertiary (OI, suffixes, headers) |
| `--accent` | `#1e6dd8` | `oklch(0.52 0.18 250)` | Strike spine, focus, active |
| `--pos` | `#1f7a3a` | — | Up / positive change |
| `--neg` | `#b8242c` | — | Down / negative change |
| `--bid` | `#a23a3a` | — | Bid (desaturated red) |
| `--ask` | `#1e6dd8` | — | Ask (brand blue) |
| `--itm` | `#dde3ee` | `oklch(0.89 0.012 240)` | ITM cell shading (deeper than pane) |

---

## Per-currency accents (override `--accent` inside one widget instance)

These are identity colours for the underlying asset, applied to widget
chrome that's bound to a specific symbol. They override `--accent` only in
the scope of a single widget instance — never the global toolbar.

| Symbol | Colour |
|---|---|
| BTC | `#f7931a` |
| ETH | `#8c8cf7` |
| SOL | `#14f195` |
| Equity ETFs | `#e0e0e0` |

---

## Typography

- **Chrome** (toolbar, header, status pill, dropdowns, buttons): `Inter` — sans-serif, 11–13 px.
- **Data** (chain rows, smile readout, prices, IVs, greeks): `Commit Mono` — monospace with tabular figures. Falls back to `JetBrains Mono` then `ui-monospace`.
- **Tabular figures everywhere in the data layer.** `font-variant-numeric: tabular-nums` on every numeric cell.

---

## Implementation

`frontend/src/styles/theme.css` defines both palettes against `:root[data-theme="dark"]` and `:root[data-theme="light"]`. The active theme is set via `document.documentElement.setAttribute('data-theme', mode)` from a `useTheme` hook that persists the choice in `localStorage` under `deribit-smile:theme`. The toggle lives at the top of the dock shell next to the StatusPill.
