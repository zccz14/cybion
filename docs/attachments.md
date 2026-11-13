# Attachments

The composer's `[+]` button is the one entry point for everything that is not
typed text. It opens a file picker and routes each file by what it actually is,
so a user never has to know which control accepts which file.

## Routing

| What was picked | Where it goes |
| --- | --- |
| An image (`png`, `jpeg`, `webp`, `gif`, anything the browser can decode) | The existing pasted-image path: downscaled to 2048 px, an `input_image` data URL, thumbnails in the composer and previews in history. |
| Audio (`audio/*`) | The existing voice path: an `input_audio` data URL, the object store, one provisional transcript, `normai_audio_transcription` for a better one. |
| Text (a `text/*` or document MIME type, or one of the extensions the composer knows: source, config, logs, CSV, JSON, Markdown — including `svg`, which is markup rather than a picture) | A **text attachment** described below. |
| Anything else (`pdf`, `docx`, `zip`, binaries…) | Refused, and named with its reason. Silent dropping is the one behaviour that must never happen here. |

`splitPickedFiles` owns the classification, and both composers — the packaged
Thread view and the new-thread page — call it through `useComposerAttach`, so
the rule lives in one place. Pasting still only picks up images.

## A text attachment is text

The Controller forwards `input_text`, `input_image` and `input_audio` parts, and
nothing else; there is no file part to send and no upstream that accepts one.
A text file therefore enters the message as text: the composer shows a chip with
its name, size and whether it was cut, and sending composes

````text
the typed text

附件：notes.md（2.0 KB）
```markdown
# content of the file
```
````

The heading names the file and its size in the console's language, and the fence
is one backtick longer than the longest run inside the file, so a file that
contains a fence cannot close its own block. An attachment-only message is
legitimate: the typed text may be empty.

History shows exactly that message, because that is what was sent. The draft
that clears on success is the typed text, not the composed one, so drafts keep
behaving as before.

## Limits

| Limit | Value | Why |
| --- | --- | --- |
| Files per message | 8 | A message carries a few attachments, not a directory. |
| Bytes per file | 2 MB | Larger files are refused instead of read into memory and cut. |
| Characters per attachment | 30 000 | One file cannot monopolise the context. |
| Characters of all attachments | 60 000 | Leaves room for the typed text under the Controller's 100 000-character input ceiling. |
| Smallest useful remainder | 1 000 characters | Below this a file is noise, so it is refused as "no room left". |

When a message reaches the Controller's ceiling the composer says so and keeps
the send button disabled, instead of letting the request come back as a 400.

## Not in this version

- **Binary documents**: `pdf`, `docx`, `xlsx` need extraction (a parser on the
  server, or a `files` field on the input record plus a text-extraction step)
  before a model can read them; today they are refused with a reason.
- **Bytes in the object store**: text attachments ride inside the message, so
  they are kept by the history record rather than `objects/`. A `files` field
  would move them there and let the browser fetch them on demand.
- **Drag and drop**, and dropping a text file onto the transcript to attach it.
- **Per-attachment hinting** (a note that applies to one file only).
