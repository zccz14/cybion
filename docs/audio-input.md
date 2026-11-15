# Audio input

Voice is an input modality, not a one-shot transformation. A single
pre-model transcription freezes its own mistakes into the Thread: the first
pass mis-hears a product name, and every later turn reasons over the wrong
text with no way back. Audio therefore enters the Thread as an attachment in
the object store, and the transcript is a **derived artifact** the model can
re-derive with better hints.

## Shape

- **Composer**: the Thread input gains record (browser `MediaRecorder`) and
  upload. Both produce one audio attachment per `input_audio` part, capped at
  4 per input and 20 MiB of audio after base64 decoding.
- **Storage**: the bytes go through `objects::put` exactly like a pasted image
  (`docs/objects.md`), and the part keeps `audio_ref` + `media_type`
  (`audio/webm`, `audio/mp4`, `audio/mpeg`, `audio/wav`, `audio/ogg`,
  `audio/flac`, `audio/aac`). The browser records compressed audio
  (`audio/webm;codecs=opus`, ~32 kbps), so no server-side transcode is needed
  for the recording path; an oversized upload is rejected rather than
  transcoded.
- **Cold bytes, hot text**: `materialize_media` must **not** expand
  `audio_ref` into a base64 data URL. Images are materialized because the
  model reads pixels; the model never reads audio bytes. History projections
  keep the reference, the player fetches the bytes on demand
  (`GET /api/objects/{ref}?media_type=...`, audio types only), and only text
  enters the request.
- **Provisional transcript**: on ingest the Controller transcribes each
  attachment once with the effective model and appends an `input_text` part
  carrying the audio reference, the media type and the transcript, marked as a
  provisional machine transcript with a note that
  `normai_audio_transcription` can re-extract it. A failed first pass appends
  the same note without text, so the model still knows the audio exists and
  can retry through the tool.
- **Request projection**: `load_protocol_items` rewrites an `input_audio` part
  into the note above (never forwarding an `input_audio` part, which upstream
  Chat/Responses models reject). History surfaces keep the reference.

## Re-extraction

`normai_audio_transcription` is a controller-side native tool, assembled by
`responses_tools` next to `normai_web_search` and `normai_image_generation`:

```json
{ "audio_ref": "<sha256>", "prompt": "…", "keywords": ["CZON", "Rust Workers"],
  "language": "zh", "model": "gpt-4o-transcribe" }
→ { "status": "completed", "text": "…", "model": "…", "prompt_used": "…",
    "prompt_used": "…" }
```

- The Controller posts multipart to `{upstream}/audio/transcriptions` with the
  Thread's upstream key, so billing lands on the account's NormAI consumer.
  `x-normai-request-id` is returned for audit reconciliation.
- `keywords` fold into `prompt` for models without a native keyword field
  (`gpt-4o-transcribe` takes free-form `prompt`; `gpt-4o-transcribe-diarize`
  takes none). `prompt_used` echoes what was sent.
- Every call transcribes again: no result cache and no per-audio attempt cap in
  this version. Speech-to-text is cheap, and a cap would get in the way of a
  model that legitimately retries a span with different vocabulary hints.
- Client errors are answered to the model as `{ "error": … }`, never failing
  the turn — the same convention as the other native tools.

## Model configuration

`audio_transcription_model` exists at both levels, mirroring
`image_generation_model`:

| Level | Column |
| --- | --- |
| Account default | `thread_defaults.audio_transcription_model` |
| Thread override | `threads.audio_transcription_model` |

Both columns are nullable and **default to null**: audio input ships off,
because an account is not guaranteed to have any speech-to-text model on
NormAI — the model has to exist first. The thread override wins; null there
follows the account default; null at both levels keeps audio input disabled
and the composer's record/upload controls disabled with a hint pointing at the
picker. The options mirror the image picker: `GET {upstream}/models?kind=sst`
lists the callable speech-to-text models, and an empty list means the account
must add `sst` rows to an upstream before voice input can be switched on.

## Staging

1. **Backend**: schema + settings, ingest (`audios` on both input endpoints),
   object storage, provisional transcript, the tool and its cache, the object
   read endpoint, and docs. Verifiable over the API before any UI exists.
2. **Composer**: record/upload controls, attachment chips, the in-Thread
   player, and the two model pickers.

## Console

- The composer owns the recording and upload controls; each attachment shows as
  a size chip and can be removed before sending. The input reaches the server as
  `audios` data URLs next to `images`.
- Every step of the voice path is visible, because a silent button cannot be
  told apart from a broken one: the mic shows `starting` while the browser asks
  for permission, `recording` with a running clock, and `finalizing` while the
  take is closed and encoded. Every failure — refused permission, no device, a
  microphone another app holds, an empty take, a clip over the 20 MB ceiling, a
  device pulled mid-recording — is stated in the composer notice with a dismiss
  control, never swallowed.
- A finished take is parked as an attachment before it is sent, so a failed
  request leaves the clip on the composer and the retry button resends it. A
  voice-only message (no typed text) is a valid input: the client must not treat
  empty text as an empty message.
- **The clip outlives the page.** Explaining a failure is not enough when the
  speech is gone: every take is written to a local draft (IndexedDB, one slot per
  user and Thread, keyed like the text draft) the moment it exists. A failed
  send, a refresh, a closed tab or a collapsed extension panel therefore leaves
  the audio recoverable — reopening the composer restores the clips as
  attachments and says how many came back, with a retry that sends them right
  away. The slot is deleted only after the Controller acks the input.
- Transient failures are retried without the user's help: a network error or a
  502/503/504 gets three attempts with a widening delay, and a composer that is
  offline pauses the request until the browser is back rather than failing it.
  Client errors (400-class) are not retried — the message itself is wrong.
- A sent voice clip renders as a playable bar with the first-pass transcript
  underneath as its subtitle, so the words are readable without pressing play;
  the transcript is never drawn as a message of its own. A clip replayed from
  history whose first pass failed says "no transcript" in place of the subtitle
  and points at re-extraction, so it cannot look like a clip that never arrived.
- A `normai_audio_transcription` call renders as its own card (model, prompt,
  keywords and the reference it re-read; the payload disclosure keeps the rest).
- The speech-to-text model is picked in the settings card (account default) and
  in the Thread settings popover (override). With no model configured the audio
  input stays off and the first attachment is refused with a pointer to
  `models?kind=sst`.

## Not in this version

- **Span re-transcription** (`start`/`end`, needed for an hour-long meeting
  and for going past the upstream's 25 MiB limit) requires server-side audio
  decoding; it lands with ffmpeg-backed slicing.
- **In-Thread playback**: the bytes are already served by
  `GET /api/objects/{ref}?media_type=…`, but the conversation shows the
  provisional transcript as text without an `<audio>` control yet.
- **Diarization** (`gpt-4o-transcribe-diarize`, which takes no prompt) and
  speaker labels.
- **Spend guardrails**: no result cache, no per-turn ceiling, no attempt cap.
  Speech-to-text is cheap enough that a repeated extraction is acceptable
  behaviour rather than a runaway.
- Retention: audio follows its Thread today, and — like images — object bytes
  are not reclaimed when a Thread is deleted. Any PII retention policy must
  cover `objects/` and the transcription cache.
