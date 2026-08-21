# Account Pools and Model Availability Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add strict Plus/Pro/Team account-group pools, provider-model capability routing, and nullable upper price-band configuration to the existing single-active-account router.

**Architecture:** Keep the current account/profile and `RouteDaemon` boundaries. Parse provider capabilities in `@aihub-auto/core`, apply plan and model policy in the core evaluator, and pass request model/runtime model blocks through every daemon route path. Expose policy state and reasons through `/ctl/status`, `/ctl/config`, and the existing inline console.

**Tech Stack:** Bun, TypeScript, Zod, `@aihub-auto/core`, Bun test, inline HTML/CSS/JavaScript console, existing router integration harness.

## Global Constraints

- Only one AIHub account is active at runtime; account pools select groups for that account and never rotate accounts.
- `accountPoolPlans` is a maximum-three-item union of `plus`, `pro`, and `team`; an empty selection saved by the console means no filtering.
- Legacy `accountPoolMode` remains readable; the console writes `accountPoolMode: "all"` whenever it saves the new selector.
- Missing or malformed provider capability metadata is unknown and must pass requests; a present empty array is known-empty.
- Static capability filtering and runtime model-block learning are independent; neither may overwrite the other.
- `priceBand: null` means no upper multiplier bound and is normalized for scoring to `{ min: 0, max: Number.MAX_VALUE }`.
- A selected plan is strict: do not fall back to an unfiltered group when no selected group is available.
- Preserve existing account-switch serialization, stale-cache behavior, proxy authentication, session affinity, and no-secret response rules.
- Keep edits ASCII by default, use existing project patterns, and do not merge `origin/main` wholesale.

## File Map

**Core contracts and policy**

- Modify `packages/core/src/types.ts`: capability fields, scoring options, and exclusion reasons.
- Modify `packages/core/src/client.ts`: tolerant provider/group capability parsing and merge behavior.
- Modify `packages/core/src/scoring.ts`: model matching, plan-aware allow-list reason, runtime model-block reason, and nullable-band normalization boundary.
- Modify `packages/core/tests/helpers.ts`, `packages/core/tests/client.test.ts`, and `packages/core/tests/scoring.test.ts`: focused unit coverage.

**Router configuration and routing**

- Modify `apps/router/src/config.ts`: pool fields and nullable/validated price band.
- Modify `apps/router/src/daemon.ts`: account-plan classifier, refresh cache state, scoring options, and model propagation through every route path.
- Modify `apps/router/tests/startup.test.ts`: configuration and classifier cases.
- Modify `apps/router/tests/integration.test.ts`, `apps/router/tests/harness.ts`, and `apps/router/tests/mock-upstream.ts`: end-to-end policy and stale-cache fixtures.

**Control plane and console**

- Modify `apps/router/src/server.ts`: status serialization and config PATCH validation/merge.
- Modify `apps/router/src/ui.ts`: plan checkboxes, nullable price controls, capability display, and reason labels.

---

### Task 1: Extend Core Capability and Scoring Contracts

**Files:**
- Modify: `packages/core/src/types.ts` (`GroupStat`, `ProviderLatencyStat`, `ScoringOptions`, `ExcludeReason`)
- Modify: `packages/core/src/client.ts` (parsing helpers and `mergeProviderLatencies`)
- Modify: `packages/core/tests/helpers.ts` (new defaults for optional scoring fields)
- Test: `packages/core/tests/client.test.ts`
- Test: `packages/core/tests/scoring.test.ts`

**Interfaces:**
- Produces `supportedModels?: string[]` and `modelAvailabilityKnown?: boolean` on group/provider stats.
- Produces `ScoringOptions.model?: string`, `ScoringOptions.modelBlockedGroupIds?: readonly number[]`, and `ScoringOptions.accountPoolFilterActive?: boolean`.
- Produces exclusion reasons `account_plan`, `model_unavailable`, and `model_blocked` for daemon and server consumers.

- [ ] **Step 1: Add failing parser tests.** Extend the provider fixture in `packages/core/tests/client.test.ts` with records containing `models`, `supported_models`, `available_models`, and `model_names`, using string and `{ model/name/id }` elements. Assert that an empty present array returns `modelAvailabilityKnown: true` with `supportedModels: []`, while a missing or non-array field omits the known marker. Assert the first present capability field wins and that the existing latency parsing remains unchanged.

- [ ] **Step 2: Run the focused client tests and verify failure.**

  Run: `bun test packages/core/tests/client.test.ts`

  Expected: the new assertions fail because capability fields are not yet parsed.

- [ ] **Step 3: Implement tolerant capability parsing.** In `packages/core/src/client.ts`, add the following helpers before `parseGroupStat` and use them from both `parseGroupStat` and `parseProviderLatencyStat`:

  ```ts
  function modelNames(raw: unknown): string[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    return raw
      .map((item) =>
        typeof item === "string"
          ? item
          : str(asRecord(item)["model"] ?? asRecord(item)["name"] ?? asRecord(item)["id"]),
      )
      .map((value) => value.trim())
      .filter(Boolean);
  }

  function supportedModelsFrom(record: Record<string, unknown>): {
    models?: string[];
    known?: boolean;
  } {
    for (const key of ["models", "supported_models", "available_models", "model_names"]) {
      if (!(key in record)) continue;
      const models = modelNames(record[key]);
      return { models: models ?? [], known: models !== undefined };
    }
    return {};
  }
  ```

  Spread `{ supportedModels: capability.models, modelAvailabilityKnown: true }` only when `capability.known` is true. In `mergeProviderLatencies`, let a provider record with known capability overlay the group capability; do not turn an unknown provider record into known-empty.

- [ ] **Step 4: Add failing scoring tests.** In `packages/core/tests/scoring.test.ts`, add cases asserting exact/case-insensitive and trailing-`*` matches, known-empty rejection, unknown capability pass-through, `account_plan` when `accountPoolFilterActive` rejects an ID, and `model_blocked` when `modelBlockedGroupIds` rejects an ID.

- [ ] **Step 5: Run the focused scoring tests and verify failure.**

  Run: `bun test packages/core/tests/scoring.test.ts`

  Expected: the new policy assertions fail with missing option/reason behavior.

- [ ] **Step 6: Implement the core filters in order.** Add a private `supportsModel` helper in `packages/core/src/scoring.ts`:

  ```ts
  function supportsModel(models: readonly string[] | undefined, requested: string): boolean {
    if (!models) return true;
    const target = requested.trim().toLowerCase();
    return models.some((model) => {
      const candidate = model.trim().toLowerCase();
      return candidate === target ||
        (candidate.endsWith("*") && target.startsWith(candidate.slice(0, -1)));
    });
  }
  ```

  Before rate checks, reject `modelBlockedGroupIds` with `model_blocked`; reject an `allowedGroupIds` miss with `account_plan` only when `accountPoolFilterActive === true`, otherwise retain `unavailable_group`; then apply `model_unavailable` only for a requested model and `modelAvailabilityKnown === true`. Keep platform/provider availability precedence and leave unknown capability eligible.

- [ ] **Step 7: Run the core unit suite and commit the contract.**

  Run: `bun test packages/core/tests/client.test.ts packages/core/tests/scoring.test.ts`

  Expected: all focused tests pass.

  Commit: `git add packages/core/src packages/core/tests && git commit -m "feat: add model capability scoring contracts"`

---

### Task 2: Add Configuration and Account-Pool Classification

**Files:**
- Modify: `apps/router/src/config.ts` (`ConfigSchema` and price-band refinement)
- Modify: `apps/router/src/daemon.ts` (exported `matchesAccountPool` helper only in this task)
- Test: `apps/router/tests/startup.test.ts`

**Interfaces:**
- Produces `AppConfig.accountPoolMode`, `AppConfig.accountPoolPlans`, and `AppConfig.priceBand: { min: number; max: number } | null`.
- Produces `matchesAccountPool(name, configured, legacy)` with union and legacy fallback semantics.

- [ ] **Step 1: Add failing configuration tests.** Add a table to `apps/router/tests/startup.test.ts` covering `A003-Plus`, `A003-Pro`, `A001-Team/K12`, `TEAM PLUS 混池`, `A008-BugTeam`, empty plans, legacy `mixed`, duplicate/invalid plans, `null` price band, and `max < min` rejection.

- [ ] **Step 2: Run the focused startup tests and verify failure.**

  Run: `bun test apps/router/tests/startup.test.ts`

  Expected: the new fields/helper assertions fail against the current schema.

- [ ] **Step 3: Implement schema compatibility.** Add these fields next to `mode` in `ConfigSchema`:

  ```ts
  accountPoolMode: z.enum(["all", "plus", "pro", "team", "mixed"]).default("all"),
  accountPoolPlans: z.array(z.enum(["plus", "pro", "team"])).max(3).default([]),
  priceBand: z.object({
    min: z.number().min(0).default(DEFAULT_PRICE_BAND.min),
    max: z.number().min(0).default(DEFAULT_PRICE_BAND.max),
  }).nullable().default(DEFAULT_PRICE_BAND),
  ```

  Add a schema refinement that rejects an object with `max < min` while allowing `null`. Preserve old config defaults and all unrelated fields.

- [ ] **Step 4: Implement the classifier.** Export `matchesAccountPool` from `apps/router/src/daemon.ts`; resolve non-empty `configured` first, otherwise map legacy `all` to no filter and `mixed` to all three plans. Match `(^|[^A-Za-z0-9])plan([^A-Za-z0-9]|$)` case-insensitively so `BugTeam` is excluded.

- [ ] **Step 5: Run and commit the configuration task.**

  Run: `bun test apps/router/tests/startup.test.ts`

  Expected: all startup/config tests pass.

  Commit: `git add apps/router/src/config.ts apps/router/src/daemon.ts apps/router/tests/startup.test.ts && git commit -m "feat: configure account plan pools"`

---

### Task 3: Integrate Account Data, Caches, and Model Policy in RouteDaemon

**Files:**
- Modify: `apps/router/src/daemon.ts` (`refreshAccountData`, scoring helpers, route paths, cache reset)
- Modify: `apps/router/tests/harness.ts` (optional mock capability/config hooks)
- Modify: `apps/router/tests/mock-upstream.ts` (emit capability arrays and configurable group names)
- Test: `apps/router/tests/integration.test.ts`

**Interfaces:**
- Consumes `matchesAccountPool` and the core scoring options from Tasks 1-2.
- Produces strict `allowedGroupIds`, `accountPoolFilterActive`, normalized price-band options, and model-aware route selection for all route branches.

- [ ] **Step 1: Add failing daemon tests.** Add integration cases that configure `accountPoolPlans: ["plus"]` with Plus and Pro stats and assert `runOnce()` chooses Plus; assert an empty new selection plus `accountPoolMode: "all"` allows both; assert `A008-BugTeam` is excluded. Add a model request where one provider advertises `gpt-5` and another advertises `claude-*`, then assert `daemon.route({ model: "gpt-5" })` never acquires the latter key. Add a runtime model block and assert it is excluded independently of static capability.

- [ ] **Step 2: Run the focused integration cases and verify failure.**

  Run: `bun test apps/router/tests/integration.test.ts -t "account plan|model"`

  Expected: the new tests either select the wrong plan or route to a statically incompatible group.

- [ ] **Step 3: Extend the mock upstream.** In `apps/router/tests/mock-upstream.ts`, include `supportedModels` from each `GroupStat` as `models` in `/api/v1/public/providers`; retain the existing usage-stat output. Keep `makeStat` defaults capability-unknown so old tests continue to exercise the compatibility path.

- [ ] **Step 4: Make account refresh strict and cache-aware.** In `RouteDaemon`, retain the existing TTL checks, but filter available groups by OpenAI/absent platform and `matchesAccountPool`. Track whether the latest account refresh is stale and combine it with usage-stat/provider staleness when constructing `RoundResult.stale` and `/ctl/status`. On a failed group/rate request, keep the prior `allowedGroupIds` and `userRates`; before the first successful group refresh leave the set undefined only when no plan is active, and leave it empty when a plan is active. Reset these fields on account switch. Set `accountPoolFilterActive` from the effective plan list.

- [ ] **Step 5: Normalize price bands and pass model policy.** Change `scoringOptions` to accept an optional model and model-block set, and return `priceBand: config.priceBand ?? { min: 0, max: Number.MAX_VALUE }`, `accountPoolFilterActive`, and `modelBlockedGroupIds`. Change the daemon's private `evaluate`, `hardEligible`, `manualLockCandidate`, and `halfOpenProbe` signatures to accept `model?: string` and pass it through.

- [ ] **Step 6: Thread request model through every route path.** Keep `routingItems()` as the complete cached stats list; do not pre-filter it. In `routeSingle` and `routePool`, compute `const modelBlocked = this.modelBlockedGroupIds(request.model, now)` and pass `request.model` plus that set into every `hardEligible`, manual-lock, probe, initial scoring, fallback, and failover evaluation. Keep request `failedGroupIds` in the ordinary blacklist so it remains distinct from learned model blocks.

- [ ] **Step 7: Verify cache and routing behavior and commit.**

  Run: `bun test apps/router/tests/integration.test.ts -t "account plan|model|缓存|路由"`

  Expected: plan, static capability, runtime block, account-switch reset, and stale-refresh tests pass.

  Commit: `git add apps/router/src/daemon.ts apps/router/tests/harness.ts apps/router/tests/mock-upstream.ts apps/router/tests/integration.test.ts && git commit -m "feat: route by account pools and model capability"`

---

### Task 4: Expose Policy and Nullable Price Band Through the Control API

**Files:**
- Modify: `apps/router/src/server.ts` (`/ctl/status`, `/ctl/config`)
- Test: `apps/router/tests/integration.test.ts`

**Interfaces:**
- `/ctl/status` returns `config.accountPoolMode`, `config.accountPoolPlans`, nullable `config.priceBand`, and candidate `models` plus known-state metadata.
- `/ctl/config` accepts `accountPoolMode`, `accountPoolPlans`, object/`null` `priceBand`, and partial economy policy updates without mutating on invalid input.

- [ ] **Step 1: Add failing API tests.** Extend the control-console integration block to assert the new config fields in status, successful Plus/Team union updates, explicit `priceBand: null`, partial object merge, invalid plan/max-min rejection, and preservation of the prior config after a rejected patch. Assert candidate JSON contains model names and `modelAvailabilityKnown` without any credential fields.

- [ ] **Step 2: Run the control API tests and verify failure.**

  Run: `bun test apps/router/tests/integration.test.ts -t "控制台 API"`

  Expected: status omits pool fields or null bands are dereferenced/rejected.

- [ ] **Step 3: Serialize model and policy diagnostics.** Add `models?: string[]` and `modelAvailabilityKnown?: boolean` to the local candidate response type and populate them for eligible, standby, and excluded candidates. Add the two pool fields and nullable price band to the status config object. Include `account_plan`, `model_unavailable`, and `model_blocked` in reason handling, but do not add them to manual-lock override reasons.

- [ ] **Step 4: Validate and merge config patches transactionally.** Keep the existing allowed-key whitelist. For `priceBand`, preserve the current object on omission, merge partial objects, and assign `null` only for explicit null. Build a candidate config with `ConfigSchema.safeParse`, return 400 with validation details on failure, and mutate/persist only after parsing succeeds. When a valid pool patch changes the effective selection, call the daemon cache-reset/invalidation hook before the next route.

- [ ] **Step 5: Run and commit the API task.**

  Run: `bun test apps/router/tests/integration.test.ts -t "控制台 API"`

  Expected: all status/config compatibility tests pass.

  Commit: `git add apps/router/src/server.ts apps/router/tests/integration.test.ts && git commit -m "feat: expose routing policy diagnostics"`

---

### Task 5: Update the Inline Console Controls

**Files:**
- Modify: `apps/router/src/ui.ts` (strategy markup, labels, render/save functions, reason map)
- Test: `apps/router/tests/integration.test.ts` (HTML smoke assertions if present)

**Interfaces:**
- Consumes the `/ctl/status` and `/ctl/config` payloads from Task 4.
- Produces Plus/Pro/Team multi-select controls, clear-to-unfiltered persistence, known/unknown model display, and null-safe price rendering.

- [ ] **Step 1: Add the strategy controls.** In the strategy panel markup, add a checkbox group with `id="accountPoolPlans"` and values `plus`, `pro`, and `team`. Keep controls stable on narrow screens using the existing `.range`/`.field` styles.

- [ ] **Step 2: Make rendering null-safe.** Update `reasonName` with `account_plan`, `model_unavailable`, and `model_blocked`. In `render(status)`, read `const priceBand = status.config.priceBand`; show `priceBand.min/max` only for an object and show the localized unlimited label for null; populate checkbox state from `status.config.accountPoolPlans`; render blank numeric fields for null.

- [ ] **Step 3: Save the union and unlimited band.** Replace `saveStrategy` with logic equivalent to:

  ```js
  const minText = $("#priceMin").value.trim();
  const maxText = $("#priceMax").value.trim();
  if ((minText === "") !== (maxText === ""))
    throw new Error("倍率上下限需要同时填写，或同时留空表示不限");
  const priceBand = !minText && !maxText
    ? null
    : { min: Number(minText), max: Number(maxText) };
  const accountPoolPlans = $$("#accountPoolPlans input:checked").map((input) => input.value);
  await api("/ctl/config", {
    method: "POST",
    body: JSON.stringify({
      mode: $("#mode").value,
      accountPoolMode: "all",
      accountPoolPlans,
      priceBand,
      economyPolicy: {
        minSuccessRate: Number($("#minSuccess").value) / 100,
        maxConservativeLatencyMs: Number($("#maxLatency").value) * 1000,
        minOutcomeSamples: Number($("#minSamples").value),
      },
    }),
  });
  ```

  Retain explicit numeric validation when a non-null band is submitted. Empty max must clear both band inputs before sending null; reject a partially empty band with a visible error rather than sending `NaN`.

- [ ] **Step 4: Show model capability diagnostics.** Add a models column or subtitle to candidate rows. Display `未知` for `modelAvailabilityKnown !== true`, a comma-separated escaped list for a known list, and use `reasonName[candidate.excludeReason]` for model/plan exclusions. Do not render tokens or raw upstream payloads.

- [ ] **Step 5: Run UI/control tests and commit.**

  Run: `bun test apps/router/tests/integration.test.ts -t "控制台 API|页面|UI"`

  Expected: HTML contains all three plan values, status rendering is null-safe, and config submissions include `accountPoolMode: "all"` when clearing the selector.

  Commit: `git add apps/router/src/ui.ts apps/router/tests/integration.test.ts && git commit -m "feat: add pool and capability controls"`

---

### Task 6: Complete Cross-Path Regression Coverage

**Files:**
- Modify: `apps/router/tests/integration.test.ts` (route/failover/session cases)
- Modify: `apps/router/tests/proxy.test.ts` and `apps/router/tests/session.test.ts` (model incompatibility coexistence)
- Modify: `apps/router/tests/startup.test.ts` (legacy config/null band regression)

**Interfaces:**
- Consumes all policy contracts from Tasks 1-5.
- Produces evidence that single-key, pool, session-affinity, probe, failover, account switch, and stale refresh all honor the same model/plan filters.

- [ ] **Step 1: Add route-path tests.** For each of `routeSingle`, pool affinity, preferred-group continuity, half-open probe, and failed-group retry, set a model whose static capability excludes one group and assert that group is never acquired. Add a learned `modelBlocks` entry for a statically compatible group and assert the compatible alternative is selected.

- [ ] **Step 2: Add cache/account-switch tests.** Change `accountPoolPlans` through the control API, assert cached `allowedGroupIds` is invalidated, switch the active saved account, assert account-scoped stats/provider/plan state is reset, and simulate failed `/groups/available` or provider requests to assert the prior successful data is retained with `stale: true`.

- [ ] **Step 3: Add no-candidate safety tests.** With a strict plan or known-empty model list that excludes every group, assert route returns no key and never falls back to the current/unfiltered group. Verify the response/audit contains reason codes but no access token or upstream key.

- [ ] **Step 4: Run the complete router suite and commit.**

  Run: `bun test apps/router/tests`

  Expected: all router tests pass, including existing account switching, proxy streaming, outbound proxy, startup, and UI-auth tests.

  Commit: `git add apps/router/tests && git commit -m "test: cover policy filters across routing paths"`

---

### Task 7: Full Verification and Release Preparation

**Status:** Complete on 2026-08-21. The release build used the cached Bun
1.3.14 Linux x64 baseline runtime after Bun's normal cross-target download
failed during extraction; the resulting binary was hash-verified before and
after deployment.

**Files:**
- Modify only if a focused check exposes a defect; otherwise no source changes.
- Inspect: `package.json`, desktop/Tauri version files, generated artifacts, and `git diff`.

- [x] **Step 1: Run the repository check.**

  Run: `bun run check`

  Expected: all Bun tests and TypeScript checks pass with zero failures.

- [x] **Step 2: Run focused build and Rust checks.**

  Run: `bunx tsc --noEmit -p tsconfig.json; cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml; cargo fmt --check`

  Expected: TypeScript emits no diagnostics, Rust tests pass, and formatting exits successfully.

- [x] **Step 3: Run version and artifact checks.**

  Run:

  ```powershell
  $env:RELEASE_TAG = "v0.4.5"
  bun -e 'const tag=process.env.RELEASE_TAG; const app=await Bun.file("apps/desktop/package.json").json(); const tauri=await Bun.file("apps/desktop/src-tauri/tauri.conf.json").json(); const cargo=(await Bun.file("apps/desktop/src-tauri/Cargo.toml").text()).match(/^version = "([^"]+)"/m)?.[1]; const versions=[app.version,tauri.version,cargo]; if(!cargo||new Set(versions).size!==1||tag!==`v${app.version}`) throw new Error(`release tag/version mismatch: ${tag} vs ${versions.join(",")}`); console.log(`validated ${tag}`)'
  bun scripts/build.ts
  Get-ChildItem artifacts -Filter "aihub-auto-headless-*.zip" -ErrorAction Stop
  ```

  Expected: the version command prints `validated v0.4.5`, the build exits 0, and at least one headless zip exists. Confirm the release files contain no secret fields and the working tree contains only the intentionally preserved untracked directories/files (`.playwright-cli/`, `.superpowers/`, `aihub-auto-src.tar.gz`, `output/`).

- [x] **Step 4: Review and publish.**

  Run: `git diff fork/feat/single-user-v0.4.5...HEAD --stat; git status --short --branch`

  Expected: every changed source/test file maps to this plan, focused/full checks are green, and no unrelated tracked changes exist. Commit any final fix separately, then follow the repository's normal push/tag/release workflow; do not force-push or delete the preserved untracked artifacts.

## Self-Review Checklist

- Spec coverage: plan fields and legacy behavior are in Tasks 2, 4, and 5; capability parsing and matching are in Tasks 1 and 3; strict stale/no-candidate behavior is in Tasks 3 and 6; verification is Task 7.
- Placeholder scan: every implementation step contains a concrete file, operation, and verification command.
- Type consistency: `modelBlockedGroupIds`, `accountPoolFilterActive`, `accountPoolMode`, `accountPoolPlans`, and nullable `priceBand` are introduced before their daemon/server/UI consumers.
- Scope: no concurrent account routing, new policy framework, upstream contract change, or unrelated refactor is planned.
