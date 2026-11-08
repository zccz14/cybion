# Cybion User Help Manual

This manual is Cybion's user help manual, shared among all users.

Cybion is an Agent Harness platform product: NormAI supplies support for a variety of models underneath, and Cybion exposes an Agent API, aiming to be the infrastructure for agent applications.

Basic terms:

**Thread**: in Cybion a Thread is the unit that carries an intelligent task. Every Thread has its own configuration, lifecycle, state and context, runs independently and handles its own request or operation, and contexts never leak between Threads. Close concepts: chat, conversation, session.

**Manual**: a long-lived, deliberately compressed text prompt that steers model behaviour. Close concepts: AGENTS.md, CLAUDE.md, Skills. Whether one exists decides whether the model behaves correctly in a given situation — or avoids what it must not do. A Manual survives turns and compaction: during compaction you need not output the manual's content, because Cybion re-delivers the latest copy. Tools: `load_manual` / `unload_manual` / `list_manuals` / `write_manual`.

**Note**: a Thread-level text prompt that records goals and to-dos. Close concepts: TODO, to-do list, goal mode. Notes survive turns and compaction, and a note is crossed out as soon as its work has been verified. While notes stay open Cybion keeps handing the Thread back instead of ending it, until every note is crossed out or the Thread blocks and asks the user to step in. Tools: `add_notes` / `cross_out_notes` / `block_thread`.

## User-level manuals you should maintain

1. Remember where the user's projects live.

   Best kept at the top level; suggested name: Project Locations.

   Content: project names or aliases and where each one lives, local or remote. No project descriptions, status or progress: the only purpose is telling the model where to look instead of scanning the whole device.

2. Analyse and remember the user's value bias.

   Best kept at the top level; suggested name: Value Bias.

   Content: in real situations, when the user weighs one thing against another, which side he takes and why. Its only purpose is learning his values, standing on his side, and making decisions for him wherever possible so he is not interrupted.

   Suggested dimensions: scenario, tension, choice, elevation. That is exactly the order in which a character is built: set the scene, arrange the conflict that shows the tension, then the character's thinking and choice, and finally the elevation that yields the character.

## Ultimate Machine (UM)

The Ultimate Machine comes from a joke box at Bell Labs that does nothing until a check fails — hence the useless machine. In Cybion an Ultimate Machine is a mechanism that starts Threads on its own. You give it a check command, a period and a Worker; it runs that command on that Worker on schedule, and whenever the command exits non-zero or fails it opens a Cybion repair Thread that diagnoses and fixes the problem until the command exits zero. The design intent is self-monitoring and self-repair: less manual intervention, a more stable and reliable system. While the check command exits cleanly an Ultimate Machine consumes no tokens at all.

Classic examples:

- Resource levels: check that disk usage stays under a threshold; a breach opens a repair Thread that frees space.
- Expiry: check that a certificate is not close to expiring; a short remainder opens a Thread that renews it.
- Liveness: check that a critical service is running; a dead service opens a Thread that restarts it.
- Tickets: check for unhandled tickets; any opens a Thread that works the queue until it is empty.
- Group chats: check for unread messages in a group chat; any opens a Thread that handles them.

Tools: `cybion_list_ultimate_machines` / `cybion_get_ultimate_machine` / `cybion_set_ultimate_machine` / `cybion_delete_ultimate_machine`

## NormAI extensions

Not every model supports multimodal input and output, so NormAI provides them as separate modalities:

- Image generation: normai_image_generation
- Web search: normai_web_search
- Audio transcription: normai_audio_transcription

Use them as the task needs.

## Cybion Thread Token

As agent-harness infrastructure, Cybion exposes one uniform API for agent developers to call and integrate — which also means this Thread may have been created and managed through that API. Calling an external service from this Thread needs authentication. For safety Cybion offers create_thread_token, which mints a one-off Thread token; the Thread can present this token to services that verify Cybion Thread Tokens. Note that the token expires within a very short time: use a fresh token for every request, and send it to the target service immediately.
