# Option Chain — Design Spec for a Multi-Tab Web App

A first-principles brief for a high-density, terminal-grade option chain. Use this as the source of truth when prompting your front-end agent. Copy-paste any section into the agent's system prompt.

---

## 0 · Mental model

An option chain is **not a table**. It is a **mirrored ledger** with a single vertical axis (strike) and two symmetric wings (calls / puts). The user reads it as a 2D field: rows = strike level, columns = same metric on both sides. Every design choice should reinforce that mirror geometry.

The user's job: scan the field and find a number to act on. The design's job: get out of the way of that scan.

---

## 1 · Typography

### Font
- **Monospace, always.** Tabular figures are the whole game. IBM Plex Mono, JetBrains Mono, SF Mono, or Berkeley Mono. Avoid stylized monos (Fira Code, Operator) — ligatures and personality cost milliseconds per row.
- **One font family for everything in the chain.** Add a sans only for chrome (toolbars, menus, modals).
- **One weight for numbers (400 or 500).** Do not bold numbers to indicate state — that's what color and background are for.

### Size scale
| Use | Size | Line-height |
|---|---|---|
| Primary cell value (mark, last, bid, ask) | **12–13 px** | 1.0–1.15 |
| Secondary (IV, greeks) | 11 px | 1.0 |
| Tertiary (vol, OI, % chg context) | 10 px | 1.0 |
| Column header | 9–10 px, uppercase, letter-spacing 0.08–0.12em | 1.0 |
| Meta strip / status bar | 10 px | 1.0 |
| Window/tab chrome | 11–12 px (sans OK here) | 1.4 |

Never go below **10px** for a number a user has to read. Never go above **14px** in the chain itself — bigger and rows feel like product cards.

### Number formatting
- **Right-align every numeric column.** No exceptions. Decimal point is the anchor.
- **`font-variant-numeric: tabular-nums;`** on every cell. Without this, "1.11" and "1.99" have different widths and the column shimmers as values tick.
- **Dim decimals.** `5.47` → integer at 100% foreground, `.47` at ~55%. Magnitude reads first, precision second.
- **Dim trailing zeros.** `108.50` → `108.5` with the `0` at ~30%.
- **Compact large integers.** `18,432` → `18.4k`, `1,240,000` → `1.24M`. The suffix is metadata — dim it (~30% foreground).
- **Decimals by magnitude.** Prices ≥ 100: 2 dp. Prices 1–100: 2 dp. Prices < 1: 3 dp (don't lose the cents). IV: 1 dp percent. Greeks: Δ to 3, Γ Θ V to 3–4.
- **Always sign positive numbers.** `+0.42` and `-0.42` are a pair; `0.42` and `-0.42` are not.

---

## 2 · Color system

Build on a desaturated dark base. Saturation belongs to data, not chrome.

### Foreground levels (use exactly three)
| Level | Lightness | Use |
|---|---|---|
| Primary | `oklch(0.86 0.04 90)` (warm) or `oklch(0.90 0.02 220)` (cool) | Mark, last, bid, ask, strike |
| Secondary | `oklch(0.62 0.04 90)` | IV, Δ, Γ, Θ, V |
| Tertiary | `oklch(0.40 0.04 90)` | Vol, OI, suffixes ("k", "M"), trailing zeros |

Do **not** introduce a fourth level. If something feels wrong, it's a structural problem, not a contrast problem.

### Backgrounds
| Layer | Lightness |
|---|---|
| App bg | `oklch(0.10 0.005 90)` |
| Pane bg | `oklch(0.13 0.005 90)` |
| Strike spine | `oklch(0.16 0.01 90)` |
| ITM row shade | `oklch(0.18 0.01 90)` (≈ +6 L* over app bg) |
| ATM highlight | `oklch(0.24 0.04 75)` (warmer, brand-tinted) |
| Hover row | `oklch(0.20 0.02 220)` (cool counter to data colors) |

ITM shading should be **felt, not seen**. If you can describe it as a color, it's too strong.

### Semantic colors
- **Pos / up:** `oklch(0.74 0.18 145)`
- **Neg / down:** `oklch(0.66 0.21 25)`
- **Bid (warm):** `oklch(0.72 0.16 50)` — sell-into
- **Ask (cool):** `oklch(0.78 0.14 220)` — buy-from
- **Brand / strike / accent:** one color only — amber, cyan, or paper-orange.

Pick **one** semantic palette and use it everywhere. Bid/ask colors must be the same color on every screen of the app.

### Color rules
- Never use color alone for sign — always pair with `+`/`-` or a glyph (`▲`/`▼`). ~8% of users are red-green color-blind.
- Never use red and green for non-direction meanings. Red ≠ "selected," green ≠ "active."
- Tick flashes use a **background tint with opacity 0.3**, animating to transparent over 600–800 ms. Never flash the foreground color.

---

## 3 · Layout & spacing

### The chain grid
```
[ Calls cols, reversed order ] [ STRIKE ] [ Puts cols ]
```
- Put columns **mirror** call columns: the same metric sits the same horizontal distance from the spine on both sides.
- Number columns: **52–60 px wide**. Just enough for "108.50" or "12.5k". Don't auto-fit — fixed widths prevent layout jitter on tick.
- Strike column: **60–80 px**, centered, slightly different background, **hairline borders** on both sides. It's architecture, not data.

### Row height
- **18 px** — terminal default, ≈ 50 strikes per 1080 px.
- **22 px** — comfortable, recommended for primary chain on most desks.
- **14 px** — only for peripheral panes; click targets and read accuracy drop.
- **28 px** — kiosk/ambient only.

Make this user-configurable. Persist per device.

### Padding
- Cell horizontal padding: **6–10 px**. The number is the cell.
- Cell vertical padding: **0**. Use line-height to vertically center.
- Pane gutter (between docked panels): **3 px** divider in `bg-1`, hover-resizable.
- Section header padding: **3 px vertical** — they're tabs, not headlines.

### Borders
- Use **hairlines (1 px, ~10–15% L* over bg)** for row separators. Anything heavier breaks scan rhythm.
- Borders on the strike column should be slightly more visible (~20% L*) — it's a structural line.
- No card borders, no rounded corners on data surfaces. Right angles only inside the chain.

---

## 4 · The strike column (the spine)

- Sticky horizontal position; never scrolls off.
- Centered text, brand color, hairline borders both sides.
- ATM row: warmer background, slightly lighter text. Optional small marker glyph (`◀`) so it's findable at any scroll position.
- **Spot lives between strikes.** If precision matters, draw a horizontal line between the two flanking rows labeled `SPOT 581.20` in the brand color.
- Header row sticky to top of pane. Strike column header reads `Strike` or `K`, lowercase fine.

---

## 5 · ITM / OTM treatment

- ITM = in-the-money: calls below spot, puts above spot.
- Shade ITM rows with **+6 to +8 L*** over the row background.
- **Do not** dim OTM text — they still need full precision when the user scrolls there.
- ITM/OTM is geometry, not state. Don't add labels, badges, or icons.

---

## 6 · Sign and direction

- **Always redundant-encode.** `+1.42` in green, `-1.42` in red. Or `▲ 1.42` / `▼ 1.42` for monochrome contexts.
- Sign character before the number, never after.
- Drop trailing % if the column header already says `%Chg`.
- `%` and `bps` and absolute change are different columns — pick one for the chain, expose the others on hover or in detail.

---

## 7 · Bid / ask / mark

Three viable layouts; pick one per use case:

| Layout | When |
|---|---|
| Side-by-side columns | Default. Two cells, bid (warm) + ask (cool). Spread = visual gap implied. |
| Stacked in one cell | Half the column count, ladder feel. Worse for fast row-scanning. |
| Mark + spread bar | Liquidity-first views. 50 px bar that turns red when spread/mark > 5%. |

Never show only one of bid/ask without making the choice explicit ("Mark" / "Mid" / "Last" header).

---

## 8 · Tick flashing

- On price change, flash the **cell background** with the up/down semantic color at 30% opacity, fading to transparent over **600–800 ms**.
- Never flash the text color — flashing text is unreadable.
- Skip flashes when value is unchanged (size or volume tick on same price).
- Allow user to disable / slow down flashes (some traders find them distracting).

---

## 9 · Multi-tab web app patterns

The chain is one view among many (chain, strategy builder, blotter, positions, charts). Patterns for the shell:

### Tab bar
- **22 px tall.** Mono or sans, 11 px, uppercase optional.
- Active tab: brand color top border (1 px), pane bg (so it visually attaches to the body).
- Inactive: dim foreground, pane-1 bg.
- `×` close glyph at 60% foreground, full opacity on hover.
- Tabs are **draggable and dockable** (dockview/golden-layout pattern). Allow split horizontal/vertical from a tab's context menu.

### Pane chrome
- **20 px** pane header. Title left (uppercase, letter-spacing 0.10em), actions right (`—` minimize, `□` maximize, `×` close).
- 5 px brand-colored dot before title for the active/focused pane.
- Pane border: 1 px, `border-2` color. No drop shadows on data panes.

### Toolbars
- **26 px** tall. Grouped by logical concern, separated by 1 px vertical dividers.
- Buttons are text + minimal padding. No filled backgrounds for inactive states.
- Active button: brand color background, app-bg text. Hover: pane-2 bg.
- Inputs: 1 px border, app bg, mono font, focus state = brand-color border.

### Status bar
- **18 px** at the bottom of every tab. Mono, 10 px, dim foreground.
- Connection dot (1 dot, glow shadow), feed name, symbol, DTE, ATM, latency, last-update timestamp.
- Live data → glow green; stale → solid amber; disconnected → solid red.

### Expiry tabs
- **22 px** strip beneath the toolbar. Mono, 10 px.
- Format: `29MAY26` (date code) + `30d` (DTE) on the right at 9 px, 70% opacity.
- Active: brand-color background, app-bg text.

### Range / strike-zoom slider
- **24 px** strip beneath expiry tabs.
- 4 px-tall track, brand-color fill between two 8×10 px draggable handles.
- Vertical 6 px ticks below the track for each strike.
- ATM marker: `▼` glyph above the track in brand color.

---

## 10 · Density vs comfort — exposing the choice

Build the chain so density is one CSS variable: `--row-h: 18px;`. Wire it to a Tweaks/Settings panel. Provide three presets (Compact / Default / Comfortable) and a numeric override.

```css
.oc-cell { height: var(--row-h); line-height: calc(var(--row-h) - 1px); }
```

---

## 11 · Interactions (minimum viable)

- **Click a column header** → hide that column.
- **Right-click a column header** → menu of all hidden columns + reset.
- **Click a row** → select; populate order ticket / detail pane.
- **j / k or ↓ / ↑** → next / previous strike.
- **a** → jump to ATM.
- **g / G** → top / bottom of chain.
- **Drag handles in the range bar** → zoom strike range.
- **Hover row** → cool-tinted background (counter-color to red/green).
- **Scroll** → strike column and headers stay sticky.

---

## 12 · Anti-patterns (do not do)

- ❌ **Centered numbers.** Decimal point loses its anchor.
- ❌ **Bold numbers** to indicate state. Color and background do this job.
- ❌ **Rounded corners** inside the chain.
- ❌ **Drop shadows** on data panes.
- ❌ **Color alone** for direction.
- ❌ **Auto-resizing columns.** Numbers ticking should not move horizontally.
- ❌ **Bordered cards** for individual strikes. The chain is one surface.
- ❌ **Icons in numeric cells.** No 🟢 / 🔴 / 📈. Glyphs OK (`▲ ▼`); pictograms no.
- ❌ **Sentence-cased column headers** (`Volume`, `Open Interest`). Use uppercase abbreviations (`VOL`, `OI`) at 9–10 px.
- ❌ **Animations** beyond the tick flash. No row-enter, no column-slide.

---

## 13 · CSS variables to hand the agent

```css
:root {
  /* Layer */
  --bg:        oklch(0.10 0.005 90);
  --bg-1:      oklch(0.13 0.005 90);
  --bg-2:      oklch(0.16 0.010 90);
  --border:    oklch(0.22 0.010 90);
  --border-2:  oklch(0.30 0.020 90);

  /* Foreground */
  --fg:        oklch(0.86 0.040 90);
  --fg-dim:    oklch(0.62 0.040 90);
  --fg-mute:   oklch(0.40 0.040 90);

  /* Semantic */
  --accent:    oklch(0.78 0.16 75);   /* brand / strike */
  --pos:       oklch(0.74 0.18 145);
  --neg:       oklch(0.66 0.21 25);
  --bid:       oklch(0.72 0.16 50);
  --ask:       oklch(0.78 0.14 220);

  /* Surfaces */
  --itm:       oklch(0.18 0.010 90);
  --atm:       oklch(0.24 0.040 75);
  --sel:       oklch(0.20 0.020 220);

  /* Geometry */
  --row-h:     18px;
  --col-num:   58px;
  --col-strike:60px;
  --pane-hdr:  20px;
  --tab-h:     22px;
  --toolbar-h: 26px;
  --status-h:  18px;

  /* Type */
  --mono:      'IBM Plex Mono', 'JetBrains Mono', monospace;
  --t-cell:    12px;
  --t-cell-2:  11px;
  --t-cell-3:  10px;
  --t-head:    9px;
}
```

---

## 14 · Acceptance checklist

A chain is ready to ship when:

- [ ] Decimal points form a perfectly straight vertical line in every numeric column at every value.
- [ ] No layout shift occurs when any cell ticks (verify with `repeat-tick` simulator).
- [ ] All sign indications are encoded by both color and a `+` / `-` / glyph.
- [ ] ITM rows are visibly shaded but text is not dimmed.
- [ ] Strike column is sticky on scroll; headers are sticky to the top of the pane.
- [ ] At 18 px row height, ≥ 40 strikes are visible on a 1080 px-tall pane.
- [ ] Keyboard nav (j/k/a/g/G) works without focusing a cell first.
- [ ] Tick flashes are background-only and complete in ≤ 800 ms.
- [ ] No font weight changes anywhere in the chain.
- [ ] No rounded corners, no drop shadows, no animations in the data area.

---

## 15 · One-paragraph north star (for the agent's system prompt)

> Build an option chain as a mirrored ledger of numbers. Monospace, right-aligned, tabular figures, dim decimals so magnitude reads first. Three foreground levels — primary (mark/strike), secondary (IV/greeks), tertiary (vol/OI). One brand accent for the strike spine and the ATM. Red/green for direction, always paired with a sign character. ITM rows shade their background, never dim their text. The strike column is architecture: sticky, slightly different background, hairline borders both sides. Tick flashes are 600–800 ms background fades, never text changes. Row height is one CSS variable; default 18 px. No rounded corners, no shadows, no animations beyond the tick. The user's eye should land on a price in under 200 ms.
