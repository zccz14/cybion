# Manual Format

A user Manual is not an essay for a human; it is **context** that models reread and edit mechanically. With the wrong format every update becomes a rewrite, and every rewrite drifts.

This page fixes the shape of agent-maintained user Manuals such as "Project Index" and "Value Bias". A Manual the user wrote by hand keeps his own style — do not retrofit it.

## Six hard rules

1. **One entry per line, one thing per entry**: fields separated by ` | ` (half-width pipe, one space each side), fixed order, no nesting, no sub-bullets.
2. **Every entry starts with a searchable key**: index lines start with the name, bias lines with the scenario. Finding an entry is a string match, not a read of the whole file.
3. **Dates are always `YYYY-MM-DD`**, day precision; add a time only when the exact moment matters.
4. **Only decidable criteria**, no backstory. Delete "because this bit us last time, therefore…" and keep "when X, do Y".
5. **Edit, do not rewrite**: append a line or replace exactly the line that changed. Restructuring the whole Manual (new fields, new sections, bulk deletes) needs the user's agreement first.
6. **Mark the source**: `(YYYY-MM-DD · where it came from)` at the end of the line, or as its own column. Traceability is what makes overruling possible.

## The skeleton

```text
# <Manual name>

> One-line purpose + field contract (fixed order; write ? when unsure)

<entries: one line each>
```

- The heading is the Manual's name, matching `name`; no aliases.
- That `>` line is the field contract for humans and for you: change it before you change the field order.
- Entries are not grouped and carry no sub-headings; past roughly 60 lines, split into sections with level-2 headings.

## Convergence

- A Manual **converges**: it is not append-only. More than three entries of the same kind should merge into one more general entry.
- Dead entries are **deleted**, never marked "deprecated" — leftovers keep getting read into context, which is worse than absent.
- Around 60 lines is the ceiling; merge first, and only then consider child Manuals.

## How Note, Manual and Archive divide the work

- **Note**: what this turn must achieve, and its TODOs; crossed out when done.
- **Manual**: criteria and facts that must survive turns and compaction — the format this page describes.
- **Archive**: history, append-only, never edited.
- In one line: what disappears when done is a Note, what stays valid and must converge is a Manual, what exists for review is an Archive.

## When to create a Manual

- Create it when the hook actually fires (there is a first project to record, a first bias to record) — do not pre-create empty Manuals.
- Say one sentence when you create it, so the user knows it exists, can edit it, and can delete it.
- A Manual the user deleted is not recreated.
