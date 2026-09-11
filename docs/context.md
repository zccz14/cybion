# Thread context

Cybion builds an OpenAI Responses input from one thread's ordered durable
history only. Tenant and thread boundaries are always explicit:

```text
tenant SQLite database
  └── thread ID
        └── ordered user and assistant history
```

No record from another tenant or thread is eligible for the request. A Worker
tool loop continues through the Responses `previous_response_id` protocol for
that run; final assistant text is then appended to the same thread history.

The hosted service deliberately avoids shared-memory conversation caches and
cross-tenant context joins. A fresh process can reconstruct a thread from its
tenant-local database.
