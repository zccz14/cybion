# Interface performance

`#/route-performance` is the **Interface performance** page: what each API route
costs to answer, how often it fails, and which requests went slow. It is
administrator-only, because it covers every account's traffic (it never names a
caller, only routes).

This page shares the shape of [usage statistics](usage-statistics.md) — measure
off the request path, fold into buckets, read buckets — but the pressure is the
opposite. Usage statistics is deep and slow-moving; a route's latency is shallow
and needs to be current within seconds.

## What the request path pays

One middleware wraps every matched route. For each request it:

1. reads the matched path (for example `/api/threads/{id}`, never
   `/api/threads/8f2a…`) and the method;
2. takes one `Instant` before and one after the handler;
3. adds to the counters of the `(minute, route, method, status)` cell, creating
   that cell on first sight of the combination.

A cell is a `Cell` of atomics: a request count, a latency sum, a maximum, and one
counter per latency band. Nothing on this path opens a database, allocates a
row, or waits on a lock held by a writer; a request that has never been seen
registers one cell and thereafter only adds numbers.

A measurement is **time to response headers**. A streaming reply is recorded
when its head is ready, because streaming afterwards is not routing cost, and a
route that streams for a minute must not look like a route that takes a minute.

Routes are counted by their template, so the cardinality is the router's, not
the caller's. Static assets and unmatched paths carry no matched path and are
not recorded: this audit is about the interface, and a 404 for an unknown URL
says nothing about a route.

## How it reaches the shared database

A background task every five seconds drains every minute that has closed into
the **administrator database** (`~/.cybion/default.sqlite3`), where the traffic
counters already live:

- `route_perf_minute` — one row per minute, route, method and status;
- `route_perf_hour` — the same fold at hour granularity;
- `route_perf_slow` — the individual requests at or above one second.

The flush opens its own connection, writes one transaction, and closes. It is
never on a request's critical path, and the tables are additive: the flush adds
to a bucket, so a restart can only lose the seconds since the last pass, never
duplicate them.

The minute that is still running stays in memory. It is drained only after it
closed, which is what keeps a sample from being counted twice: a minute written
while open and again when it closed would be written twice.

Retention is bounded on purpose. Minute buckets are kept for six hours and hour
buckets for thirty days; both are pruned by the flush that has something to
write, and once at startup, so an idle process never opens a write transaction
to delete nothing. Slow samples keep the newest 500.

## What the page reads

`GET /api/route-performance?window=1h|6h|24h|7d` (administrator only) answers
from the buckets, and merges the minute still in memory into the same numbers:

- `1h` and `6h` read minute buckets, so a window is at most 360 rows per key;
- `24h` and `7d` read hour buckets.

Four aggregates come back: the totals, the per-route rows with their statuses,
the per-bucket series the two charts draw, and the slowest recent requests.
Every row carries its **cumulative time** (`total_us`, the sum of the samples)
next to its average, because the two answer different questions: the average
says whether a route is slow, the cumulative time says how much of the window
the route actually consumed. A route at 900 ms over 400 calls is the expensive
one, and only the cumulative column shows it.
Percentiles are computed from the band counters, so a read costs the number of
buckets and routes in the window — never the number of requests in history. The
connection is read-only, so a page can never be the reason a flush waits.

A percentile is the **upper bound of the band it lands in**:

| Band upper bound | 5 ms | 10 ms | 25 ms | 50 ms | 100 ms | 250 ms | 500 ms | 1 s | 2.5 s | 5 s | 30 s | beyond |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Index | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 |

Bands make a percentile approximate in exchange for a bounded cell. A reported
percentile is never optimistic, except in the open-ended last band, which has no
bound to report and falls back to the slowest request actually seen. Requests at
or above one second are also counted as slow, both per route and per bucket.

## What is counted, and what is not

The audit measures **inbound requests that matched a route**. That has three
consequences worth stating:

- **Cybion's own background work is not counted.** The supervisor loops (request
  recovery, statistics patrol, ultimate machines, eXe relay polling, cost
  reconciliation) run inside the process and call functions, not the HTTP
  interface. They produce no matched request, so they add no row.
- **Outbound calls are not counted.** Talk to an upstream gateway, Linkit,
  NormAI or the eXe relay leaves the process; this page never sees it. Outbound
  bytes are the traffic counters' business, not this audit's.
- **Device polling is counted.** A paired Worker polls the controller over HTTP
  (`/worker/v1/...`), and `eXe` devices and the browser poll too. That is real
  traffic on a real route, so it is measured like everything else — and it is
  reported rather than hidden: the totals card splits the window by source into
  browser and API keys (`/api/...`), the integration API (`/v1/...`) and device
  workers (`/worker/...`), so an operator can tell how much of the request count
  is polling before drawing conclusions about a route.

## What the page shows

| Section | Answers |
| --- | --- |
| Totals | How many requests, how many failed, how slow the window was, how much time it consumed, and which source asked |
| Requests | How the traffic moved across the window, with failing buckets in red |
| P95 latency | How the tail behaved across the same buckets |
| Routes | Per route and method: requests, cumulative time, 4xx, 5xx, slow, average, P50, P95, P99, max |
| Slowest requests | The slowest of the newest 500 requests at or above one second |

The page refreshes every ten seconds. Nothing is a snapshot that one has to ask
to be rebuilt: the buckets are written continuously, and the in-memory minute is
read at every poll.
