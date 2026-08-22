# AIHub Upstream Origin and Pool Delete Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe console-configurable AIHub upstream origin and durable, non-blocking recovery for failed managed pool-Key deletion, then deploy the verified build to `111.228.17.120`.

**Architecture:** Keep the upstream origin change restart-bound: the running client, daemon, and proxy continue using the startup origin while a validated new origin is persisted as pending. Add a persisted `pendingPoolDeletes` queue to `AppState`; failed deletion detaches a Key from the usable pool, queues only non-secret metadata, and serialized cleanup retries due entries for the matching account with capped exponential backoff. The public `publicOrigin` remains unrelated.

**Tech Stack:** Bun/TypeScript, Zod, Bun test, existing HTML UI renderer, systemd/Caddy deployment over SSH, cached Bun Linux x64 baseline compiler.

## Global Constraints

- Public non-loopback upstream origins must be complete `https:` origins with no credentials, path, query, or fragment.
- `http:` is allowed only for exact loopback hosts used by tests/local development.
- Upstream-origin changes never hot-swap dependencies; they require the existing explicit restart.
- Pending cleanup state never stores `sk`, tokens, raw upstream bodies, or raw exception text.
- Only locally recorded managed Key IDs may be deleted; unknown remote Keys remain untouched.
- Preserve untracked `.playwright-cli/`, `aihub-auto-src.tar.gz`, and `output/`.
- Do not merge `origin/main` wholesale or force-push.

---

### Task 1: Validate and expose upstream origin configuration

**Files:**
- Modify: `apps/router/src/config.ts`
- Modify: `apps/router/src/server.ts`
- Modify: `apps/router/src/main.ts`
- Modify: `apps/router/tests/sentry.test.ts`
- Modify: `apps/router/tests/integration.test.ts`
- Modify: `apps/router/tests/harness.ts`

**Interfaces:**
- Produce `UpstreamBaseUrlSchema` and `isAllowedUpstreamOrigin` behavior used by `ConfigSchema` and control validation.
- `ServerDeps.activeBaseUrl` records the startup origin; `deps.config.baseUrl` may hold a validated pending origin until restart.
- `/ctl/status` returns `config.baseUrl` as the active origin, plus `pendingBaseUrl` and `restartRequired` when they differ.

- [x] **Step 1: Add failing schema and control tests.**

  Add tests asserting `https://aihub.dog` and loopback HTTP mocks parse; reject
  public HTTP, credentials, paths, queries, fragments, and malformed values.
  Extend the control API test to post `{ baseUrl: "https://aihub.dog" }`, expect
  HTTP 200 with `restartRequired: true`, verify the active client remains on
  the mock URL, and verify a later hot-setting save preserves the pending URL.

- [x] **Step 2: Run the focused tests and observe the expected failures.**

  Run:

  ```powershell
  bun test apps/router/tests/sentry.test.ts apps/router/tests/integration.test.ts
  ```

  Expected: new origin assertions fail because the current schema/API has no
  origin-specific validation or pending-restart response.

- [x] **Step 3: Implement origin validation and startup-origin tracking.**

  In `config.ts`, validate URL scheme/host/port shape, reject credentials and
  non-root paths, permit HTTPS everywhere and HTTP only for loopback. Add the
  schema to `baseUrl` while retaining local mock compatibility. Pass
  `activeBaseUrl: config.baseUrl` from `main.ts` into `createServer`.

- [x] **Step 4: Implement pending origin handling in `/ctl/config` and status.**

  Add `baseUrl` to the allowed patch keys. Parse the complete candidate config,
  assign it only after validation, detect `parsed.data.baseUrl !==
  deps.activeBaseUrl`, persist atomically, return `{ ok: true,
  restartRequired, pendingBaseUrl }`, and skip `daemon.runOnce()` for a changed
  origin. Include active/pending origin metadata in `/ctl/status`; never return
  credentials or upstream response data.

- [x] **Step 5: Run focused tests and commit.**

  Run the two commands above; expected result is all existing and new tests
  passing. Then commit:

  ```powershell
  git add apps/router/src/config.ts apps/router/src/server.ts apps/router/src/main.ts apps/router/tests/sentry.test.ts apps/router/tests/integration.test.ts apps/router/tests/harness.ts
  git commit -m "feat: configure upstream origin from console"
  ```

### Task 2: Add the console origin workflow

**Files:**
- Modify: `apps/router/src/ui.ts`
- Modify: `apps/router/tests/integration.test.ts`

**Interfaces:**
- Consume `/ctl/status` active/pending origin metadata and `/ctl/config` restart response.
- Produce a settings control with stable IDs `upstreamBaseUrl` and `saveUpstreamBaseUrl`.

- [x] **Step 1: Add HTML/UI assertions.**

  Assert the rendered UI contains the source-origin label, URL input, save
  button, restart-required status element, and existing restart control.

- [x] **Step 2: Add the settings row and save behavior.**

  Place an `AIHub 源头域名` row near connection settings. Populate the input
  from `pendingBaseUrl ?? baseUrl`, show `当前生效` or `保存后需重启`, POST only
  `{ baseUrl }`, preserve the entered value on errors, and refresh status after
  success. Do not auto-restart; use the existing restart button. Keep the row
  responsive without text overlap.

- [x] **Step 3: Verify and commit.**

  Run:

  ```powershell
  bun test apps/router/tests/integration.test.ts -t "UI|控制台 API"
  ```

  Expected: UI markers and status transitions pass. Commit:

  ```powershell
  git add apps/router/src/ui.ts apps/router/tests/integration.test.ts
  git commit -m "feat: add upstream origin settings"
  ```

### Task 3: Persist pending pool-delete metadata

**Files:**
- Modify: `apps/router/src/config.ts`
- Modify: `apps/router/src/account-state.ts`
- Modify: `apps/router/src/executor.ts`
- Modify: `apps/router/tests/executor.test.ts`
- Modify: `apps/router/tests/harness.ts`

**Interfaces:**
- Add `AppState.pendingPoolDeletes: Record<string, PendingPoolDelete>` with
  `keyId`, `groupId`, `accountIdentity`, `attempts`, `nextRetryAt`, `queuedAt`,
  and bounded `lastErrorCode`.
- Add `RouteExecutor.pendingPoolDeleteStats(now?)` and private queue helpers.

- [x] **Step 1: Add failing state and deletion tests.**

  Add tests for a failed delete that detaches the pool entry and queues only
  metadata, a first failed victim followed by a successful later victim, and a
  remote 404 treated as success. Assert serialized state contains no `sk`.

- [x] **Step 2: Extend state schema and classify delete outcomes.**

  Add the default-empty queue schema. Implement helpers that classify
  `AIHubApiError` statuses/codes into bounded categories and recognize 404/410
  or documented not-found codes as idempotent success.

- [x] **Step 3: Change eviction to isolate failures.**

  Refactor `evictLru` to report state changes, continue after a failed victim,
  remove that victim from usable `state.pool`, enqueue its owner metadata, and
  invoke forced-affinity cleanup only when the existing forced policy requires
  it. Ensure successful deletion still invokes the current callback and logs
  only Key ID/group/category.

- [x] **Step 4: Add bounded retry processing.**

  Implement a serialized retry pass for at most eight due entries belonging to
  the current account. Use `5s * 2^(attempts-1)` capped at one hour, saturate
  attempts at 31, update category/next retry on failure, and remove entries on
  success or idempotent not-found. Persist whenever queue or pool state changes.

- [x] **Step 5: Run executor tests and commit.**

  Run:

  ```powershell
  bun test apps/router/tests/executor.test.ts
  ```

  Expected: all old pool behavior plus new failure/retry tests pass. Commit:

  ```powershell
  git add apps/router/src/config.ts apps/router/src/account-state.ts apps/router/src/executor.ts apps/router/tests/executor.test.ts apps/router/tests/harness.ts
  git commit -m "fix: recover failed managed pool deletions"
  ```

### Task 4: Integrate cleanup recovery, status, and account transitions

**Files:**
- Modify: `apps/router/src/executor.ts`
- Modify: `apps/router/src/account-switch.ts`
- Modify: `apps/router/src/daemon.ts`
- Modify: `apps/router/src/server.ts`
- Modify: `apps/router/src/ui.ts`
- Modify: `apps/router/tests/executor.test.ts`
- Modify: `apps/router/tests/integration.test.ts`

**Interfaces:**
- Startup reconcile and daemon trim invoke the retry pass.
- Account switch/logout queue failures under the previous account identity.
- `/ctl/status.poolCleanup` returns only pending/due/current-account counts.

- [x] **Step 1: Add account-transition and restart/reconcile tests.**

  Assert failed logout/switch deletion returns compatible `orphanedKeyIds`,
  keeps a durable old-account queue entry, does not retry it with the new
  account, and retries when the old identity is active. Add a state reload test
  and a status assertion for counts only.

- [x] **Step 2: Integrate retry into reconcile, trim, cleanup, and account switch.**

  Retry due entries before/alongside ordinary eviction, remove current-account
  pending IDs proven absent by a successful remote listing, retain other-account
  entries, and persist queue updates. During logout/switch, detach local pool
  entries while queueing failures with the old identity; never use the new
  token for those IDs. Apply the same queue logic during optional exit cleanup.

- [x] **Step 3: Expose status and compact UI feedback.**

  Add `poolCleanup` aggregate counts to `/ctl/status`. Append a non-secret
  pending-cleanup indicator to the existing pool summary, with a tooltip/help
  string explaining that deletion will retry; do not render raw errors or
  secrets.

- [x] **Step 4: Run router regression tests and commit.**

  Run:

  ```powershell
  bun test apps/router/tests
  bunx tsc --noEmit -p tsconfig.json
  ```

  Expected: all router tests and TypeScript checks pass. Commit:

  ```powershell
  git add apps/router/src/executor.ts apps/router/src/account-switch.ts apps/router/src/daemon.ts apps/router/src/server.ts apps/router/src/ui.ts apps/router/tests/executor.test.ts apps/router/tests/integration.test.ts
  git commit -m "feat: expose pool cleanup recovery status"
  ```

### Task 5: Full verification, build, and deploy to `.120`

**Files/Artifacts:**
- Inspect: `package.json`, desktop/Tauri version files, `git diff`, generated Linux binary.
- Remote: `/opt/aihub-auto/aihub-auto`, `/var/lib/aihub-auto/config.json`.

- [x] **Step 1: Run full local verification.**

  Run:

  ```powershell
  bun run check
  bun test apps/router/tests
  cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
  cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
  ```

  Expected: zero failures and no formatting diagnostics.

  Result: `bun run check` passed with 294 tests, router tests passed with 186
  tests, desktop Rust tests passed with 4 tests, and `cargo fmt --check` passed.

- [x] **Step 2: Build and hash the Linux binary with the cached runtime.**

  Run:

  ```powershell
  bun build --compile --minify --compile-executable-path="$env:TEMP\aihub-auto-bun-linux-x64-baseline-1.3.14\bun-linux-x64-baseline-v1.3.14" --target=bun-linux-x64-baseline apps/router/src/main.ts --outfile output/aihub-auto-headless-linux-x64
  Get-FileHash output/aihub-auto-headless-linux-x64 -Algorithm SHA256
  ```

  Result: built the non-overwriting artifact
  `output/aihub-auto-headless-linux-x64-v0.4.5-recovery-final`
  (94,791,808 bytes).
  SHA256: `B66EA4DF96B70E8EE04E95EDC7CA1767F9EB9B14625C6D1BA20D11573E8E42B0`.

- [x] **Step 3: Back up and deploy atomically.**

  Upload to a timestamped `/tmp` path on `111.228.17.120` using
  `easytunnel-deploy`. Over SSH, create a `0700` rollback directory under
  `/var/lib/aihub-auto`, copy the current binary and config, install the new
  binary as `root:root 0755`, and restart `aihub-auto.service`. Preserve all
  existing secrets and set only `baseUrl` to `https://aihub.dog` in the config.

  Result: deployed over SSH as `easytunnel-deploy` using the verified key.
  Created `/var/lib/aihub-auto/rollback-v0.4.5-recovery-20260822-0947` with
  mode `0700`, backed up the prior binary and config, installed the candidate
  as `root:root` `0755`, and changed only `baseUrl` to `https://aihub.dog`.

- [x] **Step 4: Verify deployment and public browser flow.**

  Verify remote service/Caddy active, `NRestarts=0`, local `/healthz`, public
  `/healthz` and `/ui`, source config is `https://aihub.dog`, binary hash matches,
  and browser login gives authenticated `/ctl/status` with a `Secure`,
  `HttpOnly`, `SameSite=Strict` cookie. Confirm the old binary hash is present
  in the rollback directory and remove only the temporary `/tmp` upload.

  Result: remote binary hash matched the local SHA256 above; service is active
  with `NRestarts=0`; local and public `/healthz` and `/ui` returned HTTP 200;
  config reports `https://aihub.dog`; rollback hash and permissions were
  verified. Temporary upload was removed.

- [x] **Step 5: Record and push release state.**

  Result: source and plan records were committed locally, and remote lookup
  confirmed `fork/feat/single-user-v0.4.5` at `d66eae7` on 2026-08-22.

  Update the implementation plan checkboxes with verification results, run
  `git diff --check`, commit the release record, and push the feature branch
  normally. Do not force-push or delete preserved untracked artifacts.

## Self-Review Checklist

- Schema rules cover both production HTTPS origins and loopback test servers.
- The active client origin cannot change before restart; pending saves survive
  later hot-setting updates.
- Every deletion failure is isolated, queued without secrets, retried only with
  the owning account, and eventually removed on success/not-found.
- Status/UI expose counts and origins only; no tokens or raw upstream errors.
- Tasks include tests for every behavior in the design spec and a `.120`
  rollback/deployment verification path.
