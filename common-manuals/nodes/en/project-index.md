# Project Index

A user's projects sit in different directories across several Workers, and some exist only as a remote repository or a domain. The **project index** is a user Manual that records "where it is + what it is", one block per project. It does not explain projects; it routes. One block tells you which Worker and directory to open, or which remote to clone.

Together with **Value Bias** it forms the user's two standing Manuals: the index records **what the world looks like**, value bias records **how the user judges**. Facts and criteria never share one Manual.

## When to touch it

Only when a location appears or changes:

- Created or cloned a project → add a block.
- Moved to another Worker, new path, new remote → edit that block.
- Archived or deleted → drop that block.
- Found the location wrong while working (`cd` lands somewhere empty, the directory was renamed, the remote 404s) → **the disk wins**: fix it on the spot and tell the user in one sentence: "the index said A, it is actually B, corrected".

Never: periodic sweeps, scanning all of `~/Projects` to "refresh the index", or a "last verified" field. Upkeep has to cost nearly nothing, or nobody keeps it up.

## What one block looks like

Three fields: `project / location / summary`.

```text
# Project Index

> One project per block, three fields: project / location / summary. Location is "Worker label:path" or a remote repository URL; routing only, no status or progress.

project: Cybion
location: MacMini:~/Projects/Cybion · github.com/zccz14/cybion
summary: The Cybion controller and web frontend in one repo; Rust service plus TypeScript frontend, artifacts ship with tags
```

- **project**: whatever the user calls it; never invent an alias.
- **location**: `Worker label:path` (the label as returned by `cybion_list_workers`, so a block maps straight onto a `worker_id`), the remote repository, the public URL, joined by ` · `; several clones across Workers get written one by one.
- **summary**: what it is and who it exists for, plus **how to get in** (entry scripts, where the data file lives, page routes) — that is routing too. Still no status, progress, TODOs, secrets or accounts.

## Creating and editing

- Start with `list_manuals`: if the user already has a Manual of the same kind ("Project Index" or "项目索引") → **reuse it** and follow *its* fields; do not create a second one and do not rewrite it into this page's fields.
- Otherwise create it at the top level the first time there is something to record (`write_manual`), tell the user in one sentence, suggested name `Project Index`.
- Edit only that block; blocks the user wrote are authoritative — ask before changing them.
- If the user deletes the Manual, do not recreate it.

## Pitfalls

- **Guessing the summary from a directory name** → read at least the `README` or `git remote -v`; write `?` when unsure and fill it in next time.
- **Turning the index into a knowledge base** → no architecture detail, deployment steps, secrets, accounts, internal addresses or customer names.
- **Relative paths** → always Worker label + path, or a remote URL; otherwise nobody knows which machine to look on.
- **Treating the remote as a place to work** → the remote is where clones come from, not an execution surface; confirm which Worker holds the clone before doing anything.
