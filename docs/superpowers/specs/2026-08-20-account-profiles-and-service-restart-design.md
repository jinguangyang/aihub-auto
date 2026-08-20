# AIHub Account Profiles and Service Restart Design

## Goal

Extend the existing single-active-account switch flow so that an operator can:

- keep several AIHub login profiles on the local machine;
- activate any saved profile without changing the client-facing proxy token;
- add a new profile through the existing login form;
- sign out the active profile or remove a saved profile;
- request a controlled service restart from the authenticated console.

The router still routes all traffic through exactly one active AIHub account.
This is a profile selector, not concurrent multi-account traffic routing.

## Selected approach

Store account profiles in a separate `accounts.json` file. The existing
`credentials.json` remains the runtime credential for the active profile, and
`state.json` remains account-scoped routing state. This keeps secrets out of
the general state file, preserves backwards compatibility, and lets the
existing account-switch transaction remain the only path that mutates active
credentials and managed keys.

Passwords are never stored. A profile contains the access token, optional
refresh token and expiry, verified email, opaque identity, and timestamps.
The file is written with the same atomic write and local-file permissions as
the existing credential file. Tokens are therefore protected by the local
configuration-directory boundary; adding an ad-hoc encryption scheme is out of
scope until a platform keyring abstraction exists.

## Persistent data model and migration

`accounts.json` is validated with a strict schema:

```json
{
  "version": 1,
  "activeIdentity": "id:...",
  "profiles": [
    {
      "identity": "id:...",
      "email": "user@example.com",
      "accessToken": "...",
      "refreshToken": "...",
      "expiresAt": 0,
      "createdAt": 0,
      "lastUsedAt": 0
    }
  ]
}
```

The API never returns token fields. Identity is the existing derived stable
owner tag. Profiles are unique by identity; a successful login upserts the
candidate profile and marks it active.

On startup, an existing active credential without `accounts.json` is imported
after its identity is known. If the active identity no longer has a profile,
the runtime credential is retained for one migration cycle and then written as
the active profile. Invalid account-file contents fall back to an empty
profile list without blocking startup; the active credential remains usable.

Removing a non-active profile only rewrites `accounts.json`. Removing the
active profile first runs the normal account logout transaction, then removes
that profile. Signing out clears the active runtime credential and routing
state but keeps the profile for one-click reactivation; an explicit Remove
action deletes it.

## Service boundaries

`AccountSwitchService` gains three operations:

- `listProfiles()` returns redacted metadata sorted by last use;
- `switchTo(identity)` loads and validates a saved profile, then delegates to
  the same serialized active-account transaction used by login;
- `remove(identity)` removes an inactive profile, or logs out and removes the
  active profile after the traffic/busy check.

Login remains backward compatible at `POST /ctl/login`; it validates the
candidate with a temporary client, upserts the profile, and activates it.
New control endpoints are:

```text
GET    /ctl/accounts
POST   /ctl/accounts/switch     {"identity":"..."}
POST   /ctl/logout
POST   /ctl/accounts/remove     {"identity":"..."}
POST   /ctl/restart
```

All routes require the existing console authorization and return `no-store`
responses. Identity values are treated as opaque strings and are never used as
filesystem paths. Busy account operations keep the current `409` contract.

## Console behavior

The account panel displays a compact saved-profile list containing email (or a
short identity), active state, and last-used time. Each inactive profile has a
Switch action; each profile has a Remove action; the active profile has a
Sign-out action. The login form adds or updates a profile and immediately
activates it. The UI never renders a token or password after submission.

The settings panel adds a Restart service action. It requires confirmation,
disables itself while the request is pending, and shows that the browser may
briefly lose the connection. After reconnecting, the normal status polling
restores the page. Account switching and restart errors are displayed from
their machine-readable status codes rather than inferred from generic 401s.

## Restart lifecycle

`POST /ctl/restart` is authenticated and single-flight. It returns `202` with
`{"ok":true,"restarting":true}` and schedules shutdown after the response has
been handed to Bun. A second request while a restart is pending returns `409`.
The request is rejected with `409` while an account mutation or active model
stream is in flight, avoiding a partial key transition or an abrupt stream
termination.

The main process changes shutdown to accept an exit code. A console restart
uses exit code `75` (`RESTART_REQUESTED`); ordinary signals continue to exit
with code `0`. In standalone mode the process manager (systemd, Docker,
launchd, or a wrapper script) is responsible for restarting a process that
exits with `75`. The response and documentation make this requirement
explicit; the router does not spawn a second copy of itself.

The desktop sidecar already has a parent-owned lifecycle. Its termination
handler recognizes code `75`, keeps the main window alive, and calls the
existing sidecar start routine after the old child has exited. Other
unexpected exits retain the current failure-window behavior. Normal desktop
quit continues to use the private shutdown token and does not auto-restart.

## Failure and safety rules

- Candidate validation fails before any profile, credential, or routing state
  changes.
- A switch transaction deletes only locally managed keys belonging to the old
  active account and clears local references even if remote cleanup fails.
- Persistence failure rolls back the in-memory active account where possible;
  profile writes are serialized with credential/state writes.
- A stale or malformed accounts file cannot cause a token to be logged or
  routed under the wrong owner.
- Control responses never contain access tokens, refresh tokens, passwords, or
  upstream secret keys.
- Restart cannot be triggered by a GET request, the proxy API, or an
  unauthenticated browser.

## Tests and verification

Add unit and integration coverage for:

- schema parsing, migration, atomic profile persistence, and redacted listing;
- login upsert, same-account refresh, saved-profile switch, failed switch
  rollback, inactive removal, active sign-out, and busy protection;
- endpoint authorization, request validation, status codes, and absence of
  secret fields in JSON responses;
- restart single-flight behavior, active-traffic rejection, delayed shutdown,
  exit code `75`, and standalone callback wiring;
- desktop sidecar restart-code handling without changing normal quit/failure
  behavior;
- browser account-list actions and restart confirmation/reconnect behavior.

Run the Bun tests, TypeScript check, router build, and focused desktop Rust
checks. Keep the existing account-switch and seven-day console-auth tests
green.

## Out of scope

- concurrent routing across multiple AIHub accounts;
- automatic account rotation by balance, price, or failure rate;
- storing passwords or silently re-authenticating without a saved token;
- platform keyring encryption before a shared keyring abstraction is available;
- self-spawning a replacement standalone process;
- changing the client-facing proxy token or upstream API contract.
