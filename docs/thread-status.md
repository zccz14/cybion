# Thread execution status

The Thread list and conversation use one status vocabulary. It describes the
**current or latest execution**, not whether the conversation is permanently
finished or the user's real-world objective has been achieved.

| API `display_status` | English / 中文 | Shape | Color | Meaning |
| --- | --- | --- | --- | --- |
| `ready` | Ready / 待开始 | Dashed message square | Muted | No execution has started. |
| `running` | Running / 运行中 | Rotating segmented loader | Amber | The current request is executing. |
| `compacting` | Compacting / 压缩中 | Inward arrows | Amber | A requested context checkpoint is being created. |
| `completed` | Completed / 已完成 | Check | Green | The latest execution finished successfully. |
| `failed` | Failed / 执行失败 | Warning triangle | Red | The latest execution failed; inspect the conversation for details. |
| `stopped` | Stopped / 已停止 | Square | Muted | Execution was explicitly stopped; saved history can be continued. |

## Presentation

- List rows reserve a fixed 16px icon slot, then a title and visible status label.
  Titles truncate; hovering or keyboard-focusing a row shows the full title and
  an explanation. Status labels remain visible on touch devices.
- The selected row has a neutral background/border and `aria-current="page"`.
  Selection does not change the execution color.
- The detail header and active-execution message reuse the same icon, label,
  and color mapping. The currently open row uses the detail query's snapshot
  so its status agrees with the header even between list polls.
- Amber is reserved here for active work, green for successful completion, red
  for failure, and muted ink for neutral states. Each status has a distinct
  shape and visible text; color and animation are supplementary signals.
- Only the running loader rotates (1.5s/cycle). `prefers-reduced-motion: reduce`
  removes that animation. Terminal states are static.
- Semantic color tokens have separate light/dark values. Browser tests check
  list-label contrast of at least 4.5:1, including the selected row.

## Authoritative state

The controller returns `display_status` with each Thread view (create, list,
read, update, and cancel). Execution control uses the persisted Thread `status`: `idle`, `running`, or
`failed`. `running` means that the Controller should keep advancing the Thread,
including tool waits and retry backoff; it is not merely an in-memory task flag.
Controller startup and periodic supervision resume running Threads without a
new user input. Existing input/control record IDs fence stale responses; there
is no separate execution entity. See [recovery](thread-recovery.md).

Both fields have a purpose: `status` governs execution controls; `display_status`
explains the current execution or its outcome. No new stored state, schema
migration, per-row history fetch, or client-side inference is needed.

A shared SQL projection reads the current control state and the newest **input
or thread-control record**, ordered by durable record ID:

1. `failed` is always displayed as failed.
2. `running` is compacting if the latest request boundary is a compact action;
   otherwise it is running.
3. `idle` with no request boundary is ready.
4. `idle` after a cancel boundary is stopped.
5. Remaining `idle` executions are completed.

This follows the controller invariant that idle is written only on creation,
successful finalization, or cancellation. A title change, completed title audit,
partial response, tool result, checkpoint, or late activity from a superseded
request is not an execution boundary. Raw non-JSON activity is not a control
record. The result is read in the same SQLite statement as Thread metadata.

## Validation and complexity

- Backend tests exercise create → run → complete → continue → cancel → compact
  → complete → fail → retry, including late failure/success, newer-input
  supersession, renames, independent threads/users, and raw activity payloads.
- Frontend tests cover bilingual labels and reuse by both lists and conversation
  surfaces. Playwright covers every icon/label, selected navigation, keyboard
  tooltips, state updates, reduced motion, light/dark contrast, and narrow layouts.
- The necessary classification paths are confined to the server projection.
  Client presentation is a fixed lookup table. The open row's snapshot selection
  prevents disagreement with the header. No new compatibility/fallback paths are
  introduced; the previous independent browser-side compaction resolver is removed.

Commands:

```sh
npm --prefix web run check
npm --prefix web run test:e2e
npm --prefix web run build
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
```
