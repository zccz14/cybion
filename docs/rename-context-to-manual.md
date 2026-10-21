# Renaming the Manual kind: Context → Manual

Transient working note. **Delete this file once the rename ships.** Terms and
rules live in [glossary.md](glossary.md); this file records what the rename
touched and what it deliberately left.

Baseline: `c88f44d`, schema 47, 2026-10-21. Done on branch
`rename/context-to-manual`; schema is now 48.

## Decisions

1. **No aliases.** Old tool names, old HTTP paths, old page routes and the
   `read_context` compatibility arm are gone in one release. Only the *data*
   already written to `history_records` is rewritten once, by the schema-48
   migration, so no code carries a legacy branch.
2. **The UI does not recognize old records.** A record the current build does
   not know falls back to the generic activity or tool renderer; the loaded
   panel is unaffected because it reads `thread_manual_loads`, not history.
3. **The tool-group key `context` became `kernel`.** The group is the execution
   phase (the Controller runs it), not a kind: it carries the Manual tools *and*
   the Worker/Ultimate-Machine tools. `world` never becomes a group.
4. **`context_dirty` is retired, not carried.** Those records are renamed to
   `manual_dirty` by the migration and no longer take part in replay, so the
   stale "call `read_context`" instruction they held stops reaching models.

## Four buckets

Every occurrence lands in exactly one:

| Bucket | Meaning | Action |
| --- | --- | --- |
| **R** | Manual kind | rename to `manual` / 手册 |
| **W** | model window / replay | keep `context`, add a qualifier in copy |
| **F** | frozen persisted name | never change; add the new name beside it |
| **X** | React / browser API | never touch |

## Rules by layer

### Storage (P4, schema 48)

| Now | Target | Count | Bucket |
| --- | --- | --- | --- |
| table `contexts` | `manuals` | 6 SQL strings | R |
| index `contexts_parent_sort`, `contexts_parent_name` | `manuals_parent_*` | 2 | R |
| table `thread_context_loads` | `thread_manual_loads` | 12 | R |
| column `context_id` | `manual_id` | 114 in `src` | R |
| column `context_budget_tokens` | **keep** | 4 | W |

`thread_context_loads` is not FK-declared on `context_id` (no `REFERENCES`), so
the rename is `ALTER TABLE ... RENAME TO` plus `RENAME COLUMN`, no table rebuild.
Migration tests must start from a real v47 database.

### HTTP (P3)

| Now | Target | Note |
| --- | --- | --- |
| `GET/POST /api/contexts` | `/api/manuals` | old path kept one minor, `Deprecation`-marked |
| `GET/PATCH/DELETE /api/contexts/{id}` | `/api/manuals/{id}` | same |
| `POST /api/contexts/{id}/move`, `/restore` | `/api/manuals/{id}/move`, `/restore` | same |
| `GET /api/common-contexts` | `/api/common-manuals` | same |

### Model-facing tools (P3)

| Now | Target | Count in `src` |
| --- | --- | --- |
| `cybion_list_contexts` | `cybion_list_manuals` | 9 |
| `load_context` | `load_manual` | 16 |
| `unload_context` | `unload_manual` | 11 |
| `write_context` | `write_manual` | 42 |
| `read_context` | keep as the compat arm only | 5 |

Old names stay callable forever (`read_context` in `src/cloud.rs:8564` is the
pattern): a long Thread repeats the tool name it stored. New names are advertised
in `tools.json`; old ones answer by pointing at the new one for one minor, then
answer as an alias without a deprecation line.

Tool-result wording changes with the name: `context_id` in arguments becomes
`manual_id`, `"context not found"` becomes `"manual not found"`, and the loaded
JSON key `"context"` (`src/cloud/context_loads.rs:187`) becomes `"manual"` —
**but only for new records**; records already in history replay their stored
payload byte for byte.

### `tools.json` groups

`context` is a **phase** group, not a kind: it holds the Manual tools *and*
`cybion_list_workers` plus the four Ultimate Machine tools, because the
Controller executes them (see the INVARIANT in `src/cloud/run_phase.rs:74`).
Under the glossary the World cannot own a group, so the group must not be
renamed to `manual` while it carries World tools. Open decision D1 below.

### Rust identifiers (P2, no behaviour change)

Rename: `WriteContextParent`, `WriteContextArguments`, `ContextIdArguments`,
`ContextView`, `ContextReadView`, `ContextSummary`, `ThreadContextLoadsView`,
`CreateContextInput`, `UpdateContextInput`, `MoveContextInput`, plus every
`*_context*` fn/field of the Manual kind (`write_context`, `create_context_view`,
`insert_context`, `move_context_view`, `validate_context_parent`,
`read_context_api`, `read_context_for`, `parse_context_sort_key`,
`append_context_sort_key`, `restore_context`, `resolve_context`,
`locked_context_message`, `local_context`, `loaded_contexts_view`,
`migrate_context_trash`, `migrate_context_sort_keys`, `migrate_context_lock`,
`backfill_context_sort_keys`, `include_context_tools`) and module paths
`src/cloud/context_loads.rs` → `manual_loads.rs`,
`src/cloud/common_contexts.rs` → `common_manuals.rs`, plus the three test files.

Keep: `CompiledThreadContext`, `compile_thread_context`,
`replayable_context_items`, `estimate_context_tokens`, `summarize_context_once`,
`compact_thread_context`, `compact_protocol_context`, `request_context_tail`,
`current_context`, `injected_context`, `is_context_overflow`,
`default_context_budget_tokens`, `migrate_legacy_upstream`'s context arguments.

### Web (P1 for copy, P3 for paths)

Rename i18n keys: `navGovernedContexts` → `navContexts`, `contexts` /
`contextsTitle` (already 手册) → `manuals` / `manualsTitle`, `contextLocalTitle`,
`contextEmpty`, `contextSelectHint`, `contextGlobalHint`, `contextLockedHint`,
`contextName`, `contextContentEditHint`, `contextUseWhenHelp`, `contextBodyHelp`,
`newContext`, `editContext`, `createContext`, `deleteContext`,
`deleteContextTitle`, `deleteContextDescription`, `contextCreated`,
`contextUpdated`, `contextDeleted`, `contextCollapse`, `contextExpand`,
`commonContextTitle`, `commonContextHint`, `toolLoadContext`, `toolUnloadContext`,
`toolWriteContext`, `toolListContexts` → `*Manual*` / `*Manuals*`.

Rename modules: `lib/contexts-tree.ts`, `lib/context-drafts.ts`,
`lib/thread-context-loads.ts`, `components/context-load-notice.tsx`,
`components/thread-context-loads.tsx`, class/type names `LocalLikeContext`,
`CommonContextNode`, `CommonContextBranch`, `ThreadContextLoads`,
`ThreadContextLoadsView`, `visibleContexts`, `loadsContexts`, `dragContextRow`,
`renumberContextSortKeys`, `findCommonContextNode`, `activeContext`.

Keep: `UiContext`, `UiContextValue`, `DndContext`, `CarouselContext`,
`useContext`, `createContext` (React), `canvas.getContext`,
`contextBudget`, `ThreadContextUsage`, `lib/thread-status.ts` copy.

Routes: `/contexts` → `/manuals`, `/history` → `/archive`, both with a redirect
from the old path for one minor.

### Shipped content (`common-contexts/`)

Root node name `Cybion 公共上下文` / `Cybion Common Context` → `Cybion 公共手册` /
`Cybion Common Manual`; descriptions and `nodes/{en,zh}/overview.md` sentences
that mention `load_context` / `unload_context` / "上下文" follow; bump
`tree.json` `revision`. Node ids do not change (a loaded id must keep resolving).

### Frozen (never in this rename)

`context_loaded`, `context_unloaded` activity kinds; `context_dirty` replayed by
old Threads; every `history_records.payload` already written; the `source` value
`"common"` in tool output.

## Acceptance

```sh
# R-bucket must be empty in source and copy (compat arms excepted):
grep -rn 'context' src web/src | grep -vE 'COMPATIBILITY|legacy|replay|window|budget|overflow|compaction|ThreadContext|CompiledThreadContext|createContext|useContext|getContext|Context\)' 

# W-bucket copy must carry a qualifier:
grep -rn '上下文预算\|压缩上下文' web/src   # must return nothing

# Frozen names still replay:
cargo test replayed_context replayed_context_strips_up_to_the_newest_switch_only
```

## Left for later

- `docs/context.md` and `docs/history.md` keep their file names; only the terms
  inside them moved. Renaming them to `replay.md` / `archive.md` is a separate
  documentation change.
- `docs/images/context-layout.png` shows the old labels and needs a re-shoot.
- `web/src/lib/history-payload.ts` is named after the Archive, not the Manual;
  untouched by this rename.
- Window-sense copy: `压缩上下文` and friends now read `重放上下文` in the thread
  header, but the admin usage note and the checkpoint panel still say 上下文 —
  they are correct as the umbrella's qualified use, not the Manual kind.
