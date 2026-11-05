# Cybion Common Manual

This is Cybion's built-in operating guide, compiled into the binary from the Cybion source tree (`common-manuals/` in the repository) and shared by every user, read-only. The controller does not store it or change it at runtime — content changes ship with releases, and the source is public, so its revision history can be reviewed.

Read it level by level when you (the AI) need guidance on how to get things done with Cybion's own features; you do not have to read everything at once, and you should not treat it as the current user's data — it is product knowledge.

Priority: engine behavior and tool contracts follow the tool descriptions carried by each request; this tree offers usage patterns, recipes, and pitfalls. When the two conflict, follow the tool descriptions and actual behavior.

## Two hooks

Cybion expects every user to keep two user Manuals alive: the **project index** (where a project is and what it is) and **value bias** (how he chooses when values collide). They do not grow out of the user's own diligence — they grow while you work: add an index block when a location appears or changes, record a bias block when a real trade-off shows up. Create either one when needed (one sentence to the user is enough); a Manual the user deleted is not recreated. Writing rules and format live in the matching nodes.

Current topics:

- **Ultimate Machine**: a silent watchman that runs one check command on a Worker on schedule and asks its bound Thread to repair failures; otherwise it stays quiet.
- **Linkit**: Linkit's relation to Cybion (identity, notifications, and reach), and why there are no linkit_* tools on the model side.
- **Loaded Manuals**: when a Manual must stay usable across turns and compactions, bind it with `load_manual` — the controller carries its current copy in every request and re-delivers it after an edit or a compaction with no further call; release it with `unload_manual`, and the copy retires with the next checkpoint.
- **Project Index**: the user's projects as navigation blocks of project / location / summary — routing only, no status.
- **Value Bias**: capture what the user chose under a real trade-off as an executable criterion; apply it first next time and let him overrule it.
- **Manual Format**: the default layout of these agent-maintained user Manuals — one block per entry, field names ending with a colon, a blank line between blocks, converge near 60 lines; a local Manual of the same name wins when the user has one.
