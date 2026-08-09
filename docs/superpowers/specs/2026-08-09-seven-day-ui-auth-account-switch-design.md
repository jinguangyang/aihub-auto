# Seven-Day Console Authentication and AIHub Account Switching Design

## Goal

Make the operations console practical for repeated use and make AIHub account
changes a real runtime boundary:

- after one valid `uiPassword` entry, the same browser may use `/ctl/*`
  without another prompt for seven days;
- only a console-authentication failure may open the console-password prompt;
  an expired AIHub login must remain a distinct account error;
- the client-facing `proxyToken` remains stable across AIHub account changes;
- a successful switch to a different AIHub account stops all reuse of the old
  account's managed keys, sessions, and single-key credential without requiring
  an application restart.

AIHub creates upstream `sk` values and its key-creation API accepts only a name
and group. The router therefore will not try to force two AIHub accounts to use
the same upstream `sk`. The stable abstraction is the router's existing
`proxyToken`: clients keep one Base URL and one API key while the router owns
the changing upstream credentials.

## Selected Approach

Use a stateless, signed, seven-day `HttpOnly` cookie for console authentication
and add an explicit account-transition operation around the existing mutable
credentials, executor, daemon, and persisted state.

This is preferred over storing the plaintext console password in
`localStorage`. It provides the requested persistence across page and router
restarts without exposing the password to page JavaScript. It is also preferred
over a multi-account credential vault: this change makes the existing login
form switch accounts correctly, but does not add account profiles or retain
multiple AIHub login tokens.

## Console Authentication Contract

### Session creation

Add a browser-oriented control endpoint that is dispatched before the normal
`/ctl/*` authorization guard:

```text
POST /ctl/auth
Content-Type: application/json

{"password":"<uiPassword>"}
```

When `uiPassword` is configured and the submitted value matches, the response
is `200 {"ok":true,"expiresAt":<unix-ms>}` and sets a cookie containing a
versioned payload, random nonce, and absolute expiry signed with HMAC-SHA-256.
The configured `uiPassword` is the signing key, namespaced with an application
constant. Changing `uiPassword` therefore invalidates every existing cookie
without another revocation store.

The cookie attributes are:

- `HttpOnly` so the embedded page and third-party page scripts cannot read it;
- `SameSite=Strict` so it is not attached to cross-site navigation or fetches;
- `Path=/ctl` so it is never sent to proxied model endpoints;
- `Max-Age=604800` for exactly seven days;
- `Secure` when `publicOrigin` is HTTPS.

The signed expiry is authoritative. A modified, malformed, or expired cookie is
rejected even if the browser retains it. If no `uiPassword` is configured, the
existing loopback no-auth behavior remains and `/ctl/auth` reports that console
authentication is not required.

### Authorized requests and compatibility

The `/ctl/*` guard accepts either:

1. the existing constant-time checked `x-ui-password` header; or
2. a valid signed console-session cookie.

Keeping header authentication preserves scripts, tests, and non-browser
clients. Every unauthorized control response has a machine-readable body:

```json
{
  "code": "UI_AUTH_REQUIRED",
  "error": "需要控制台口令"
}
```

No other `401` response may use `UI_AUTH_REQUIRED`. In particular, AIHub token
rejection from `/ctl/account` remains an account-login error. The UI parses the
response body before deciding whether to authenticate and prompts only for this
exact code.

Add `DELETE /ctl/auth` to expire the browser cookie. The settings page exposes
a compact `清除免密登录` action only when UI authentication is configured.
Clearing the session affects this browser only and does not change
`uiPassword`, `proxyToken`, or AIHub credentials.

### UI request flow

The page no longer retains `uiPassword` after session creation:

1. a control request receives `UI_AUTH_REQUIRED`;
2. one shared in-flight authentication promise opens the password prompt;
3. the submitted password is posted to `/ctl/auth`;
4. after the cookie is set, every request waiting on that promise retries once;
5. cancellation or invalid input rejects the waiting requests without opening
   additional prompts.

The single-flight promise prevents simultaneous status, balance, and log
requests from producing duplicate dialogs. A normal AIHub `401` is displayed
as an account error and never clears the console session. The fixed seven-day
duration is described beside the clear-session action; there is no additional
remember-me checkbox.

## Account Identity

Persist an opaque `accountIdentity` beside AIHub credentials. Derive it from the
validated `/api/v1/auth/me` response in this order:

1. a non-empty stable user `id`, when the upstream supplies one;
2. the normalized lower-case verified email;
3. a SHA-256 fingerprint of the access token as a conservative fallback.

The identity is used only as a local ownership tag and is never returned to
clients or logs. The verified email remains the display identity.

Persist the same ownership tag in `state.json`. At startup, a mismatch between
the credential owner and state owner clears account-scoped state before any key
can be routed. This makes the two-file update crash-consistent: regardless of
which file was written before an interruption, old upstream `sk` values cannot
be reused under new credentials after restart.

Existing installations without ownership tags migrate as follows: after the
stored credential is verified, its derived identity becomes the owner of the
existing state. The existing executor reconciliation still removes remote key
references that no longer exist.

## Account Switch Transaction

Move login validation and account replacement behind a focused account-switch
service rather than mutating the shared credentials directly in the HTTP route.
Only one login or switch may run at a time.

### Candidate validation

Email/password login first obtains a candidate session. Direct-token login uses
the submitted token as the candidate. A temporary AIHub client then calls
`me()` with that candidate token. Until this succeeds, shared credentials and
all runtime state remain unchanged. A failed login therefore cannot disrupt the
currently working account.

### Same-account reauthentication

If the candidate identity equals the current identity, update access token,
refresh token, expiry, and verified email in place. Preserve managed pool keys,
single-key data, sessions, aliases, manual lock, and current group. Clear
`needsReauth` and refresh account-specific group/rate data. This covers normal
token renewal without destroying useful continuity.

### Different-account switch

If the identity differs, the service performs these steps while new routes are
temporarily rejected:

1. reject the switch with HTTP `409` if a key reservation or model request is
   active; no credential or state mutation occurs;
2. best-effort delete only the managed pool keys recorded in `state.pool` by
   using the old account credential; never delete a manually created key;
3. clear local pool entries even when remote cleanup fails, logging only key IDs
   and leaving any unreachable old-account key for manual cleanup;
4. clear `singleKeySk`, current/pending group selection, manual lock, sessions,
   response aliases, and model compatibility blocks;
5. clear daemon account caches (`allowedGroupIds`, user-specific rates, last
   account decision) while retaining public latency statistics and general
   local health observations;
6. store the candidate credentials and write matching credential/state owner
   tags;
7. immediately run an account-data/routing refresh and resume new requests.

During the short replacement window, a model request receives retryable HTTP
`503` rather than being routed with ambiguous credentials. The UI disables the
login controls for the request duration and reports either `登录信息已更新` for a
same-account login or `账号已切换，客户端 API Key 无需修改` for a different
account.

The router `proxyToken`, listen address, policy configuration, update settings,
and client applications are untouched. No desktop restart command is needed
for account switching.

## Component Boundaries

### Console session helper

A small server-side helper owns cookie parsing, HMAC signing/verification,
expiry calculation, cookie serialization, and constant-time comparison. It has
pure functions where possible so expiry, tampering, password changes, HTTPS
attributes, and malformed input can be tested without starting a server.

### Account switch service

The service owns candidate authentication, identity derivation, serialization,
busy checks, old managed-key cleanup, ownership tags, state reset, persistence,
and daemon refresh. The HTTP route only validates the request shape, calls the
service, and maps typed failures to stable status codes.

The executor exposes a narrow serialized reset operation for managed key state;
the daemon exposes a narrow account-cache reset/refresh operation. Neither the
UI nor the server route reaches into their private concurrency maps.

## Error Handling

- invalid console password: HTTP `401`, `UI_AUTH_REQUIRED`, no cookie;
- malformed console-auth JSON: HTTP `400`;
- expired or tampered console cookie: treated as missing authentication;
- invalid AIHub candidate credentials: HTTP `400`, old account unchanged;
- account switch while requests/reservations are active: HTTP `409` with a
  concise retry message, old account unchanged;
- old managed-key deletion failure: warning plus continued switch; the local
  reference is always removed;
- persistence failure before the candidate is committed: HTTP `500` and keep
  the old in-memory account wherever rollback is possible;
- account refresh failure after a committed switch: keep the new credentials,
  show a refresh warning, and allow the daemon's normal polling to retry;
- request arriving during the commit window: HTTP `503` with `Retry-After: 1`.

Control/auth/account responses retain `Cache-Control: no-store`. Passwords,
tokens, cookie values, upstream `sk` values, and token fingerprints never enter
logs or response messages.

## Tests

Console-session unit and integration coverage will verify:

- valid cookies authorize `/ctl/status` for exactly seven days;
- expired, malformed, tampered, or differently signed cookies are rejected;
- cookie attributes include `HttpOnly`, `SameSite=Strict`, `/ctl` path, correct
  max age, and conditional `Secure`;
- the legacy `x-ui-password` header remains accepted;
- `DELETE /ctl/auth` expires the cookie;
- only `UI_AUTH_REQUIRED` triggers the UI authentication flow;
- an AIHub account `401` does not prompt for or clear console authentication;
- concurrent failed control requests share one prompt/authentication promise;
- no console password is written to `localStorage` or `sessionStorage`.

Account-switch coverage will verify:

- invalid candidate credentials preserve the old credentials and state;
- reauthenticating the same identity preserves pool and session continuity;
- switching identities deletes known old managed keys when possible and always
  clears their local `sk` values;
- different-account switching clears single-key credentials, affinity,
  aliases, model blocks, lock, and current selection;
- active traffic returns `409` without partially switching;
- a request in the commit window receives retryable `503`;
- the first request after switching creates/uses a key owned by the new account;
- the client-facing `proxyToken` and `/v1` authentication are unchanged;
- mismatched persisted owner tags are cleared during startup recovery;
- pool and single key modes both work after a switch without restart.

Run the complete Bun test suite, TypeScript checks, router build, desktop Rust
tests, and focused browser verification of the seven-day/clear-session controls.

## Out of Scope

- forcing or duplicating one AIHub-generated upstream `sk` across accounts;
- storing several AIHub accounts or adding an account profile selector;
- automatic account rotation based on balance or failures;
- changing `proxyToken` from the web page;
- adding a general restart button to the normal operations page;
- deleting unknown `aihub-auto-*` keys that are not owned by this local state.
