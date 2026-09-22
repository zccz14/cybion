# Cybion hosted service

Cybion is a hosted inference and execution service for users who want a
browser-managed thread, an integration API, and a personal-device Worker.

Users authenticate with Auth Mini using one access token whose audiences are
`cybion.ntnl.io`, `linkit.ntnl.io`, and `openai.ntnl.io`. Each service verifies
only its own audience. The Configuration page stores a per-user `base_url` and
`api_key` for an OpenAI Responses-compatible provider. Cybion sends each model
request to `{base_url}/responses`; the key stays in the user's SQLite database
and is never returned to the browser. Existing OpenAI-LB credentials remain
supported for users who have not migrated. Optional completion and failure
notifications use a user-owned Linkit Bot and that same subject's private
conversation. Notification setup and delivery are independent of model
inference.

The service is deployed at `cybion.ntnl.io` in Tokyo. Its deployment artifact is
a single Linux x86_64 Rust binary with the React web application embedded.
