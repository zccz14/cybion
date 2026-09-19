# Design

## Visual direction

Cybion is a focused operational workspace. Surface depth, typography, spacing,
and explicit execution status establish hierarchy.

Light mode uses cool near-white surfaces and a deep indigo action color. Dark
mode uses neutral near-black and charcoal surfaces, near-white primary actions,
and restrained semantic status colors. The two themes share layout and behavior.

## Color tokens

`web/src/styles.css` is the implementation source for the semantic tokens below.
Keep the existing light palette when changing dark mode. In dark mode, base
surfaces, borders, text, selection, and focus colors are achromatic (R = G = B).

### Light palette

| Token | Value |
| --- | --- |
| `background` | `oklch(0.975 0.006 265)` |
| `card`, `popover` | `oklch(1 0 0)` |
| `foreground` | `oklch(0.23 0.026 265)` |
| `muted-foreground` | `oklch(0.47 0.026 265)` |
| `primary` | `oklch(0.43 0.17 274)` |
| `primary-foreground` | `oklch(0.99 0.002 265)` |
| `border`, `input` | `oklch(0.88 0.014 265)` |
| `destructive` | `oklch(0.577 0.245 27.325)` |

### Dark palette

| Token | Value | Use |
| --- | --- | --- |
| `background` | `#121212` | Main working surface |
| `sidebar` | `#161616` | Navigation surface |
| `card` | `#1C1C1C` | Cards, assistant messages, reasoning panels |
| `popover` | `#242424` | Floating menus and selection lists |
| `secondary`, `muted` | `#262626` | Secondary surfaces and controls |
| `accent`, `sidebar-accent` | `#303030` | Hover and selected surfaces |
| `border`, `sidebar-border` | `#383838` | Dividers and panel boundaries |
| `input` | `#454545` | Input boundaries and translucent input fills |
| `foreground` | `#F2F2F2` | Main text and icons |
| `muted-foreground` | `#A3A3A3` | Secondary text and metadata |
| `primary`, `sidebar-primary` | `#E5E5E5` | Primary actions |
| `primary-foreground`, `sidebar-primary-foreground` | `#171717` | Text and icons on primary actions |
| `ring`, `sidebar-ring` | `#D4D4D4` | Keyboard focus; also remains visible at 50% opacity |
| `user-message` | `#262626` | User message surface, independent of action color |
| `user-message-foreground` | `#F2F2F2` | User message text |
| `destructive` | `oklch(0.704 0.191 22.216)` | Destructive actions and errors |

Card, popover, secondary, accent, and sidebar foregrounds inherit `foreground`.
Sidebar action, border, and focus tokens alias their corresponding main tokens.
Surface levels remain distinct through neutral luminance steps.

## Conversation surfaces

User messages use the dedicated `user-message` tokens: in light mode these alias
`primary` / `primary-foreground`; in dark mode they alias `muted` / `foreground`.
Near-white primary buttons therefore remain compact action signals while long
user messages remain dark gray. Assistant messages and reasoning panels use the
card surface in dark mode. Reasoning-panel boundaries use the neutral border.

Dark Markdown uses the neutral typography palette for body text, headings,
quotes, links, tables, and code. Light Markdown keeps its existing palette.

## Typography, interaction, and accessibility

Use Geist Variable/system sans-serif, 12–28px type steps, compact controls, and
rounded panels. Motion is limited to 180ms state transitions and the
active-execution loader; both are removed for reduced-motion users.

Keep text contrast at least 4.5:1 on its rendered surface. Check secondary text
on selected/hovered rows as well as default rows. Primary action text and keyboard
focus must remain visible. Native controls and scrollbars use the active theme's
`color-scheme`. Keyboard, mobile, and reduced-motion behavior remain available.

## Themes and language

The UI follows the OS light/dark preference on first load, then retains the
operator's explicit choice. Theme switching changes the existing root `.dark`
class and its CSS tokens. English and Simplified Chinese are first-class UI
languages and use the same compact product layout.

## Layout

Desktop uses a narrow persistent navigation rail, a contextual top bar, and a
single dense primary work area. On smaller screens navigation collapses before
conversation controls do. Machine identity is always visible near the action.

## Thread execution status

Use the shared [Thread status vocabulary](docs/thread-status.md): amber segmented
loader for running, amber inward arrows for compaction, green check for completed,
red warning triangle for failed, muted square for stopped, and muted dashed message
square for ready. Every list row shows a status label. Selection is neutral and
separate from execution status.

Dark status colors stay amber `#FCD34D`, green `#6EE7B7`, and red `#FCA5A5`.
Color remains supplementary to the icon and visible label.
