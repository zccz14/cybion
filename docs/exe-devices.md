# Devices: a Worker or an eXe device

A Thread executes on a device the user picked. There are two kinds, and both
appear in the same list (`cybion_list_workers`, the 连接设备 page) with the same
`worker_id`:

| Kind | What runs there | Who holds the key |
| --- | --- | --- |
| `worker` | A paired Cybion Worker: one outbound connection, an SSE channel down and HTTP results up. | The Controller mints a device credential; the Worker holds nothing that matters. |
| `exe` | An [eXe](https://exe.ntnl.io) client. The Controller signs and seals each call and reads the sealed answer back through the eXe relay. | The device holds its own Ed25519 key — it is the device's address — and this account holds one too. |

## The account's eXe identity

Every Cybion account gets **one** Ed25519 key pair the first time an eXe
device is connected or the page is opened. It lives in the user's own database
(`exe_identity`) and is never returned by an API:

- the **public half is the address** (`base58(pub32)`, 43–44 characters) and is
  the only part a user sees;
- the **private half never leaves the Controller** and cannot be exported.
  Whoever holds it can sign calls to any device that trusts the address — that
  is the whole of the authorization an eXe device asks for, so custody matters:
  a compromised account is a compromised caller, exactly as a stolen browser key
  would be.

Calls are sealed to the device's address and opened with this key, so the relay
only ever moves ciphertext. The relay's own view is limited to `call_id`,
`caller`, `device`, sizes, timestamps and status.

## Connecting a device

Trust is configured on the device and nowhere else:

```sh
exe trust <the address shown on the 连接设备 page>   # on the device
```

Then paste the address the device prints (`exe status`) into **接入设备**. The
Controller records the address as an eXe device, asks the relay whether it is
registered and online, and from then on it is one more device in the list.

Because the trust list lives on the device, Cybion cannot grant itself access,
and removing a device here does not change what the device trusts.

## What runs on an eXe device

Exactly one verb: a shell. Cybion's `bash` arguments are mapped onto it
(`command`, `cwd`, `timeout_seconds`); the worker id and the call summary never
reach the device. `browser_control`, `computer_use` and `view_image` need a
Cybion Worker — on an eXe device they are refused before a call is queued.

The result is stored in the same shape a Worker returns —
`{exit_code, stdout, stderr}` — so a Thread, the audit page and an Ultimate
Machine read the same fields either way. A result larger than 64 KiB arrives as
an eXe attachment, which the Controller opens with the same key.

## How a call travels

1. `bash` is enqueued in `worker_calls` exactly like a Worker call, after the
   device is known to be online (otherwise the model is told, and nothing is
   queued).
2. The eXe driver (`exe::Driver`, every 2 s) claims the call, seals
   `{"name":"shell","args":…}` to the device address, signs the envelope and
   posts it to the relay.
3. The relay queues it; the device verifies the signature against its trust
   list, opens the seal and runs the command.
4. The device signs and seals its answer. The driver reads the relay, verifies
   the device's signature, opens the answer and settles the call through the
   same `settle_worker_call_result` the Worker result endpoint uses.

A call that never reaches the relay is retried for 60 s and then answered as a
failure the model can read; a call the relay lost or the device process
abandoned settles as `lost` with `execution_outcome: "unknown"` — the same
promise a Worker makes: **"I don't know" is a real answer.**

## Limits worth knowing

- **One identity per account.** Rotating it would invalidate every device's
  trust list; there is no rotation UI yet.
- **No sharing.** An eXe device cannot be granted to another user: the call
  would be signed by the owner's key, so the grant would be the owner acting.
- **No upgrade, no capability check, no browser.** Everything that needs
  something other than a shell needs a Cybion Worker.
- **Ultimate Machines work**, because they are just `bash` on a schedule.
- **Online means "the relay saw it recently".** The driver re-reads that state
  periodically; a device that goes quiet flips to offline within about a minute.
