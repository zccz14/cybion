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
5. the current objective and next step;
6. unfinished work and evidence routes.

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

The controller first submits the complete state. On a context-window error or an
exhausted output budget it compacts the left half, promotes that result to the
temporary prefix, removes the compacted records from the raw suffix, and retries
the complete state. If a single raw record is still too large, its serialized
JSON is split into ordered fragments carrying its record index, kind, ordinal,
count, and digest; fragment width is reduced until the upstream window accepts
the request. Any other error stops the process immediately.

## Summary request

The compaction instruction is delivered as the final user message after the
replayed conversation, so the summarization call shares the conversation's
prefix cache and only the trailing instruction is new. Its output cap is 65,536
tokens and must cover provider-counted reasoning tokens; when the upstream stops
the summary at that cap, the reduction algorithm treats it as reducible and
retries with a smaller range.

Only the final validated Markdown is appended as a `checkpoint` record. The
source records and every ordinary Responses output remain available through
the history API and their original record indices.

Manual compaction uses this same compiler, reduction algorithm, and checkpoint
validation. It does not execute tools or continue the task afterward. The
checkpoint is committed only if both the source tail and the request boundary
are still current. Stopping compaction or submitting a newer request prevents
an obsolete checkpoint from replacing the active context.
