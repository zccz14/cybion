# Context compaction

Compaction receives the exact protocol records returned by the normal
`[idx_head, idx_tail]` compiler. Raw records are never deleted or rewritten.
The compaction request has no Worker tools and begins with a terminal developer
policy that treats the supplied records as evidence. The model must return one
complete Markdown checkpoint beginning with `# Durable working context`.

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

## Reduction algorithm

The working state is an optional compacted prefix followed by a contiguous raw
suffix:

```text
[summary prefix] + [raw record suffix]
```

The controller first submits the complete state. On a context-window error it
compacts the left half, promotes that result to the temporary prefix, removes
the compacted records from the raw suffix, and retries the complete state. If a
single raw record is still too large, its serialized JSON is split into ordered
fragments carrying its record index, kind, ordinal, count, and digest; fragment
width is reduced until the upstream window accepts the request. A non-window
error stops the process immediately.

Only the final validated Markdown is appended as a `checkpoint` record. The
source records and every ordinary Responses output remain available through
the history API and their original record indices.

Manual compaction uses this same compiler, reduction algorithm, and checkpoint
validation. It does not execute tools or continue the task afterward. The
checkpoint is committed only if both the source tail and the request boundary
are still current. Stopping compaction or submitting a newer request prevents
an obsolete checkpoint from replacing the active context.
