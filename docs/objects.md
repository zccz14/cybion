# Object store

Binary media that the Controller writes into Threads lives in a
content-addressed object store under the Controller data directory:

```text
~/.cybion/objects/<first two hex characters>/<sha256>
```

Objects are immutable and written once: identical bytes share one object.
Directories use 0700 and files 0600 permissions. The store covers new media
only - records written before it shipped keep their inline base64.

## What is stored

- **Generated images**: the Controller decodes the upstream's `b64_json` and
  stores the bytes; the Thread record carries `result_ref` and `output_format`
  instead of `result`.
- **Pasted images**: when an input record is persisted, each validated
  `input_image` data URL is decoded and stored; the part carries `image_ref`
  and `media_type` instead of `image_url`.
- **Viewed images**: a successful `view_image` result is decoded and stored;
  the tool output carries `input_image` parts with `image_ref` and `media_type`.

Worker screenshots still store their base64 inline. Moving them is future work:
they live in two databases for shared Workers (the owner's call ledger and the
caller's history) and are classified by the Worker call ledger.

## Read path

`materialize_media` resolves references back to inline media at every read
seam:

- `load_protocol_items` (request replay, compaction, Thread naming),
- `load_history`, `thread_history_tail`, `thread_history_older_page` (browser
  conversation, Integration API, shared Threads),
- `input_record_images` (`reference_images` resolution).

Replay therefore sends the same inline data URLs it always did, and the browser
renders the same payloads. Only the raw History row endpoints
(`GET /api/history`, `GET /api/history/{id}`) expose the stored reference.

## Write ordering

The object is written before the history record commits. A crash can therefore
leave an unreferenced object (harmless), never a record whose object is
missing. A missing object fails the read loudly; there is no silent fallback.

## Pricing

An object reference replays as the image it restores, so it prices at the same
bounded media cost as the inline base64 did.

## Operations

Objects are not covered by the pre-release SQLite snapshots in
`deploy/deploy-release.sh`; any disaster-recovery plan must copy
`~/.cybion/objects/` alongside the databases. Deleting a Thread does not
reclaim objects today; there is no garbage collection yet.

## Compatibility

Inline base64 records keep replaying unchanged. Exit condition for that branch:
an offline backfill can move inline media into objects and drop the dual
handling; until then both shapes must resolve.
