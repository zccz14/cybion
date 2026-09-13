# Responses/Codex parity

The pinned comparison target is `openai/codex` commit `a592c38c16cdd7623dacc9168926ebccedfb67d3`.
The parser recognizes every event value handled by `codex-api/src/sse/responses.rs`:

```text
response.created
response.output_item.added
response.output_item.done
response.output_text.delta
response.output_text.done
response.custom_tool_call_input.delta
response.custom_tool_call_input.done
response.function_call_arguments.delta
response.function_call_arguments.done
response.reasoning_summary_part.added
response.reasoning_summary_part.done
response.reasoning_summary_text.delta
response.reasoning_summary_text.done
response.reasoning_text.delta
response.content_part.added
response.content_part.done
response.in_progress
response.metadata
codex.response.metadata
responsesapi.websocket_timing
response.new_tool_event
response.refusal.delta
response.mcp_call_arguments.delta
response.completed
response.failed
response.incomplete
error
```

`response.metadata` is processed before ordinary dispatch for model routing,
verification recommendations, moderation metadata, safety buffering and turn
state. `response.failed`, `response.incomplete`, and `error` retain Codex's
context, quota, usage, policy, overload, rate-limit and retryable categories.
Unknown event values remain forward-compatible and are consumed without
terminating the stream.

`src/responses/items.rs` models the Codex output item enum with field-level
Rust types. Function and custom tool arguments remain strings on the wire and
are parsed only at the Worker boundary. Unknown fields are retained in a
flattened extension map. `ResponseState` consumes semantic events while the
stream is open, records completed items immediately, snapshots in-progress
items, and dispatches Worker tools at `output_item.done`.

codex.rate_limits
