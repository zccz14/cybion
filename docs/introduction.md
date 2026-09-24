# Cybion hosted service

Cybion is a hosted inference and execution service for users who want a
browser-managed thread, an integration API, and a personal-device Worker.

Users authenticate with Auth Mini using one access token whose audiences are
`cybion.ntnl.io`, `linkit.ntnl.io`, and `openai.ntnl.io`. Each service verifies
only its own audience. The Configuration page manages named upstreams for
OpenAI Responses-compatible providers, each with a per-user `base_url` and
`api_key`. Cybion sends each model request to the selected upstream's
`{base_url}/responses` and reads every provider's model catalog from
`{base_url}/models`; keys stay in the user's SQLite database and are never
returned to the browser. The model pickers group the catalogs by upstream name,
and upgrading an older database converts its single legacy configuration
(explicit key or OpenAI-LB consumer credential) into one upstream. Optional
completion and failure notifications use a user-owned Linkit Bot and that same
subject's private conversation. Notification setup and delivery are independent
of model inference.

The service is deployed at `cybion.ntnl.io` in Tokyo. Its deployment artifact is
a single Linux x86_64 Rust binary with the React web application embedded.
