# Task 6 Report

## Files changed

- `apps/router/tests/integration.test.ts`
  - Added routeSingle static model filtering.
  - Added pool affinity and preferred-group model filtering.
  - Added half-open probe and failed-group retry filtering.
  - Added learned `modelBlocks` alternative routing.
  - Added control API account-pool policy cache invalidation coverage.
  - Added strict account-plan and known-empty model no-candidate safety coverage.
- `apps/router/tests/proxy.test.ts`
  - Added coexistence coverage for statically model-scoped proxy sessions.
- `apps/router/tests/session.test.ts`
  - Added model-scoped session binding coexistence coverage.
- `apps/router/tests/startup.test.ts`
  - Preserved the intentional pre-existing Task 2 startup/account-pool regression changes.

## Coverage mapping

- Single-key path: incompatible static group is never acquired.
- Pool affinity and preferred-group continuity: incompatible bindings are bypassed.
- Half-open probe and failed-group retry: incompatible groups are skipped.
- Runtime model block: learned incompatibility selects the compatible alternative.
- Control policy mutation: changing `accountPoolPlans` refreshes eligibility.
- Account-plan and known-empty model exhaustion: no route key, no upstream request, and no secret in the response/status evidence.
- Proxy/session coexistence: model-specific sessions remain isolated.
- Existing account-switch and stale refresh tests remain in the integration suite.

## Verification

Command:

`bun test apps/router/tests`

Output summary:

`173 pass`

`0 fail`

`840 expect() calls`

`Ran 173 tests across 12 files. [7.11s]`

## Commit

`240497bcca86cc769473f520924b3bd8be031459`

## Concerns

- No product behavior changes were needed.
- The existing control/status API exposes exclusion reasons for the current daemon evaluation; the no-candidate assertions therefore verify the strict-plan reason through status and secret absence for both plan/model exhaustion paths.

## Follow-up Review Coverage

- Control API plan updates now assert that an omitted `accountPoolMode` remains `all`.
- Nullable `priceBand` now asserts the daemon normalizes it to `{ min: 0, max: Number.MAX_VALUE }` for scoring.
- Account switching now proves the account-scoped usage-stat, provider, available-group, and rate caches are refreshed after the switch.
- Known-empty model availability now asserts the live routing evaluation reports `model_unavailable` for every candidate, while the no-key/no-upstream response safety check remains in place.

### Observable-reason limitation

Request-time model filtering remains separate from the daemon guard-loop `lastRound`, `/ctl/status`, and `AuditLog` candidate lists. The new response diagnostic intentionally covers the client-visible no-route contract without changing those broader status/audit schemas.

Follow-up verification:

`bun test apps/router/tests/integration.test.ts apps/router/tests/startup.test.ts`

`78 pass`, `0 fail`, `469 expect() calls` (rerun: 3.98s).

Follow-up commit: `31e990f7fd7516d5aa417a23652ffda72439099f`.

## Request-Scoped Diagnostic Follow-up

Added a minimal optional `RouteRequest.failureReason` diagnostic. When a request-scoped evaluator has excluded candidates and no key can be selected, `routeSingle`/`routePool` retain the first final exclusion reason. The proxy includes that non-secret value as `error.code` on the existing 503 no-route response; requests with empty stats or no login continue to omit the code, and the existing message/retry behavior is unchanged.

The known-empty model regression now asserts `error.code === "model_unavailable"` in the response, with no token/upstream request. This closes the response reason-code gap without changing audit/status contracts.

Verification:

`bun test apps/router/tests/integration.test.ts apps/router/tests/proxy.test.ts`

`78 pass`, `0 fail`, `571 expect() calls` (6.33s).

Diagnostic commit: `6a4777bcb5044430b7e8cdb2a65192b782dff48f`.

Complete router-suite verification:

`bun test apps/router/tests`

`173 pass`, `0 fail`, `851 expect() calls` (7.05s).
