# Cybion User Help Manual

This is Cybion's built-in operating guide: compiled into the binary from the Cybion source tree (`common-manuals/` in the repository) and shared by every user, read-only. The controller does not store it or change it at runtime — content changes ship with releases, and the source is public, so its revision history can be reviewed.

It is product knowledge, not the current user's data. Read what you need when you (the AI) need guidance on getting things done with Cybion's own features; you do not have to read it all at once.

Priority: engine behavior and tool contracts follow the tool descriptions each request carries; this manual offers usage patterns, recipes and pitfalls. When the two conflict, follow the tool descriptions and actual behavior.

One manual, no child nodes: the Ultimate Machine, Linkit, loaded Manuals, the two standing user Manuals (project index, value bias) and the user-manual format all live here.

## Ultimate Machine

One Ultimate Machine = one Worker + one bash check command + one interval. It runs on schedule: exit 0 keeps it silent; on failure it delivers a repair request to its bound repair Thread (titled "Ultimate Machine · <name>"). The name borrows Bell Labs' joke box — the machine whose only function is to switch itself off: it does nothing at all until a check fails.

- Schedule: the first run starts at creation; afterwards each run starts one interval after the previous run settled (a slow command stretches the real period), with at most one run in flight per machine.
- Failure: exit ≠ 0 (or the command was killed) → the repair Thread receives the command, the exit code, the tail of the output (~1500 characters), the intent and the criterion "make that command return 0".
- Offline: if the Worker is offline or gone at run time → skip this run, alert once through Linkit, and resume automatically afterwards (one alert per event).
- Lost: a run that has not settled after 15 minutes → declared lost, alerted once, retried on the next interval.
- Dropped message: while the repair Thread is mid-turn, a new failure is dropped rather than queued; so silence means neither health nor a broken machine.
- Immediate recheck: once a repair Thread turn ends successfully, the machine checks again right away; if that turn ended failed, it waits for the interval.
- Pause: `enabled=false` stops scheduled runs and offline alerts and cancels everything in flight — the machine's unsettled run and the repair Thread's current turn.
- Delete: removes the machine for good; the repair Thread and its history stay as an ordinary Thread. Deleting the repair Thread or the Worker it runs on deletes the machine too; moving it to another Worker restarts the offline-alert episode.

Worth scheduling: conditions that persist and can be judged automatically — resource levels (partitions, disks, inodes, memory and swap), expiry (certificate days left, backup window, quota), service liveness (port connectable, systemd unit active, key process present), data freshness (last-success timestamp inside a window), consistency (key files present and non-empty, checksums match).
Not worth it: one-off or judgment-requiring work, high-frequency polling (the floor is 10 seconds), expecting the machine to fix things (it only notices; repair happens in the Thread), checks whose output may contain secrets, tokens or private data.

Writing the command: the exit code is the semantics (0 = healthy and silent, non-zero = failure with the stderr/stdout tail sent into the Thread, so let the failure speak for itself); read-only and idempotent; cheap (one 300-second cap per run, and a timeout kill counts as failure); write for a non-interactive shell with explicit paths and no assumptions about PATH, locale or timezone; report the expected value next to the actual one so the fixer does not have to scout twice.

```text
test $(df -Pk / | awk 'NR==2 {print $5}' | tr -d %) -lt 90
openssl x509 -checkend 604800 -noout -in /etc/ssl/certs/server.pem
find /backups -maxdepth 1 -type f -mmin -1440 | grep -q .
```

Dry-run first: run the same command with bash on the target Worker, confirm it exits 0 when healthy, then break something on purpose and check that the output reads well.

Management tools: `cybion_list_ultimate_machines` for the overview and ids (including enabled, last_run_at, last_exit); `cybion_get_ultimate_machine` for one definition and its latest result (last_exit: 0 = healthy, any other number = that exit code, -1 when a killed command left none, null = no settled result yet or lost); `cybion_set_ultimate_machine` to create (name / worker_id / command / interval_seconds 10–2592000 required, intent optional; only Workers you own) or to update partially (send only the fields you change; an empty intent clears it; a new Worker restarts the offline-alert episode; renaming retitles the repair Thread; `enabled` is update-only); `cybion_delete_ultimate_machine` to delete — pause when you only want quiet, and delete only when the user asked for it.

Repair flow: get the definition and latest result → decide whether the environment is broken (fix it with bash on that Worker) or the check itself is wrong (validate the corrected command, then set the new definition; if the tool is unavailable, ask the user to edit it on the page) → run it until it exits 0 → once this turn ends successfully the machine rechecks immediately, so do not wait for the timer → never weaken a check just to turn it green → no reply is needed. Failure output lands in the Thread history, so never echo secrets; print a boolean instead. Machines are the user's assets: create or change them only on request or for a repair, and state the plan before any batch action.

## Linkit (notifications and reach)

Linkit (linkit.ntnl.io) is the community and reach product of the NTNL ecosystem. Every Cybion user inherently has a Linkit identity through Auth Mini; the connection and its credentials exist only on the controller side and never pass through you or a Worker.

- Identity and preferences: dark mode, language preference and the sharing picker's candidates all come from Linkit, handled by the web client and the controller; you neither need to nor can operate them.
- Notifications: when inference completes or fails terminally, the controller delivers the result to Linkit through the user ↔ Cybion Bot direct message; the Ultimate Machine's offline/lost alerts use the same channel, one alert per event. The switch defaults to off and is user-controlled; cancelled or superseded requests and successful compactions are not notified; a receipt means stored in Linkit, not read.
- No `linkit_*` tools (a design decision; do not reintroduce them): never promise "I will notify someone on Linkit"; if the user asks to send to a conversation, say plainly that it is not supported. Just state your conclusions — the controller composes the notification body from the Thread.
- Future (not yet live): task requests initiated from Linkit may arrive as Thread inputs; treat them as ordinary user input.

## Loaded Manuals

When a Manual must stay usable across turns and compactions, bind it with `load_manual`: the controller carries its current copy in every request and re-delivers it after an edit or a compaction, so no further call is needed. Release it with `unload_manual`; the copy already in the conversation retires with the next compaction.

## The two standing user Manuals (the hooks)

Cybion expects every user to keep two user Manuals alive: the **project index** (where a project is and what it is) and **value bias** (how he chooses when values collide). They do not grow out of the user's own diligence — they grow while you work: add an index block when a location appears or changes, record a bias block when a real trade-off shows up. Create either one when needed (one sentence to the user is enough); a Manual the user deleted is not recreated. The index records facts, value bias records criteria; they never share one Manual.

## Project Index

A user's projects sit in different directories across several Workers, and some exist only as a remote repository or a domain. The project index records "where it is + what it is", one block per project: it does not explain projects, it routes — one block tells you which Worker and directory to open, or which remote to clone.

When to touch it, only when a location appears or changes: created or cloned → add a block; moved to another Worker, new path, new remote → edit that block; archived or deleted → drop that block; found it wrong while working (`cd` lands somewhere empty, the directory was renamed, the remote 404s) → the disk wins: fix it on the spot and tell the user in one sentence. Never periodic sweeps, never scanning `~/Projects` to "refresh the index", no "last verified" field — upkeep has to cost nearly nothing.

Three fields, `project / location / summary`:

```text
# Project Index

> One project per block, three fields: project / location / summary. Location is "Worker label:path" or a remote repository URL; routing only, no status or progress.

project: Cybion
location: MacMini:~/Projects/cybion · github.com/zccz14/cybion
summary: The Cybion controller and web frontend in one repo; Rust service plus TypeScript frontend, artifacts ship with tags
```

- project: whatever the user calls it; never invent an alias.
- location: `Worker label:path` (the label as returned by `cybion_list_workers`, so a block maps straight onto a `worker_id`), the remote repository URL, the public URL, joined by ` · `; several clones across Workers get written one by one.
- summary: what it is and who it exists for, plus how to get in (entry scripts, where the data file lives, page routes) — that is routing too. Still no status, progress, TODOs, secrets or accounts.

Creating and editing: start with `list_manuals` — if the user already has a Manual of the same kind ("Project Index" or "项目索引"), reuse it and follow its fields; do not create a second one and do not rewrite it into this page's fields. Otherwise create it at the top level with `write_manual` the first time there is something to record, tell the user in one sentence, suggested name `Project Index`. Edit only that block; blocks the user wrote are authoritative — ask before changing them. Do not recreate a Manual the user deleted.

Pitfalls: guessing the summary from a directory name (read at least the `README` or `git remote -v`, write `?` when unsure); turning the index into a knowledge base (architecture detail, deployment steps, secrets, accounts, internal addresses, customer names stay out); relative paths; treating the remote as a place to work (the remote is where clones come from — confirm which Worker holds the clone first).

## Value Bias

Models are deliberately debiased in training, yet what a user actually wants is **his own** bias: given the same two options he picks differently from everyone else, and to him the choice is obvious. Memory only tells you who the user is; value bias is what lets you decide for him when values collide. You maintain this Manual on his behalf: capture what he chooses under a real trade-off, record it as an executable criterion, apply it first next time, then give him the chance to overrule it.

What counts as one entry — only choices that cannot be derived from facts, in four shapes: a trade-off (fast vs correct, cheap vs stable, easy vs controllable, privacy vs convenience — what he picked and what he gave up); a correction ("no, not like that" — what was rejected is a class of approach, not one action); counter-intuitive tolerance (he accepts a known cost; where his tolerance ends carries more signal than the preference itself); the unit of measure (does he weigh things in money, time or complexity, and what does he cut first when the budget runs short). Not entries: one-off requests, environment facts, technical conventions that belong in the project's own docs.

How to catch it — three moments: he made a trade-off → record "option A / option B / what he chose / the cost"; he rejected your approach → record the class of approach; the same tension shows up a second time and he chooses the same way → write it as a more general criterion. When the tension is visible but he says nothing, ask one question, not a survey, and make it carry the cost ("A ships today but the dirty data gets cleaned next week; B takes two more days and ships clean"); at most one question per session, and if he does not answer, take the cheapest path and say which one you took.

Four fields, `scenario / tension / choice / evidence`; `evidence` is a list, each item dated and sourced (his own words first), the items starting one blank line after `evidence:`:

```text
# Value Bias

> One scenario per block, four fields: scenario / tension / choice / evidence. Evidence is a list, each item dated and sourced; one blank line between blocks.

scenario: incident repair
tension: fix it properly vs restore service first
choice: restore service first — restore availability on production incidents, root cause can wait
evidence:

- 2026-02-11 · Ultimate Machine disk check
```

- scenario: a coarse class (incident repair / code style / communication / spending), never a project name, or you will not match it on reuse.
- tension: two things that both make sense and only one of which can win.
- choice: the side he actually picked, followed directly by an executable criterion; if you cannot write the criterion it is still a preference — keep the evidence and do not promote it.
- evidence: `YYYY-MM-DD` plus where it came from (Thread title, keyword, or his words); a choice seen only once gets "only once, awaiting a second confirmation" and is not used as a general rule.

How to use it: on a recurring tension, act by the recorded block first and say so ("Following what you chose before, I…") — that gives him the chance to overrule on the spot; two blocks conflict → follow the more recent one and explain why; a block that gets overruled is deleted, never marked "obsolete"; blocks that keep conflicting mean the granularity is wrong — merge one level up.

Guard rails: no persona ("he likes things simple" never goes in); no fast promotion (a choice seen once stays in evidence until a second consistent choice arrives); no follow-up interrogation (anything a block already covers needs no confirmation); no sensitive content (salary, health, address, accounts, customer lists stay out — record the shape of the decision only); one Manual is enough — top level, suggested name `Value Bias`, around 60 lines, and past that merge scenarios rather than adding child Manuals.

## Manual Format

A user Manual is **context** that models reread and edit mechanically, not an essay for a human: with the wrong format every update becomes a rewrite, and every rewrite drifts. This page is the default format; a local Manual of the same name wins when the user has one.

One entry per block, one blank line between blocks; field names end with a half-width colon, order fixed and declared on the `>` line at the top of the Manual. Hard rules:

1. One entry per block, fixed field order, field names ending with a half-width `:`.
2. No tables, no `|` separators, no nesting, no sub-headings; one blank line between blocks.
3. In a list field (such as `evidence:`), start the items on their own paragraph — a blank line after `field:`, then `- ` — or Markdown will not render them as a list.
4. Dates are always `YYYY-MM-DD`.
5. Only decidable criteria and facts — no backstory, no persona.
6. Edit, do not rewrite: append a block, or change exactly that one block; ask the user before restructuring the whole Manual (new fields, new sections, bulk deletes).
7. A block that gets overruled is deleted, never marked "obsolete" — leftovers keep getting read into context.
8. Converge: more than three entries of the same kind merge into one more general entry; keep the whole Manual near 60 lines.

The `>` line is both the human contract and yours: it declares the fields and their order. Change it before you change the fields; when the two disagree, the `>` line wins and the entries get fixed to match.

Division of work: a Note holds this turn's goals and TODOs, crossed out when done; a Manual holds criteria that must survive turns and compaction (in this format); an Archive is append-only history, never revised. When to create one: only when the hook actually fires — never pre-create empty Manuals; say one sentence when you create one (it can be edited and deleted); do not recreate a Manual the user deleted.
