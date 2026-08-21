# Account Pools and Model Availability Routing Design

## Goal

Adapt the account-pool and model-availability routing behavior from
`WSXYT/aihub-auto` to this project's existing single-active-account router.
The router must be able to:

- restrict the active account's OpenAI groups to a selectable union of Plus,
  Pro, and Team plans;
- avoid sending a request to a group whose provider metadata explicitly says
  that the requested model is unavailable;
- retain the existing runtime model-compatibility learning and failover
  behavior;
- expose enough policy and candidate diagnostics in the authenticated console
  to explain each routing decision; and
- support an unlimited upper price-band bound without breaking old configs.

Only one AIHub account remains active at runtime. Account pools select groups
belonging to that account; they do not implement concurrent multi-account
routing or automatic account rotation.

## Selected approach

Use the existing scoring and routing pipeline as the policy boundary:

1. `RouteDaemon` derives an `allowedGroupIds` set from the active account's
   available groups and the configured plan selection.
2. The core client parses provider model metadata into typed capability fields.
3. Core scoring applies the group allow-list and static model capability
   filter alongside the existing price, health, and runtime model-block
   filters.
4. Every initial route, pool route, probe, and failover evaluation passes the
   request model through the same scoring options.
5. The server and inline console render the policy state and exclusion reasons.

This keeps policy semantics in one evaluator while preserving the current
account, cache, session-affinity, and runtime-learning boundaries. A separate
capability-policy abstraction is intentionally out of scope for this change.

## Configuration and compatibility

The router config gains:

```ts
accountPoolPlans: Array<"plus" | "pro" | "team">; // max three, default []
accountPoolMode: "all" | "plus" | "pro" | "team" | "mixed"; // legacy
```

`accountPoolPlans` is authoritative when non-empty. When it is empty, the
legacy mode is used: `all` means no plan filtering and `mixed` means the union
of all three plans. Existing config files containing only `accountPoolMode`
continue to behave as before. Invalid values are rejected by the config API
with a 400 response rather than silently coerced.

The console always writes `accountPoolMode: "all"` when it saves the new
multi-select control. Consequently, clearing every checkbox unambiguously
means no filtering, while a legacy file that has not yet been saved through
the new console still retains its old single-mode behavior.

The existing `priceBand` becomes nullable:

```ts
priceBand: { min: number; max: number } | null;
```

An object keeps the current validation (`min >= 0`, `max >= min`). `null`
means no multiplier upper bound; scoring treats it as `{ min: 0, max:
Number.MAX_VALUE }`. A PATCH that omits `priceBand` leaves it unchanged; an
explicit null clears it; a partial object continues to merge with the current
object for backward compatibility. The UI uses an empty upper-bound input to
send null and displays an explicit unlimited state.

## Account-plan data flow

When `RouteDaemon.refreshAccountData` refreshes `/api/v1/groups/available` for
the active account, it:

1. retains groups whose platform is `openai` or whose platform field is
   absent;
2. classifies the group name with a case-insensitive word-boundary matcher;
3. when a plan filter is active, keeps only names matching one selected plan;
4. stores the resulting group IDs in `allowedGroupIds`.

The matcher treats any non-ASCII-alphanumeric separator as a boundary, so
`A003-Plus`, `A001-Team/K12`, and `TEAM PLUS pool` match their respective
plans, while `A008-BugTeam` does not match Team. If a plan filter is active,
an unclassified group is excluded. An empty `accountPoolPlans` with legacy
mode `all` leaves `allowedGroupIds` unset, which means no plan filtering.

Group and provider refreshes use the existing stale-cache contract. A failed
refresh keeps the last successful groups, provider map, and allowed ID set and
marks the data stale. Before the first successful refresh, the corresponding
data is empty/unknown; an active plan filter must not be bypassed to choose an
arbitrary group. Account switches and relevant config changes invalidate the
account-scoped caches before the next refresh.

## Provider capability parsing

`getProviderLatencyStats` parses each provider record from
`/api/v1/public/providers`. The parser checks these fields in order:

- `models`
- `supported_models`
- `available_models`
- `model_names`

The first present array is used. Elements may be strings or objects with a
`model`, `name`, or `id` string. Empty present arrays are known-empty. Missing
fields, malformed values, and records that do not contain a usable capability
array are marked unknown so old or partially deployed upstream APIs continue
to route requests. The typed stats add:

```ts
supportedModels?: string[];
modelAvailabilityKnown?: boolean;
```

The provider's latency and other existing fields remain unchanged.

## Scoring and routing behavior

`ScoringOptions` gains `model?: string`. For a request with a model, a group is
excluded for `model_unavailable` only when its provider capability is known and
none of the supported names matches. Matching is case-insensitive and accepts
either exact equality or a supported name ending in `*` whose prefix matches
the request. A request without a model skips this filter. Unknown capability
metadata always passes this filter.

The evaluator applies these conditions in the existing candidate pipeline:

- `allowedGroupIds` plan filtering;
- known static model capability;
- runtime `modelBlocks` learned from upstream incompatibility responses;
- price-band and economy policy;
- health, cooldown, and capacity rules.

Static capability does not erase or replace runtime blocks. Runtime success and
failure reporting continues to update `modelBlocks` independently, and a
later metadata refresh can make a statically excluded group eligible again.
The evaluator returns stable exclusion reasons, including
`account_plan` and `model_unavailable`, for diagnostics.

`RouteDaemon.routeSingle`, `routePool`, session/probe selection, and all
failover paths pass the same `request.model` into evaluation. If no candidate
remains, the existing no-candidate response is retained with the added reason
counts; no path may silently fall back to an unfiltered group.

## Server and console behavior

The authenticated `/ctl/config` endpoint accepts and returns both pool fields,
with the new plan array taking precedence. Status/candidate payloads include
the active plan policy, supported model names when known, and the exclusion
reason. The inline console adds Plus, Pro, and Team multi-select controls;
clearing all selections means no filtering. Candidate rows distinguish
unknown capability from a known list and show model-unavailable exclusions.

Existing UI controls for minimum and maximum price remain stable. An empty
maximum serializes as `priceBand: null`; status rendering never dereferences a
null band and instead shows `unlimited`/localized equivalent text. All API
responses retain the current authentication and no-store behavior.

## Failure and safety rules

- Provider metadata is auxiliary: its outage cannot make an otherwise valid
  group unusable when no cached metadata exists.
- An explicitly selected plan is strict. No eligible group is preferable to
  violating the plan selection.
- A known-empty model list excludes a concrete model request; a missing or
  malformed list does not.
- Existing account-switch serialization, stale markers, session affinity, and
  runtime model-block expiry remain authoritative.
- Config validation rejects invalid plans, malformed price bands, and more
  than three selected plans before mutating in-memory or persisted config.
- Diagnostics contain IDs, plan/capability metadata, and reason codes only;
  credentials and upstream secrets are never returned.

## Tests and verification

### Core unit tests

Add coverage for:

- plan classification boundaries, case variants, mixed selections, legacy
  mode fallback, and empty selection;
- provider capability fields, string/object elements, field precedence,
  known-empty versus unknown, malformed metadata, exact matching, wildcard
  matching, and case-insensitivity;
- scoring exclusions for plan and model reasons, unknown capability pass
  through, runtime-block coexistence, and nullable price bands.

### Router and integration tests

Cover single-key and pool routes, session affinity, probes, failover, and
model requests with static capability plus learned `modelBlocks`. Verify
active-account switching, cache invalidation, stale refresh retention, strict
empty-plan behavior, config hot updates, and `/ctl/config` backward
compatibility. Add startup/config parsing tests for old files and null price
bands.

### Console and release checks

Exercise plan multi-select, clear-to-unfiltered, unlimited price-band
save/restore, and candidate reason rendering. Before release run:

- `bun run check`;
- TypeScript checks and router build;
- Rust tests and `cargo fmt --check`;
- version consistency checks; and
- the existing startup, proxy, account, outbound-proxy, and UI integration
  suites.

Review the final diff and generated artifacts, then commit and publish only
after all focused and full checks pass. Do not merge `origin/main` wholesale;
port the specified behavior into this branch's account/profile and runtime
proxy architecture.

## Out of scope

- concurrent routing across multiple active AIHub accounts;
- automatic account rotation by plan, balance, price, or failure rate;
- a new standalone capability-policy framework;
- changing upstream API contracts or client-facing proxy authentication;
- bypassing a selected plan or known model incompatibility to avoid a
  no-candidate result.
