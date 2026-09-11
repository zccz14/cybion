# Cybion hosted service

Cybion is a hosted inference and execution service for users who want a
browser-managed thread, an integration API, and a personal-device Worker.

Users authenticate with Auth Mini using one access token whose audiences are
`cybion.ntnl.io`, `linkit.ntnl.io`, and `openai.ntnl.io`. Each service verifies
only its own audience. Users get isolated persistent threads and do not need to
configure an upstream OpenAI key: Cybion provisions a Consumer through the
existing OpenAI-LB API, so consumption and billing remain in the existing
OpenAI-LB account model. Completion and failure notifications use a user-owned
Linkit Bot and that same subject's private conversation.

The service is deployed at `cybion.ntnl.io` in Tokyo. Its deployment artifact is
a single Linux x86_64 Rust binary with the React web application embedded.
