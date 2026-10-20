# Context compaction

Compaction receives the exact protocol records returned by the normal
`[idx_head, idx_tail]` compiler. Raw records are never deleted or rewritten.
The compaction request has no Worker tools and treats the supplied records as
evidence, not as instructions. The model must return one complete Markdown
checkpoint beginning with `# Durable working context`.

The checkpoint keeps the following sections in order:

1. concepts and terminology;
2. authoritative resources and exact locations;
3. a causally relevant chronicle;
4. active decisions and constraints;
5. the Contexts worth re-reading;
6. the current objective and next step;
7. unfinished work and evidence routes.

`read_context` output is not replayed after a checkpoint: a detail the
checkpoint drops is recoverable only by reading that Context again. The fifth
section therefore carries one bullet per Context the thread read whose detail
the checkpoint does not restate — the exact `context_id`, then why it must be
read again and which decision or next step depends on it — so the next request
re-reads instead of trusting a memory of a Context it no longer holds. Asking
the model for that judgment keeps it the model's decision which Contexts stop
mattering; read output is never pinned into the request.

A loaded Context is the exception. The controller delivers its current copy again
after the checkpoint, so the fifth section never lists a loaded Context and the
model never restates its content: `load_context` is what carries material across
a compaction.

The final section contains a fenced JSON array with `topic_key`, `status`,
`message_range`, and `search_keywords`. Calendar times are copied only when
they are explicit in the source metadata; record-order references are used for
relative chronology.

## Trigger

Every thread replays its compiled context through a context budget before an
inference request is derived. The effective budget is the thread's own
`context_budget_tokens` override, or the user's `thread_defaults` value when the
thread has none; `0` disables proactive compaction, and the built-in default is
200,000 tokens. The controller estimates the next request's input size from the
latest measured inference input plus appended record bytes, or from the whole
compiled range when a checkpoint was created after that anchor. When the
estimate exceeds the budget, the context is compacted into a checkpoint before
inference; the effort is bounded, and the reactive overflow path remains the safety net.

Each `agent` request also compacts reactively: when the upstream reports a
context-window error, the controller compacts and retries.

## Reduction algorithm

The working state is an optional compacted prefix followed by a contiguous raw
suffix:

```text
[summary prefix] + [raw record suffix]
```

The controller first submits the complete state. On a context-window error it
compacts the left half, promotes that result to the temporary prefix, removes
the compacted records from the raw suffix, and retries the complete state. If a single raw record is still too large,
its serialized JSON is split into ordered fragments carrying its record index, kind, ordinal,
count, and digest; fragment width is reduced until the upstream window accepts
the request. Any other error stops the process immediately.

## Summary request

The compaction instruction is delivered as the final user message after the
replayed conversation, so the summarization call shares the conversation's
prefix cache and only the trailing instruction is new.

Only the final validated Markdown is appended as a `checkpoint` record. The
source records and every ordinary Responses output remain available through
the history API and their original record indices.

## Language

The instruction prose follows the user's Linkit language preference
(`profiles.lang`, a comma-separated priority list such as `zh-CN,en-US`). The
first tag decides, `zh*` selects Chinese, and an empty or unrecognized tag keeps
English. The controller captures the preference when it checks the Linkit
channel and stores it beside the integration credentials, so compaction itself
stays a local row lookup and never calls Linkit. Section headings stay English
in every language: `validate_checkpoint_text` enforces them, consolidation of a
prior checkpoint keys on them, and the transcript renders them as written.

## Manual compaction

Manual compaction uses this same compiler, reduction algorithm, and checkpoint
validation. It does not execute tools or continue the task afterward. The
checkpoint is committed only if both the source tail and the request boundary
are still current. Stopping compaction or submitting a newer request prevents
an obsolete checkpoint from replacing the active context.
