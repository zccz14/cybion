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
- The title line also shows how long ago the Thread was last updated — 刚刚 /
  5 分钟前 / 3 小时前 / N 天前 (just now / 5m ago / 3h ago / Nd ago) — refreshed
  once a minute from the browser clock.
- The selected row has a neutral background/border and `aria-current="page"`.
  Selection does not change the execution color.
- The detail header and active-execution message reuse the same icon, label,
  and color mapping. Every row renders the list's own polled snapshot, so the
  open row agrees with the header within one refresh interval; the list never
  borrows the conversation's snapshot to shortcut that wait.
- While a Worker call is in flight, the visible status text is the one-sentence
  `summary` written with the newest unanswered Worker call of the current turn
  instead of Running / 运行中. The icon, color, loader, and explanatory hint keep
  the running state. A Thread waiting on the model, a compacting Thread, a call
  recorded before summaries existed, or malformed arguments keep the canonical
  label. Long summaries truncate to one line; their full text stays in the
  label's title and the row tooltip.
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
explains the current execution or its outcome. No stored state, schema
migration, or client-side inference is needed.

The same projection derives `running_summary`. When the Thread is running it
prefers the newest `response_output` Worker call of the current turn that has no
matching tool output, extracting `arguments.summary` (or `input.summary` for a
custom tool call): a call in flight is what the Thread is doing, so it wins over
reasoning, which is only what the Thread is thinking. With no such call it falls
back to the newest `reasoning` record after `max(last input, last tool output)`
whose `summary` array still holds non-blank text, joining the parts with a blank
line. That waterline keeps the fallback honest - a tool result answers the
reasoning before it, so that text never reappears afterwards - and a reasoning
record without text is skipped instead of shadowing an older one that has some.
Worker calls are persisted and settled in record order, so an answered newest
call proves every older call in the turn is settled too. The lookup is one
indexed tail read of the Thread's own history, limited to running Threads; it
stores nothing and cannot drift from the conversation.

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
- Backend tests cover the running summary appearing for the newest unanswered
  call and for the newest reasoning summary after the waterline, preferring the
  call, dropping reasoning once its tool result lands, taking every text part
  while skipping text-less reasoning, ignoring the previous turn's records,
  falling back for calls recorded without a summary and for malformed
  arguments, and ending at finalization.
- Frontend tests cover bilingual labels, the summary replacement, and reuse by
  both lists and conversation surfaces. Playwright covers every icon/label,
  selected navigation, keyboard tooltips, state updates, reduced motion,
  light/dark contrast, truncation, and narrow layouts.
- The necessary classification paths are confined to the server projection.
  Client presentation is a fixed lookup table. The open row's snapshot selection
  prevents disagreement with the header. The previous independent browser-side
  compaction resolver is removed. A Worker call recorded before `summary`
  existed falls back to the canonical running label; history is append-only, so
  that presentation fallback is permanent and adds no second status path.

Commands:

```sh
pnpm --dir web run check
pnpm --dir web run test:e2e
pnpm --dir web run build
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
```
