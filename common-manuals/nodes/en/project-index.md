# Project Index

A user's projects sit in different directories across several Workers, and some exist only as a remote repository. The **project index** is a user Manual that records "project → where it is + what it is", one line each. It does not explain projects; it routes. One line tells you which Worker and which directory to open, or which remote to clone.

Together with **Value Bias** it forms the user's two standing Manuals: the index records **what the world looks like**, value bias records **how the user judges**. Facts and criteria never share one Manual.

## When to touch it

Only when a location appears or changes:

- Created or cloned a project → add a line.
- Moved to another Worker, new path, new remote → edit that line.
- Archived or deleted → drop that line.
- Found the location wrong while working (`cd` lands somewhere empty, the directory was renamed, the remote 404s) → **the disk wins**: fix it on the spot and tell the user in one sentence: "the index said A, it is actually B, corrected".

Never: periodic sweeps, scanning all of `~/Projects` to "refresh the index", or a "last verified" column. Upkeep has to cost nearly nothing, or nobody keeps it up.

## What one line looks like

`name | location | summary`

```text
# Project Index

> One project per line: name | location | summary
> Location is "Worker label:path" or a remote repository URL; when both exist, write both, separated by ·.

Cybion | MacMini:~/Projects/Cybion · git@github.com:zccz14/cybion.git | Cybion controller and web frontend (Rust + TypeScript, single repo)
example-project | Linux US:/srv/example | One sentence on what this project is for
```

- **name**: whatever the user calls it; never invent an alias.
- **location**: `Worker label:path` (the label as returned by `cybion_list_workers`, so a line maps straight onto a `worker_id`) or a remote URL. With both, write the local path you can actually work in first; several clones across Workers get one entry each, joined by `·`.
- **summary**: one sentence on what it is and who it exists for. **No status, progress, TODOs or tech-stack lists** — that turns a router into project documentation, and documentation rots.

## Creating and editing

- A similar Manual already exists in `list_manuals` (named like "Project Index" or "项目索引") → **reuse it**; do not create a second one.
- Otherwise create it at the top level the first time there is something to record (`write_manual`), and tell the user in one sentence: "I created a Project Index for you; new projects will add a line automatically." Suggested name: `Project Index`.
- Edit **only the line that changed**, leave every other line untouched. Lines the user wrote are authoritative — ask before changing them.
- If the user deletes the Manual, do not recreate it.
- Around 60 lines, merge duplicates (several clones of one repo) before considering sections.

## Pitfalls

- **Guessing the summary from a directory name** → read at least the `README` or `git remote -v`; a wrong guess is worse than `?`. Write `?` and fill it next time.
- **Turning the index into a knowledge base** → no architecture, deployment, secrets, accounts, internal addresses or customer names: this Manual is read into context over and over.
- **Relative paths** → always Worker label + path, or a remote URL; otherwise nobody knows which machine to look on.
- **Treating the remote as a place to work** → the remote is where clones come from, not an execution surface; confirm which Worker holds the clone before doing anything.
