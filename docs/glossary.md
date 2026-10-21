# Glossary

How Cybion names the material a Thread works from. Every user-facing string,
tool name, route, table, type and test name follows this page. When a name here
and a name in the code disagree, the code is wrong.

## Context (上下文)

**Context** is the umbrella: everything a Thread works from. It is not a stored
object and it has no table of its own. It has exactly four kinds.

| Kind | zh | Surface | Lifetime | Stored |
| --- | --- | --- | --- | --- |
| Manual | 手册 | `/manuals`, `load_manual` | converges | yes, revisions |
| Note | 便签 | `/notes`, `add_notes` | clears to zero | yes, per Thread |
| Archive | 档案 | `/archive` | only grows | yes, append-only |
| World | 世界 | **none** | unbounded | **no** |

Ordered by lifetime: a Note should clear to zero, a Manual converges, the
Archive only grows, and the World never stops changing.

### Completeness

Every piece of material is exactly one of the four. Anything that appears to fit
none of them is a gap in the model, not an exception: either it belongs to one of
the four and we named it badly, or the model has to change. There is no fifth
kind granted by default and no "other" bucket.

Classifier, in this order:

1. **World** — outside us, cannot be stored whole, changed by others without our
   permission, and every read is a sample at one moment.
2. **Manual** — text *we* write describing how to get somewhere: a claim that
   can be revised, can go stale, and can be wrong.
3. **Note** — one line, one action, owned by exactly one Thread, expected to
   reach zero.
4. **Archive** — the immutable record of what a Thread sent and received.

### World is a concept, not an object

The World is the referent, never a row. It has no table, no `world_id`, no
route, no page, no menu, no tool group, and it is uncountable: *the world*,
never *worlds*. A Thread reaches the World only by reading — Worker calls,
`browser_control`, `computer_use`, `view_image`, `normai_web_search` — and what
comes back is evidence in the Archive, not a copy of the World.

Consequence: an entry that says *where the World is reachable* — an SSH host, a
NAS, a credential, an inventory of live servers — is a **Manual**, not a World.
The Manual is the claim; the World is what it is about. This is why `locked`
Manuals and `Use When` routing exist: a claim needs to be protected from
careless rewriting and needs a condition for when it is worth reading.

### What keeps the word "context"

`context` in these senses means the model's token window and stays as it is:

- `context_budget_tokens`, `default_context_budget_tokens` (Thread setting)
- `CompiledThreadContext`, `compile_thread_context`, `replayable_context_items`
- `is_context_overflow`, `context_length_exceeded`, `context_window_exceeded`
- `context_compaction`, `docs/replay.md`, `docs/context_compacting.md`
- React's `createContext`/`useContext` and every `*Context` provider

Bare 上下文 is reserved for the umbrella. The window sense must always carry a
qualifier, in UI copy and in prompts:

| Do not write | Write |
| --- | --- |
| 上下文预算 | 上下文窗口预算 / **重放预算** |
| 压缩上下文 | 上下文压缩（生成检查点） |
| 引用全部上下文生成标题 | 引用全部重放内容生成标题 |

## Naming rules

1. **Code says manual, copy says 手册.** No identifier, route, table, column,
   tool name or file is named `context` for the Manual kind.
2. **档案 is the stored kind; 归档 is the verb** on a Thread. Never 存档 —
   three words for two things is how the old mess started.
3. **受控上下文 / governed context is retired.** It was the old name for the
   umbrella; the umbrella is now just Context.
4. **The World never appears in code.** Not as a constant, a group, a filter or
   a config key. If a patch needs a `world` identifier, the patch has misread
   the model.
5. **A kind is not a tool group.** `tools.json` groups tools by *who executes
   them*: `worker` runs on the device, while `kernel`, `note` and `native` run in
   the Controller (see `tool_phase` in `src/cloud/run_phase.rs`). `kernel`
   therefore carries the Manual tools together with the Worker and
   Ultimate-Machine tools, and it is named for the phase rather than for a kind.
   No `world` group is ever added.
6. **Persisted names are frozen.** History rows already carry `context_loaded`,
   `context_unloaded` and the tool name `load_context`; replay prefix
   byte-identity forbids rewriting them. New names are added beside the old ones
   and the old ones stay readable forever (`read_context` is the precedent).

## Terms

| Concept | English | 中文 | Notes |
| --- | --- | --- | --- |
| umbrella | Context | 上下文 | sentence case; plural Contexts |
| kind 1 | Manual | 手册 | plural Manuals; `/manuals` |
| kind 2 | Note | 便签 | plural Notes; `/notes` |
| kind 3 | Archive | 档案 | singular; `/archive`; verb is "archive a Thread" (归档) |
| kind 4 | World | 世界 | uncountable; never an object |
| shipped read-only tree | Cybion Common Manual | Cybion 公共手册 | `common-contexts/tree.json`; source `common` |
| routing condition | Use When | 何时需要 | the Manual's description field |
