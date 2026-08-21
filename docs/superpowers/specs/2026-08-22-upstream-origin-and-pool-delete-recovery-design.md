# AIHub Upstream Origin and Pool Delete Recovery Design

## Goal

Make the AIHub upstream origin configurable from the authenticated router
console, and make managed pool-key deletion resilient to transient upstream
failures. The current service can already use a different `baseUrl` when it is
edited in `config.json`; this change makes that workflow explicit, validates
the value safely, and records the restart boundary. It also prevents one failed
pool deletion from blocking unrelated cleanup and preserves enough metadata to
retry without storing another secret.

The public router origin (`publicOrigin`) and the AIHub upstream origin
(`baseUrl`) remain separate settings. Changing the upstream origin never
changes the public URL used by browser clients.

## Configuration Contract

`baseUrl` is a canonical origin, not an arbitrary URL:

```json
{
  "baseUrl": "https://aihub.dog"
}
```

Validation rules:

- non-loopback origins must use `https:`;
- the value must contain only scheme, host, and an optional port;
- credentials, paths, query strings, fragments, and trailing path segments are
  rejected;
- a single trailing slash may be accepted and normalized away;
- `http:` is accepted only for exact loopback hosts (`127.0.0.1`, `::1`, or
  `localhost`) so tests and local development can continue to use mock AIHub
  servers;
- no wildcard, alternate origin list, or implicit redirect following is added.

The default remains `https://aihub.top`. `https://aihub.dog` is a valid origin
and is verified during deployment. The client continues to append the existing
`/api/v1/...` and `/v1/...` paths to this canonical origin.

## Restart Boundary and Data Flow

The AIHub client, route daemon, and model proxy are constructed at process
startup. Upstream-origin changes therefore take effect only after a controlled
restart; the implementation must not mutate one dependency while leaving
another on the old origin.

`POST /ctl/config` accepts `baseUrl` together with the existing hot settings.
It validates a complete candidate configuration and persists it atomically. If
the candidate origin differs from the active origin:

1. keep the active in-memory client and proxy dependencies unchanged;
2. retain a sanitized pending configuration snapshot so later hot-setting
   saves do not discard the new origin;
3. return `restartRequired: true` and the pending origin;
4. do not run an extra daemon decision using mixed old/new settings.

The existing restart endpoint remains explicit and protected by traffic and
account-mutation guards. On restart, startup loads the persisted candidate and
constructs every upstream-dependent component from the same origin. A rejected
restart leaves the pending configuration intact and keeps the current service
running.

`/ctl/status` exposes only non-secret origin metadata:

```json
{
  "config": {
    "baseUrl": "https://aihub.top",
    "pendingBaseUrl": "https://aihub.dog",
    "restartRequired": true
  }
}
```

`pendingBaseUrl` is null/omitted when there is no pending restart. No access
token, password, proxy credential, or upstream response body is included.

## Console Workflow

Add an `AIHub 源头域名` row in the existing settings view, close to the current
connection information. It contains:

- a URL input populated with the active origin or pending candidate;
- a save action;
- a compact status showing `当前生效` or `保存后需重启`;
- the existing restart action for applying the pending value.

Saving a valid changed origin does not restart automatically and does not
interrupt traffic. The page preserves the value and explains that the restart
button is required. The restart button continues to show the existing busy
error when active streams or account mutations make a restart unsafe. Invalid
values use the existing control-error path and leave the previous saved
configuration untouched.

## Pool Delete Recovery

### State

Extend `AppState` with a persisted `pendingPoolDeletes` map keyed by remote
`keyId`. New entries contain only non-secret metadata:

```text
pendingPoolDeletes[keyId] = {
  keyId,
  groupId,
  accountIdentity,
  attempts,
  nextRetryAt,
  queuedAt,
  lastErrorCode
}
```

`sk` is never copied into this map. Missing fields in old state files default
to an empty map. `lastErrorCode` is a bounded category such as `network`,
`timeout`, `rate_limited`, `unauthorized`, or `upstream`; raw error messages
and URLs are not persisted or rendered.

### Eviction and retry algorithm

For each LRU or forced-reclaim victim:

1. re-check hard/soft protection as today;
2. attempt the remote delete with the existing authenticated retry path;
3. on success, or an explicit remote `404/410`/not-found response, remove the
   local pool entry and invoke the existing affinity cleanup semantics;
4. on any other failure, remove the Key from the usable local pool, enqueue its
   `keyId` and owner metadata in `pendingPoolDeletes`, apply the same local
   affinity cleanup decision (forced victims clear affinity; ordinary LRU
   victims retain the existing rebuild-on-demand mapping), and continue with
   the remaining victims;
5. persist state whenever either a successful removal or a queue update occurs.

Pending entries are retried by the serialized pool-mutation queue during
startup reconciliation and subsequent daemon cleanup rounds. Only entries
whose `accountIdentity` matches the currently authenticated account are
attempted. Entries from another account remain retained until that account is
active again; a new account token is never used against an old account's Key.
Retries process at most eight due entries per cleanup round and use exponential
backoff of five seconds, doubling per attempt, capped at one hour. The attempt
counter saturates at 31 rather than causing overflow; entries are never silently
dropped. This prevents a persistent provider outage from monopolizing the
control loop. A failed retry updates the attempt count, category, and next
retry time, then the loop continues to other entries. A successful or
idempotent-not-found retry removes the pending entry.

Account logout/switch cleanup detaches all local pool entries, attempts their
remote deletion, and queues failures under the previous account identity. The
existing `orphanedKeyIds` response remains for compatibility, but queued IDs
are now durable and observable. Exit cleanup follows the same rules and
persists failures before process termination.

### Status and observability

`/ctl/status` adds aggregate cleanup information without exposing secrets:

```json
{
  "poolCleanup": {
    "pending": 2,
    "due": 1,
    "currentAccountPending": 1
  }
}
```

The UI shows a compact pending-cleanup count and a non-sensitive retry state.
Logs identify the group/key ID and failure category only. One failed deletion
does not suppress later deletions, and ordinary routing never selects a Key
that has already been detached into the pending queue.

## Error Handling and Security

- Configuration validation failures return HTTP 400 and do not write a partial
  file.
- A changed upstream origin returns HTTP 200 with `restartRequired: true`; it
  is not treated as an upstream connectivity failure.
- Restart conflicts retain the pending origin and return the existing 409
  categories.
- Delete `404/410` and a documented not-found API code are idempotent success;
  authentication, timeout, network, rate-limit, and other upstream failures
  are retried with category-only diagnostics.
- Unknown remote managed-looking Keys are never discovered and deleted merely
  because they share the prefix; only locally recorded IDs are eligible.
- No new endpoint accepts arbitrary Key IDs for deletion.

## Tests

Configuration and control tests will cover:

- valid HTTPS origins and loopback HTTP mocks;
- rejection of HTTP public origins, paths, queries, fragments, credentials,
  and malformed URLs;
- `/ctl/config` persistence, pending restart metadata, preservation across a
  later hot-setting save, and no mixed-origin daemon round;
- status/UI rendering of active and pending origins;
- restart application of the persisted origin in a startup/integration test.

Pool tests will cover:

- a failed first victim does not prevent later victims from being deleted;
- failed deletion detaches the Key from usable pool state and persists a
  non-secret pending entry;
- due retries use backoff, continue after another failure, and eventually
  remove the queue entry on success;
- `404/410` is treated as idempotent success;
- account-switch failures retain the old owner and are not retried with the
  new account, but are retried when the old account is active again;
- restart/reconcile restores pending deletion state;
- cleanup status contains counts only and never `sk` or raw upstream details.

The existing router, core, desktop Rust, typecheck, and browser smoke suites
remain required. Deployment acceptance includes switching the `.120` instance
to `https://aihub.dog`, retaining a timestamped rollback copy, verifying local
and public health/UI/login paths, and confirming upstream request logs target
the new origin after restart.

## Out of Scope

- runtime hot-swapping of the upstream client without restart;
- multiple upstream origins or automatic origin failover;
- deleting unknown or user-created Keys;
- changing public reverse-proxy/Caddy routing or `publicOrigin` semantics;
- a manual arbitrary-Key deletion API;
- unrelated routing-policy or main-branch feature merges.
