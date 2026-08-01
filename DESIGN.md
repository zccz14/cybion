# Design

## Visual direction

Product UI for focused, high-consequence operation. The physical scene is a
developer at a desk moving between a browser and real machines under normal room
light: use a cool near-white working surface with one deep indigo action color,
not terminal-black theatre.

## Tokens

- Background: `oklch(0.975 0.006 265)`
- Surface: `oklch(1 0 0)`
- Ink: `oklch(0.23 0.026 265)`
- Muted ink: `oklch(0.47 0.026 265)`
- Primary: `oklch(0.43 0.17 274)`
- Border: `oklch(0.88 0.014 265)`
- Danger: `oklch(0.54 0.2 27)`

Use Inter/system UI, 12--28px type steps, 10px controls, and 14px panels. Motion
is limited to 180ms state transitions and is removed for reduced-motion users.

## Themes and language

The UI follows the OS light/dark preference on first load, then retains the
operator's explicit choice. Dark mode uses a cool near-black surface and preserves
the indigo action signal. English and Simplified Chinese are first-class UI
languages and use the same compact product layout.

## Layout

Desktop uses a narrow persistent navigation rail, a contextual top bar, and a
single dense primary work area. On smaller screens navigation collapses before
conversation controls do. Machine identity is always visible near the action.
