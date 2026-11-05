# Manual Format

A user Manual is **context** that models reread and edit mechanically, not an essay for a human. With the wrong format every update becomes a rewrite, and every rewrite drifts.

This page is the **default format**. If the user's local Manuals include a manual-format page, theirs wins — it overrides this one.

## Block format

One entry per block, one blank line between blocks; field names end with a half-width colon, order fixed and declared on the `>` line at the top of the Manual.

```text
# <Manual name>

> One <unit> per block, N fields: field one / field two / field three. Any other contract goes here.

field one: ...
field two: ...
field three:
- use a list when you need more than one line
- one item per line
```

## Hard rules

1. One entry per block, fixed field order, field names ending with a half-width `:`.
2. No tables, no `|` separators, no nesting, no sub-headings; one blank line between blocks.
3. Dates are always `YYYY-MM-DD`.
4. Only decidable criteria and facts — no backstory, no persona.
5. Edit, do not rewrite: append a block, or change exactly that one block. Ask the user before restructuring the whole Manual (new fields, new sections, bulk deletes).
6. A block that gets overruled is deleted, never marked "obsolete" — leftovers keep getting read into context.
7. Converge: more than three entries of the same kind merge into one more general entry; keep the whole Manual near 60 lines.

## The `>` line

It is the field contract, for humans and for you: it declares the fields and their order. Change it before you change the fields; when the two disagree, the `>` line wins and the entries get fixed to match.

## Division of work

- **Note**: this turn's goals and TODOs; crossed out when done.
- **Manual**: criteria that must survive turns and compaction — in this format.
- **Archive**: append-only history, never revised.

## When to create a Manual

- Create it when the hook actually fires (a first project to record, a first bias to record) — never pre-create empty Manuals.
- Say one sentence when you create it, so the user knows it exists, can edit it, and can delete it.
- A Manual the user deleted is not recreated.
