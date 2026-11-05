# Value Bias

Models are deliberately debiased in training, yet what a user actually wants is **his own** bias: given the same two options, he picks differently from everyone else, and to him the choice is obvious. Memory only tells you who the user is; value bias is what lets you decide for him when values collide.

You maintain this Manual on his behalf: **capture** what he chooses under a real trade-off, **record** it as an executable criterion, **apply** it first next time, and then give him the chance to overrule it.

## What counts as one entry

Only choices that cannot be derived from facts. Anything a rule, a document or a cost calculation can settle is not a value bias. Four shapes:

- **A trade-off**: fast vs correct, cheap vs stable, easy vs controllable, privacy vs convenience — what he picked and what he gave up.
- **A correction**: "no, not like that", "I don't look at that" — what was rejected is a class of approach, not one action.
- **Counter-intuitive tolerance**: he accepts a known cost ("ship it, I'll take the dirty data"). **Where his tolerance ends** carries more signal than the preference itself.
- **The unit of measure**: does he weigh things in money, in time, or in complexity; when the budget runs short, what does he cut first.

Not entries: one-off requests ("use Python this time"), environment facts ("I'm on macOS"), technical conventions that belong in the project's own docs.

## How to catch it (the hook)

Three moments surface on their own; when you see one, take it:

1. He made a trade-off → record "option A / option B / he chose / the cost".
2. He rejected your approach → record the **class** of approach, not that action.
3. The same tension shows up a second time and he chooses the same way → this one may graduate into a **general rule**.

When the tension is visible but he says nothing: **ask one question, not a survey** — and it must carry the cost:

- Good: "Two paths: A ships today but the dirty data gets cleaned next week; B takes two more days and ships clean. Which do you want?"
- Bad: "Do you care more about speed or quality?" — an abstract question earns an abstract answer.

At most one question per session. If he does not answer, take the cheapest path and say which one you took and why.

## What one entry looks like

`scenario | tension | what he chose | general rule | evidence`

```text
# Value Bias

> One entry per scenario: scenario | tension | what he chose | general rule | evidence

incident repair | fix it properly vs restore service first | restore first, fix afterwards | restore availability first on production incidents, root cause can wait | 2026-02-11 · Ultimate Machine disk check
communication | conclusion first vs derivation first | conclusion plus one piece of evidence | lead with the answer, put depth after it | 2026-02-02
```

- **scenario**: a coarse class (incident repair / code style / communication / spending), never a project name, or you will not match it on reuse.
- **tension**: two things that both make sense and only one of which can win.
- **what he chose**: what he actually picked, including the sacrifice.
- **general rule**: a criterion you can execute next time — imperative, decidable. If you cannot write it, this is still a preference: keep it as evidence, do not promote it yet.
- **evidence**: `YYYY-MM-DD` plus where it came from (Thread title or keyword), so it can be traced and overruled.

## How to use it

- On a recurring tension, **act by the recorded rule first**, and say so: "Following what you chose before (restore service first), I…" — that gives him the chance to overrule on the spot.
- Two rules conflict → follow the **more recent** one and explain why.
- A rule that gets overruled is **deleted**, not marked "obsolete". A Manual converges; it is not a ledger.
- Rules that keep conflicting mean the granularity is wrong: merge one level up.

## Guard rails

- **No persona**: this is not a personality profile. "He likes things simple" never goes in.
- **No fast promotion**: a class of tension needs at least two consistent choices before it becomes a general rule; one choice is only evidence.
- **No follow-up interrogation**: the hook exists to ask less. Anything a rule already covers needs no confirmation.
- **No sensitive content**: salary, health, address, accounts, customer lists stay out. Record the shape of the decision only.
- **One Manual is enough**: top level, suggested name `Value Bias`, around 60 lines; past that, add sections rather than child Manuals.
