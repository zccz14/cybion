# First-use guidance

Cybion's onboarding teaches three separate concepts:

- A **conversation (Thread)** keeps the messages and execution history for one task.
- A **Context** is a lightweight reference: the source's purpose, location and
  reading instructions. Original files, books and project folders stay on Worker
  devices or network services. The model discovers references and
  accesses sources as the task requires; registration does not preload everything
  into every conversation.
- A **Worker** connects a particular device for file access and execution. It is
  optional for normal conversation, which still requires a working model service.
  Existing pairing consent and execution-permission disclosures remain in place.

The Context editor still stores the existing `name`, `description`, `content` and
`parent_id` fields. This change guides users to store references rather than a
copy of the original material. It does not migrate existing content, add file
uploads, index source files or change the model's tool protocol. Material read
for a task may appear in its conversation history; the help explicitly distinguishes
that from hosting the original library.

## Entry and recovery

`/#/help` is a normal, bilingual route available without a successful model
connection. Contextual, keyboard-operable help dialogs use the same copy as that
page. No forced tour, onboarding-complete flag or sample records are created.

On narrow screens the default view is still a conversation list. A confirmed
empty workspace opens the existing composer instead. A separate unfiltered
`GET /api/threads?limit=1` checks the total only when the unsearched Web/All view
and the archived list have both reported zero. API-only workspaces, search/status
filters, archived conversations and unknown totals must not be mistaken for first
use. Background polling keeps the last observed totals rather than temporarily
removing the composer while a request is in flight. Counts only select a view;
no data or permissions are changed by this decision.

Examples fill an empty draft. Context examples fill an editable form and require
an explicit save. “Use in a conversation” uses the saved reference ID/name and
the existing empty-only draft seeding mechanism. An existing draft is never
overwritten. None of these actions automatically sends a message or runs a tool.

Model initialization uses the existing session-scoped NormAI query. Its error is
visible with manual retry and a settings link, without treating catalog discovery,
Worker pairing or an optional integration as a prerequisite for a configured model.
A rejected first-message submission retains the draft and exposes recovery actions.
Connection status is not a claim that a provider has sufficient quota or that an
inference request has already succeeded.

## Verification

Unit tests cover empty-workspace eligibility, unfiltered count wiring, complete
Chinese/English copy, reference examples, saved-reference handoff and recovery.
The onboarding Playwright suite loads the actual application entry point, verifies
a test-only signed Auth Mini token against an intercepted JWKS, and intercepts all
remote services. It covers first use, returning/filtered/unknown states, source
references, unchanged drafts, explicit sending, model failure,
light/dark palettes and narrow screens. No real account, provider charge or device
authorization is created by those tests.

New production branches are limited to confirmed first use, an empty draft,
context examples/saved references and model initialization errors. These reflect
user-visible states, not compatibility paths. There are no new dependencies,
backend endpoints or database migrations.
