# AIHub Account Profiles and Service Restart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist multiple validated AIHub account profiles, let the console switch or remove them while keeping one active account, and expose an authenticated restart action that is managed by the standalone supervisor or desktop sidecar.

**Architecture:** Add a validated `accounts.json` store beside the existing credential/state files. Extend `AccountSwitchService` so login, saved-profile activation, logout, and removal share one serialized transaction. Add redacted control endpoints and a delayed restart callback; standalone exits with code 75 and the Tauri parent respawns the sidecar on that code.

**Tech Stack:** Bun, TypeScript, Zod, Bun HTTP server, Tauri 2/Rust sidecar, Bun test.

## Global Constraints

- Keep exactly one active AIHub account; do not route requests concurrently across accounts.
- Never persist passwords or return access/refresh tokens from control APIs.
- Preserve the existing `credentials.json`, `state.json`, `/ctl/login`, proxy token, and seven-day console-auth behavior.
- Use atomic `FileStore` writes and local configuration-directory permissions.
- Restart is authenticated, POST-only, single-flight, and exits standalone with code `75`; ordinary shutdown remains code `0`.
- Reject account mutation or restart while active traffic would make state ambiguous.

---

### Task 1: Add account profile schema and persistence helpers

**Files:**
- Create: `apps/router/src/accounts.ts`
- Test: `apps/router/tests/accounts.test.ts`
- Test: `apps/router/tests/startup.test.ts`

**Interfaces:**
- `AccountProfileSchema`, `AccountsSchema`, `type AccountProfile`, and `type Accounts` are exported from `accounts.ts`.
- `loadAccounts(store: FileStore): Promise<Accounts>` reads `accounts.json` with an empty version-1 fallback.
- `persistAccountProfile(accounts, profile)` and `removeAccountProfile(accounts, identity)` mutate only validated in-memory data; callers persist through `FileStore.write("accounts.json", accounts)`.
- `redactedAccountProfiles(accounts, activeIdentity)` returns `{ identity, email, active, createdAt, lastUsedAt }[]` and never includes token fields.

- [ ] **Step 1: Write failing schema and redaction tests**

Add tests that parse a valid profile, reject duplicate identities and unknown fields, load malformed files as an empty store, upsert an identity without duplicating it, and assert `JSON.stringify(redactedAccountProfiles(...))` contains no `Token`, `access`, `refresh`, or `sk` values.

- [ ] **Step 2: Run the focused tests and verify failure**

Run `bun test apps/router/tests/accounts.test.ts`; expect module/export failures because `accounts.ts` does not exist.

- [ ] **Step 3: Implement the schema and helpers**

Use a strict Zod object with `version: z.literal(1)`, `activeIdentity: z.string().min(1).optional()`, and a defaulted profile array. Profile tokens remain strings but are never returned by the redaction helper. Enforce unique identities in `superRefine`, sort copies by `lastUsedAt` descending, and keep mutations deterministic.

- [ ] **Step 4: Add startup migration coverage and implementation**

Add a helper `ensureActiveProfile(accounts, credentials, now): boolean` that creates or updates a profile when `credentials.accessToken` and `credentials.accountIdentity` exist, sets `activeIdentity`, and returns whether persistence is needed. Test both an empty store and an existing profile. Callers will persist only when it returns true.

- [ ] **Step 5: Run tests and typecheck**

Run `bun test apps/router/tests/accounts.test.ts apps/router/tests/startup.test.ts` and `bunx tsc --noEmit -p tsconfig.json`; expect PASS.

- [ ] **Step 6: Commit**

Run `git add apps/router/src/accounts.ts apps/router/src/config.ts apps/router/tests/accounts.test.ts apps/router/tests/startup.test.ts && git commit -m "feat: persist AIHub account profiles"`.

### Task 2: Extend the account switch service

**Files:**
- Modify: `apps/router/src/account-switch.ts`
- Modify: `apps/router/src/main.ts`
- Modify: `apps/router/tests/harness.ts`
- Modify: `apps/router/tests/account-switch.test.ts`

**Interfaces:**
- `AccountSwitchDeps` gains `accounts: Accounts` and `persistAccounts: () => Promise<void>`.
- `AccountSwitchService.listProfiles(): AccountProfileSummary[]` returns redacted profiles.
- `AccountSwitchService.switchTo(identity: string): Promise<AccountSwitchResult>` validates the stored token with a temporary client, then uses the same serialized activation path as login.
- `AccountSwitchService.remove(identity: string): Promise<{ ok: true; removed: boolean }>` removes inactive profiles or logs out and removes the active profile.
- `logout()` keeps the active profile in `accounts` but clears runtime credentials/state.

- [ ] **Step 1: Add failing service tests**

Cover login upsert, switching from account two back to account one while retaining both profiles, invalid stored-token rollback, inactive removal, active logout retaining the profile, active removal deleting it, and busy protection for all mutating operations.

- [ ] **Step 2: Run the focused tests and verify failure**

Run `bun test apps/router/tests/account-switch.test.ts`; expect constructor/type failures for the new dependencies and methods.

- [ ] **Step 3: Refactor activation into one private transaction**

Create a private `activateSession(session, identity, email, switched)` method. It snapshots credentials/state/profile data, clears managed keys only when the identity changes, applies the candidate session, updates `accounts.activeIdentity` and `lastUsedAt`, persists accounts/state/credentials, resets daemon caches, and restores all snapshots on pre-commit failure. Keep the current `AccountSwitchBusyError` mapping and warning behavior.

- [ ] **Step 4: Implement saved-profile switch and removal**

`switchTo` finds an exact opaque identity, calls `createClient(profile.accessToken).me()`, derives identity, rejects an identity mismatch without mutation, and calls the activation method. `remove` serializes with `mutation`; non-active removal only updates the profile list, while active removal calls `logoutLocked`, then removes the profile and persists the empty active marker.

- [ ] **Step 5: Wire startup migration and persistence**

Load `accounts` beside credentials in `main.ts`, call `ensureActiveProfile` after `refreshSentryIdentity`, and pass `persistAccounts` to the service. Extend the test harness with an in-memory accounts object and persistence callback.

- [ ] **Step 6: Run tests and commit**

Run `bun test apps/router/tests/account-switch.test.ts apps/router/tests/accounts.test.ts` and `bunx tsc --noEmit -p tsconfig.json`; commit with `feat: add saved account switching`.

### Task 3: Add redacted account endpoints and restart coordination

**Files:**
- Modify: `apps/router/src/server.ts`
- Modify: `apps/router/src/main.ts`
- Modify: `apps/router/src/daemon.ts`
- Modify: `apps/router/tests/integration.test.ts`
- Modify: `apps/router/tests/harness.ts`

**Interfaces:**
- `ServerDeps` gains `requestRestart: () => void` and `restartState: { pending: boolean }`.
- `POST /ctl/login` remains unchanged and now upserts profiles.
- `GET /ctl/accounts` returns `{ activeIdentity, accounts: AccountProfileSummary[] }`.
- `POST /ctl/accounts/switch` accepts exactly `{ identity: string }`.
- `POST /ctl/logout` and `POST /ctl/accounts/remove` map typed errors to 409/400 responses.
- `POST /ctl/restart` returns 202 `{ ok: true, restarting: true }`, 409 when pending, account mutation is active, or `traffic.activeStreams > 0`.

- [ ] **Step 1: Add failing integration tests**

Start the harness server and assert account listing has no token fields, switching changes the active identity, malformed bodies return 400, inactive removal works, logout returns no active token, unauthenticated calls return `UI_AUTH_REQUIRED`, restart returns 202 once and 409 on the second request, and active traffic blocks restart.

- [ ] **Step 2: Add server dependency wiring**

Add `accounts`, `persistAccounts`, and `requestRestart` to `ServerDeps` and the harness. Keep all JSON responses `Cache-Control: no-store` through the existing `json()` helper.

- [ ] **Step 3: Implement account routes**

Parse JSON with explicit object/string checks, reject unknown or missing identities, call the service, and map `AccountSwitchBusyError` to `{ code: "ACCOUNT_SWITCH_BUSY" }` with status 409. Never spread profile objects into responses; use `listProfiles()` only.

- [ ] **Step 4: Implement restart guard and delayed callback**

Use `restartState.pending` as a single-flight latch. Check `deps.daemon.isAccountSwitching()` (add a read-only method if needed) and `deps.traffic.snapshot().activeStreams`; return 409 with stable codes. Set the latch, return 202, and invoke `requestRestart` from `setTimeout(..., 50)` so Bun can flush the response.

- [ ] **Step 5: Wire main shutdown**

Change `shutdown(signal, exitCode = 0)`, add a `restartState` object and a `requestRestart` closure, pass both to `createServer`, and call `shutdown("control restart", 75)` from the closure. Preserve SIGINT/SIGTERM code 0 and existing cleanup/persistence ordering.

- [ ] **Step 6: Run integration tests and commit**

Run `bun test apps/router/tests/integration.test.ts apps/router/tests/account-switch.test.ts`; commit with `feat: expose account and restart controls`.

### Task 4: Add console account management and restart controls

**Files:**
- Modify: `apps/router/src/ui.ts`
- Modify: `apps/router/tests/integration.test.ts` (rendered UI assertions)

**Interfaces:**
- The UI calls `/ctl/accounts`, `/ctl/accounts/switch`, `/ctl/logout`, `/ctl/accounts/remove`, and `/ctl/restart` only through the existing `api()` helper.
- New DOM hooks are `#accountProfiles`, `#logoutAccount`, and `#restartService`.

- [ ] **Step 1: Add markup and rendered-UI assertions**

Add a compact account-profile list below the login inputs, a logout button, and a restart button in the desktop settings panel. Add integration assertions that `renderUi()` contains the endpoint names and all hooks.

- [ ] **Step 2: Implement redacted profile rendering**

Add `let accountProfiles = []`, `refreshProfiles()`, and `renderProfiles()` that escape every server string, show active state, and attach switch/remove listeners. Do not interpolate token values or retain submitted passwords.

- [ ] **Step 3: Implement actions and state refresh**

After login/logout/switch/remove, clear password/token inputs, call `refresh()` and `refreshProfiles()`, and refresh the balance only when `lastStatus.hasToken` is true. Confirm destructive remove and restart actions with `confirm()`.

- [ ] **Step 4: Implement reconnect behavior**

For a successful restart, show a short toast, mark the service as restarting, and let the existing five-second status polling restore the normal state. Do not retry the restart request automatically.

- [ ] **Step 5: Run UI assertions and commit**

Run `bun test apps/router/tests/integration.test.ts` and `bunx tsc --noEmit -p tsconfig.json`; commit with `feat: manage accounts from the console`.

### Task 5: Respawn the desktop sidecar on restart exit

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Test: `apps/desktop/src-tauri/src/lib.rs` Rust unit tests or `apps/desktop/src-tauri/tests/restart.rs`
- Modify: `apps/desktop/README.md`

**Interfaces:**
- Router restart exit code constant is `75` in Rust and TypeScript documentation.
- `CommandEvent::Terminated` handles `code == Some(75)` by clearing old child state and calling `start_router(&app, true)`.

- [ ] **Step 1: Add a pure Rust restart-code test**

Extract `fn restart_requested(code: Option<i32>) -> bool { code == Some(75) }` and test code 75, code 0, and signal/no-code cases.

- [ ] **Step 2: Handle the restart termination event**

In the existing sidecar event task, when the router was already reported healthy and the termination payload code is 75, schedule `start_router` on the main thread without setting `StartupError` or opening the failure window. Keep `router.stopping` false for this path and retain current behavior for other exits.

- [ ] **Step 3: Document standalone and desktop semantics**

Add the authenticated endpoint, exit code 75, and supervisor requirement to `apps/desktop/README.md` and the router operations documentation.

- [ ] **Step 4: Run Rust and TypeScript checks**

Run `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`, `bun test`, and `bunx tsc --noEmit -p tsconfig.json`; commit with `feat: restart desktop sidecar after control restart`.

### Task 6: Final verification and release notes

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-20-account-profiles-and-service-restart-design.md` only if verification reveals an explicit contradiction

- [ ] **Step 1: Run focused checks**

Run `bun test apps/router/tests/accounts.test.ts apps/router/tests/account-switch.test.ts apps/router/tests/integration.test.ts` and `bunx tsc --noEmit -p tsconfig.json`.

- [ ] **Step 2: Run the complete short checks**

Run `bun test` and `bun run typecheck`; stop and report any command that stalls instead of retrying indefinitely.

- [ ] **Step 3: Review the diff for secrets and unrelated files**

Run `git diff --check`, inspect changed paths, and verify no test fixture, log, or UI response contains an access token, refresh token, password, or upstream `sk`.

- [ ] **Step 4: Update operator documentation**

Document profile storage location, sign-out versus remove, desktop auto-respawn, and the standalone exit-code-75 supervisor contract in `README.md`.

- [ ] **Step 5: Commit documentation and report**

Run `git add README.md && git commit -m "docs: explain account profiles and restart"`, then report tests and any residual platform-specific gaps.
