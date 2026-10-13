# Cybion Common Context

This is Cybion's built-in operating guide, compiled into the binary from the Cybion source tree (`common-contexts/` in the repository) and shared by every user, read-only. The controller does not store it or change it at runtime — content changes ship with releases, and the source is public, so its revision history can be reviewed.

Read it level by level when you (the AI) need guidance on how to get things done with Cybion's own features; you do not have to read everything at once, and you should not treat it as the current user's data — it is product knowledge.

Priority: engine behavior and tool contracts follow the tool descriptions carried by each request; this tree offers usage patterns, recipes, and pitfalls. When the two conflict, follow the tool descriptions and actual behavior.

Current topics:

- **Ultimate Machine**: a silent watchman that runs one check command on a Worker on schedule and asks its bound Thread to repair failures; otherwise it stays quiet.
- **Linkit**: Linkit's relation to Cybion (identity, notifications, and reach), and why there are no linkit_* tools on the model side.
