# AIHub Account Hot-Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a validated AIHub account change immediately use only the new account while every client continues using the same router `proxyToken` and no router restart is required.

**Architecture:** Persist an opaque owner tag with credentials and account-scoped state, and centralize candidate validation plus replacement in `AccountSwitchService`. The daemon temporarily rejects new routes during the short commit window, the executor serializes old managed-key cleanup, and startup ownership alignment prevents old upstream `sk` reuse after a partial two-file write.

**Tech Stack:** TypeScript, Bun HTTP server/test runner, `@aihub-auto/core` AIHub client, Zod state schemas, existing router daemon/executor/session/traffic primitives.

## Global Constraints

- The client-facing `proxyToken` and Base URL never change during an AIHub account switch.
- AIHub-generated upstream `sk` values are never forced, copied, or returned to the UI.
- Candidate credentials must pass `me()` before shared runtime credentials change.
- Same-account reauthentication preserves pool keys and session continuity.
- Different-account switching clears every locally cached old-account `sk`, session, alias, model block, lock, and current selection.
- Only managed keys recorded in `state.pool` may be deleted remotely; manual keys are never deleted.
- Active traffic returns HTTP `409` with the old account unchanged.
- Requests entering the commit window receive retryable HTTP `503`.
- Owner-tag mismatches clear account-scoped state before startup routing.
- Do not modify unrelated `.playwright-cli/` or `output/` worktree content.

---

### Task 1: Account Identity and Account-Scoped State

**Files:**
- Create: `apps/router/src/account-state.ts`
- Create: `apps/router/src/account-errors.ts`
- Create: `apps/router/tests/account-state.test.ts`
- Modify: `apps/router/src/config.ts`

**Interfaces:**
- Consumes: a validated profile record, access token, `AppState`, and `Credentials`.
- Produces: `profileEmail(profile, fallback)`, `deriveAccountIdentity(profile, accessToken)`, `legacyCredentialIdentity(credentials)`, `resetAccountScopedState(state, credentials, nextIdentity)`, `alignAccountStateOwner(state, credentials, profile)`, `AccountSwitchBusyError`, and `AccountSwitchingError`.

- [ ] **Step 1: Write failing identity and reset tests**

```ts
import { describe, expect, test } from "bun:test";
import { StateSchema, type Credentials } from "../src/config.ts";
import {
	alignAccountStateOwner,
	deriveAccountIdentity,
	profileEmail,
	resetAccountScopedState,
} from "../src/account-state.ts";

describe("AIHub account-owned state", () => {
	test("derives stable id, email, then token identities", () => {
		expect(deriveAccountIdentity({ id: 42, email: "A@Example.com" }, "token-a"))
			.toBe("id:42");
		expect(deriveAccountIdentity({ email: " A@Example.com " }, "token-a"))
			.toBe("email:a@example.com");
		expect(deriveAccountIdentity({}, "token-a")).toMatch(/^token:[a-f0-9]{64}$/);
		expect(profileEmail({ email: " A@Example.com " })).toBe("a@example.com");
	});

	test("clears only account-scoped runtime data", () => {
		const state = StateSchema.parse({
			accountIdentity: "email:old@example.com",
			currentGroupId: 1,
			manualLock: { groupId: 1, revision: 3 },
			lastSwitchAt: 1,
			pendingSwitch: { groupId: 2, since: 1 },
			pool: { "1": { keyId: 7, sk: "sk-old", lastUsedAt: 1 } },
			sessions: { session: { groupId: 1, lastUsedAt: 1 } },
			responseAliases: { response: { sessionKey: "session", groupId: 1, lastUsedAt: 1 } },
			modelBlocks: { model: { "1": 999 } },
			breaker: { retained: true },
			observations: { retained: true },
		});
		const credentials: Credentials = {
			accessToken: "old-token",
			accountIdentity: "email:old@example.com",
			singleKeySk: "sk-single-old",
		};
		resetAccountScopedState(state, credentials, "email:new@example.com");
		expect(state.accountIdentity).toBe("email:new@example.com");
		expect(state.currentGroupId).toBeUndefined();
		expect(state.manualLock).toEqual({ groupId: null, revision: 4 });
		expect(state.pool).toEqual({});
		expect(state.sessions).toEqual({});
		expect(state.responseAliases).toEqual({});
		expect(state.modelBlocks).toEqual({});
		expect(state.breaker).toEqual({ retained: true });
		expect(credentials.singleKeySk).toBeUndefined();
	});

	test("preserves legacy state on first owner adoption and clears known mismatch", () => {
		const legacy = StateSchema.parse({
			pool: { "1": { keyId: 1, sk: "sk-legacy", lastUsedAt: 1 } },
		});
		const legacyCredentials: Credentials = { accessToken: "token", email: "user@example.com" };
		expect(alignAccountStateOwner(legacy, legacyCredentials, { email: "user@example.com" }))
			.toEqual({ identity: "email:user@example.com", reset: false });
		expect(legacy.pool["1"]?.sk).toBe("sk-legacy");

		legacy.accountIdentity = "email:old@example.com";
		expect(alignAccountStateOwner(legacy, legacyCredentials, { email: "new@example.com" }).reset)
			.toBe(true);
		expect(legacy.pool).toEqual({});
	});
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test apps/router/tests/account-state.test.ts`

Expected: FAIL because the account modules and schema fields do not exist.

- [ ] **Step 3: Add owner fields and implement pure state operations**

Add to both `StateSchema` and `CredentialsSchema`:

```ts
accountIdentity: z.string().min(1).max(128).optional(),
```

Create `account-errors.ts`:

```ts
export class AccountSwitchBusyError extends Error {
	constructor() {
		super("仍有请求正在处理，请稍后再切换账号");
		this.name = "AccountSwitchBusyError";
	}
}

export class AccountSwitchingError extends Error {
	constructor() {
		super("AIHub 账号正在切换，请稍后重试");
		this.name = "AccountSwitchingError";
	}
}
```

Create `account-state.ts` with these operations:

```ts
import { createHash } from "node:crypto";
import type { AppState, Credentials } from "./config.ts";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function profileEmail(
	profile: Record<string, unknown>,
	fallback = "",
): string | undefined {
	for (const value of [profile["email"], fallback]) {
		if (typeof value !== "string") continue;
		const normalized = value.trim().toLowerCase();
		if (EMAIL.test(normalized)) return normalized;
	}
	return undefined;
}

export function deriveAccountIdentity(
	profile: Record<string, unknown>,
	accessToken: string,
): string {
	const id = profile["id"];
	if ((typeof id === "string" && id.trim()) ||
		(typeof id === "number" && Number.isSafeInteger(id))) {
		return `id:${String(id).trim()}`;
	}
	const email = profileEmail(profile);
	if (email) return `email:${email}`;
	return `token:${createHash("sha256").update(accessToken).digest("hex")}`;
}

export function legacyCredentialIdentity(
	credentials: Credentials,
): string | undefined {
	return credentials.accountIdentity ??
		(credentials.email ? `email:${credentials.email.trim().toLowerCase()}` : undefined);
}

export function resetAccountScopedState(
	state: AppState,
	credentials: Credentials,
	nextIdentity: string,
): void {
	delete state.currentGroupId;
	delete state.lastSwitchAt;
	delete state.pendingSwitch;
	state.manualLock = { groupId: null, revision: state.manualLock.revision + 1 };
	state.pool = {};
	state.sessions = {};
	state.responseAliases = {};
	state.modelBlocks = {};
	state.accountIdentity = nextIdentity;
	delete credentials.singleKeySk;
}

export function alignAccountStateOwner(
	state: AppState,
	credentials: Credentials,
	profile: Record<string, unknown>,
): { identity: string; reset: boolean } {
	const accessToken = credentials.accessToken ?? "";
	const identity = deriveAccountIdentity(profile, accessToken);
	const knownCredentialOwner = legacyCredentialIdentity(credentials);
	const mismatch =
		Boolean(knownCredentialOwner && knownCredentialOwner !== identity) ||
		Boolean(state.accountIdentity && state.accountIdentity !== identity);
	if (mismatch) resetAccountScopedState(state, credentials, identity);
	state.accountIdentity = identity;
	credentials.accountIdentity = identity;
	credentials.email = profileEmail(profile, credentials.email);
	return { identity, reset: mismatch };
}
```

- [ ] **Step 4: Run focused tests and type checking**

Run: `bun test apps/router/tests/account-state.test.ts`

Expected: 3 tests PASS.

Run: `bunx tsc --noEmit -p tsconfig.json`

Expected: exit code 0.

- [ ] **Step 5: Commit identity ownership**

```bash
git add apps/router/src/account-state.ts apps/router/src/account-errors.ts apps/router/src/config.ts apps/router/tests/account-state.test.ts
git commit -m "feat: tag state with AIHub account ownership"
```

### Task 2: Executor and Daemon Switch Primitives

**Files:**
- Modify: `apps/router/src/executor.ts`
- Modify: `apps/router/src/daemon.ts`
- Modify: `apps/router/src/proxy.ts`
- Modify: `apps/router/tests/executor.test.ts`
- Modify: `apps/router/tests/integration.test.ts`

**Interfaces:**
- Consumes: `AccountSwitchBusyError` and `AccountSwitchingError` from Task 1.
- Produces: `RouteExecutor.hasAccountActivity()`, `RouteExecutor.clearManagedKeysForAccountSwitch()`, `RouteDaemon.runAccountSwitchMutation(fn)`, `RouteDaemon.resetAccountCaches()`, and retryable proxy handling for `AccountSwitchingError`.

- [ ] **Step 1: Add failing executor and daemon concurrency tests**

Add to `executor.test.ts`:

```ts
test("account reset deletes only recorded managed pool keys and clears local entries", async () => {
	h = poolHarness(2);
	await h.executor.ensureKey(1);
	await h.executor.ensureKey(2);
	h.mock.keys.set(999, { id: 999, name: "manual", key: "sk-manual", group_id: 1 });
	expect(await h.executor.clearManagedKeysForAccountSwitch()).toEqual({ orphanedKeyIds: [] });
	expect(h.state.pool).toEqual({});
	expect([...h.mock.keys.keys()]).toEqual([999]);
});
```

Add to `integration.test.ts` using a small barrier:

```ts
test("routes receive retryable 503 during an account commit window", async () => {
	h = createHarness({ withServer: true });
	let enter!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => { enter = resolve; });
	const blocked = new Promise<void>((resolve) => { release = resolve; });
	const mutation = h.daemon.runAccountSwitchMutation(async () => {
		enter();
		await blocked;
	});
	await entered;
	const response = await fetch(`${h.serverUrl}/v1/models`);
	expect(response.status).toBe(503);
	expect(response.headers.get("retry-after")).toBe("1");
	release();
	await mutation;
});
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `bun test apps/router/tests/executor.test.ts apps/router/tests/integration.test.ts -t "account reset|account commit"`

Expected: FAIL because the switch primitives do not exist.

- [ ] **Step 3: Add serialized executor cleanup**

In `RouteExecutor`, add:

```ts
hasAccountActivity(): boolean {
	return this.creating.size > 0 ||
		this.reservations.size > 0 ||
		(this.deps.hardProtectedGroupIds?.().size ?? 0) > 0;
}

clearManagedKeysForAccountSwitch(): Promise<{ orphanedKeyIds: number[] }> {
	return this.serializePool(async () => {
		if (this.hasAccountActivity()) throw new AccountSwitchBusyError();
		const orphanedKeyIds: number[] = [];
		for (const [groupId, entry] of Object.entries(this.deps.state.pool)) {
			try {
				await this.deps.client.deleteKey(entry.keyId);
			} catch (error) {
				orphanedKeyIds.push(entry.keyId);
				this.deps.logger.warn(
					`账号切换清理失败，已丢弃本地池记录:keyId=${entry.keyId} ${error instanceof Error ? error.message : ""}`,
				);
			}
			delete this.deps.state.pool[groupId];
		}
		return { orphanedKeyIds };
	});
}
```

Import `AccountSwitchBusyError` from `account-errors.ts`. Do not call
`persistState()` inside this method; the account transaction persists matching
owner tags and cleared state together.

- [ ] **Step 4: Add the daemon gate and proxy-specific retry response**

In `RouteDaemon`, add an `accountSwitching` flag and:

```ts
runAccountSwitchMutation<T>(fn: () => Promise<T>): Promise<T> {
	return this.serializeControlMutation(async () => {
		this.accountSwitching = true;
		try {
			if (
				this.deps.traffic.activeGroupIds().size > 0 ||
				this.deps.executor.hasAccountActivity()
			) throw new AccountSwitchBusyError();
			return await fn();
		} finally {
			this.accountSwitching = false;
		}
	});
}

resetAccountCaches(): void {
	this.allowedGroupIds = undefined;
	this.userRates = undefined;
	this.lastRound = undefined;
	this.routeLocks.clear();
}
```

At the beginning of `route()`:

```ts
if (this.accountSwitching) throw new AccountSwitchingError();
```

In `proxy.ts`, allow `errorResponse` to accept extra headers and handle the
typed error in both initial and retry route catches:

```ts
if (err instanceof AccountSwitchingError) {
	const response = errorResponse(503, err.message);
	response.headers.set("Retry-After", "1");
	return response;
}
```

- [ ] **Step 5: Run focused and regression tests**

Run: `bun test apps/router/tests/executor.test.ts apps/router/tests/integration.test.ts`

Expected: all tests PASS.

Run: `bunx tsc --noEmit -p tsconfig.json`

Expected: exit code 0.

- [ ] **Step 6: Commit the concurrency boundary**

```bash
git add apps/router/src/executor.ts apps/router/src/daemon.ts apps/router/src/proxy.ts apps/router/tests/executor.test.ts apps/router/tests/integration.test.ts
git commit -m "feat: gate routing during account switches"
```

### Task 3: Account Switch Service

**Files:**
- Create: `apps/router/src/account-switch.ts`
- Create: `apps/router/tests/account-switch.test.ts`

**Interfaces:**
- Consumes: shared AIHub client, a candidate-client factory, state, credentials, executor/daemon primitives, persistence callbacks, logger, and Sentry identity callback.
- Produces: `AccountLoginInput`, `AccountSwitchResult`, `AccountSwitchService.login(input)`, and serialized same/different-account behavior.

- [ ] **Step 1: Write failing service tests for validation, same account, switching, and busy traffic**

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { AIHubClient } from "@aihub-auto/core";
import { AccountSwitchBusyError } from "../src/account-errors.ts";
import { AccountSwitchService } from "../src/account-switch.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("AIHub account switch service", () => {
	let h: Harness;
	afterEach(() => h?.dispose());

	function service(): AccountSwitchService {
		return new AccountSwitchService({
			client: h.client,
			createClient: (token) => new AIHubClient({ baseUrl: h.mock.url, token: () => token }),
			state: h.state,
			credentials: h.credentials,
			executor: h.executor,
			daemon: h.daemon,
			logger: h.logger,
			persistState: h.persistState,
			persistCredentials: h.persistCredentials,
			syncSentryUser: () => {},
		});
	}

	test("same identity refreshes credentials without clearing continuity", async () => {
		h = createHarness();
		h.credentials.accountIdentity = "id:account-1";
		h.state.accountIdentity = "id:account-1";
		await h.executor.ensureKey(1);
		h.affinity.bind("session", 1);
		const result = await service().login({ token: "mock-at-2" });
		expect(result.switched).toBe(false);
		expect(h.state.pool["1"]).toBeDefined();
		expect(h.affinity.resolve("session")).toBe(1);
	});

	test("different identity clears old account state and keeps the new credential", async () => {
		h = createHarness();
		h.credentials.accountIdentity = "id:account-1";
		h.state.accountIdentity = "id:account-1";
		h.credentials.singleKeySk = "sk-old-single";
		await h.executor.ensureKey(1);
		h.affinity.bind("session", 1);
		h.state.modelBlocks.model = { "1": Date.now() + 60_000 };
		const result = await service().login({ token: "account-two-token" });
		expect(result).toMatchObject({ switched: true, email: "second@test.local" });
		expect(h.credentials.accessToken).toBe("account-two-token");
		expect(h.credentials.singleKeySk).toBeUndefined();
		expect(h.state.sessions).toEqual({});
		expect(h.state.modelBlocks).toEqual({});
		expect(Object.values(h.state.pool).every((entry) => entry.sk !== "sk-old-single"))
			.toBe(true);
	});

	test("active traffic rejects switching before credentials mutate", async () => {
		h = createHarness();
		const oldToken = h.credentials.accessToken;
		h.traffic.begin(1);
		await expect(service().login({ token: "account-two-token" }))
			.rejects.toBeInstanceOf(AccountSwitchBusyError);
		expect(h.credentials.accessToken).toBe(oldToken);
		h.traffic.end(1);
	});

	test("persistence failure restores the previous in-memory credential", async () => {
		h = createHarness();
		h.credentials.accountIdentity = "id:account-1";
		h.state.accountIdentity = "id:account-1";
		const oldToken = h.credentials.accessToken;
		const failing = new AccountSwitchService({
			client: h.client,
			createClient: (token) => new AIHubClient({ baseUrl: h.mock.url, token: () => token }),
			state: h.state,
			credentials: h.credentials,
			executor: h.executor,
			daemon: h.daemon,
			logger: h.logger,
			persistState: h.persistState,
			persistCredentials: async () => { throw new Error("disk full"); },
			syncSentryUser: () => {},
		});
		await expect(failing.login({ token: "account-two-token" })).rejects.toThrow("disk full");
		expect(h.credentials.accessToken).toBe(oldToken);
		expect(h.credentials.accountIdentity).toBe("id:account-1");
	});
});
```

Expose `logger`, `persistState`, and `persistCredentials` on the test `Harness`
so the service test uses the same persistence path as the server. Initialize a
logged-in harness with `accountIdentity: "id:account-1"` so existing tests model
the startup-aligned production state without changing displayed email behavior.

- [ ] **Step 2: Run the service tests and verify they fail**

Run: `bun test apps/router/tests/account-switch.test.ts`

Expected: FAIL because `AccountSwitchService` and the second mock account do not exist.

- [ ] **Step 3: Implement serialized candidate validation and replacement**

Create `account-switch.ts`:

```ts
import type { AIHubClient, AuthSession } from "@aihub-auto/core";
import {
	deriveAccountIdentity,
	legacyCredentialIdentity,
	profileEmail,
	resetAccountScopedState,
} from "./account-state.ts";
import type { AppState, Credentials } from "./config.ts";
import type { RouteDaemon } from "./daemon.ts";
import type { RouteExecutor } from "./executor.ts";
import type { Logger } from "./logger.ts";

export type AccountLoginInput =
	| { token: string }
	| { email: string; password: string };

export interface AccountSwitchResult {
	ok: true;
	switched: boolean;
	email?: string;
}

export interface AccountSwitchDeps {
	client: AIHubClient;
	createClient: (accessToken: string) => AIHubClient;
	state: AppState;
	credentials: Credentials;
	executor: RouteExecutor;
	daemon: RouteDaemon;
	logger: Logger;
	persistState: () => Promise<void>;
	persistCredentials: () => Promise<void>;
	syncSentryUser: (email?: string) => void;
}

export class AccountSwitchService {
	private mutation: Promise<unknown> = Promise.resolve();
	constructor(private readonly deps: AccountSwitchDeps) {}

	login(input: AccountLoginInput): Promise<AccountSwitchResult> {
		const run = this.mutation.then(() => this.loginLocked(input), () => this.loginLocked(input));
		this.mutation = run.then(() => undefined, () => undefined);
		return run;
	}

	private async candidate(input: AccountLoginInput): Promise<AuthSession> {
		if ("token" in input) {
			const accessToken = input.token.trim();
			if (!accessToken) throw new Error("Access Token 不能为空");
			return { accessToken };
		}
		if (!input.email.trim() || !input.password) throw new Error("需要 email+password 或 token");
		return this.deps.client.login(input.email, input.password);
	}

	private async loginLocked(input: AccountLoginInput): Promise<AccountSwitchResult> {
		const session = await this.candidate(input);
		const profile = await this.deps.createClient(session.accessToken).me();
		const identity = deriveAccountIdentity(profile, session.accessToken);
		const email = profileEmail(profile, "email" in input ? input.email : "");
		const previousIdentity = legacyCredentialIdentity(this.deps.credentials);
		const switched = Boolean(this.deps.credentials.accessToken && previousIdentity !== identity);

		const previousCredentials = { ...this.deps.credentials };
		const previousState = structuredClone(this.deps.state);
		try {
			if (switched) {
				await this.deps.daemon.runAccountSwitchMutation(async () => {
					await this.deps.executor.clearManagedKeysForAccountSwitch();
					resetAccountScopedState(this.deps.state, this.deps.credentials, identity);
					this.applySession(session, identity, email);
					this.deps.daemon.resetAccountCaches();
					await this.deps.persistState();
					await this.deps.persistCredentials();
				});
			} else {
				this.applySession(session, identity, email);
				this.deps.state.accountIdentity ??= identity;
				await this.deps.persistCredentials();
				await this.deps.persistState();
				this.deps.daemon.resetAccountCaches();
			}
		} catch (error) {
			for (const key of Object.keys(this.deps.credentials)) {
				delete this.deps.credentials[key as keyof Credentials];
			}
			Object.assign(this.deps.credentials, previousCredentials);
			for (const key of Object.keys(this.deps.state)) {
				delete this.deps.state[key as keyof AppState];
			}
			Object.assign(this.deps.state, previousState);
			// Remote cleanup may already have deleted old managed keys. Never restore
			// their stale local sk values; the old account recreates them lazily.
			this.deps.state.pool = {};
			this.deps.daemon.resetAccountCaches();
			throw error;
		}

		this.deps.daemon.needsReauth = false;
		this.deps.syncSentryUser(email);
		await this.deps.daemon.runOnce().catch((error) =>
			this.deps.logger.warn(`账号已保存，立即刷新失败，将由守护轮重试:${error instanceof Error ? error.message : String(error)}`),
		);
		return { ok: true, switched, ...(email ? { email } : {}) };
	}

	private applySession(session: AuthSession, identity: string, email?: string): void {
		const credentials = this.deps.credentials;
		credentials.accessToken = session.accessToken;
		credentials.accountIdentity = identity;
		if (email) credentials.email = email;
		else delete credentials.email;
		if (session.refreshToken) credentials.refreshToken = session.refreshToken;
		else delete credentials.refreshToken;
		if (session.expiresAt !== undefined) credentials.expiresAt = session.expiresAt;
		else delete credentials.expiresAt;
	}
}
```

- [ ] **Step 4: Add the second mock identity and make key ownership account-aware**

Extend `MockKey` with `ownerId?: string` and add:

```ts
accounts = new Map([
	["mock-at", { id: "account-1", email: "mock@test.local" }],
	["mock-at-2", { id: "account-1", email: "mock@test.local" }],
	["manual-token", { id: "account-2", email: "second@test.local" }],
	["account-two-token", { id: "account-2", email: "second@test.local" }],
]);

private accountFor(auth?: string): { id: string; email: string } | undefined {
	return this.accounts.get((auth ?? "").replace(/^Bearer\s+/i, ""));
}
```

Return the selected account from `/auth/me`; filter list responses and authorize
key mutation by `ownerId`; set `ownerId` when creating a key. Treat missing
`ownerId` on test-inserted keys as `account-1` for backward compatibility.

- [ ] **Step 5: Run service, executor, and type tests**

Run: `bun test apps/router/tests/account-switch.test.ts apps/router/tests/executor.test.ts`

Expected: all tests PASS.

Run: `bunx tsc --noEmit -p tsconfig.json`

Expected: exit code 0.

- [ ] **Step 6: Commit the service**

```bash
git add apps/router/src/account-switch.ts apps/router/tests/account-switch.test.ts apps/router/tests/harness.ts apps/router/tests/mock-upstream.ts
git commit -m "feat: add atomic AIHub account switch service"
```

### Task 4: Server, Runtime, and UI Wiring

**Files:**
- Modify: `apps/router/src/server.ts`
- Modify: `apps/router/src/main.ts`
- Modify: `apps/router/src/ui.ts`
- Modify: `apps/router/tests/harness.ts`
- Modify: `apps/router/tests/integration.test.ts`

**Interfaces:**
- Consumes: `AccountSwitchService.login()` from Task 3.
- Produces: a validated `/ctl/login` boundary, `409` busy mapping, `{switched,email}` UI feedback, and a candidate client using the same outbound transport as production traffic.

- [ ] **Step 1: Add failing end-to-end switch assertions**

Replace the direct-token login assertions in the control API integration test
with:

```ts
const originalProxyToken = h.config.proxyToken;
await h.executor.ensureKey(1);
const oldSk = h.state.pool["1"]!.sk;
h.affinity.bind("old-session", 1);
h.credentials.refreshToken = "stale-account-refresh";
const tokenLoginRes = await fetch(`${base}/ctl/login`, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ token: "account-two-token" }),
});
expect(tokenLoginRes.status).toBe(200);
expect(await tokenLoginRes.json()).toMatchObject({
	ok: true,
	switched: true,
	email: "second@test.local",
});
expect(h.credentials.accessToken).toBe("account-two-token");
expect(h.credentials.refreshToken).toBeUndefined();
expect(h.credentials.email).toBe("second@test.local");
expect(h.affinity.resolve("old-session")).toBeUndefined();
expect(Object.values(h.state.pool).every((entry) => entry.sk !== oldSk)).toBe(true);
expect(h.config.proxyToken).toBe(originalProxyToken);
```

Add a busy case that calls `h.traffic.begin(1)`, expects HTTP `409`, then checks
the old access token is unchanged before calling `h.traffic.end(1)`.

- [ ] **Step 2: Run the integration case and verify it fails**

Run: `bun test apps/router/tests/integration.test.ts -t "control API|账号"`

Expected: FAIL because `/ctl/login` still mutates `deps.credentials` directly.

- [ ] **Step 3: Add the service to runtime dependency graphs**

Add `accountSwitcher: AccountSwitchService` to `ServerDeps`. In `main.ts`, use
one factory so candidate and shared clients use identical transport settings:

```ts
const createAIHubClient = (token: () => string | undefined) =>
	new AIHubClient({ baseUrl: config.baseUrl, token, fetch: fetchUpstream });
const client = createAIHubClient(() => credentials.accessToken);
```

After executor and daemon creation, construct:

```ts
const accountSwitcher = new AccountSwitchService({
	client,
	createClient: (accessToken) => createAIHubClient(() => accessToken),
	state,
	credentials,
	executor,
	daemon,
	logger,
	persistState,
	persistCredentials,
	syncSentryUser,
});
```

Pass it into `createServer`. Mirror the same construction in `harness.ts` and
expose it as `h.accountSwitcher`.

- [ ] **Step 4: Replace direct `/ctl/login` mutation with service delegation**

Parse the existing request body, then use:

```ts
try {
	const input = body.token
		? { token: body.token }
		: body.email && body.password
			? { email: body.email, password: body.password }
			: undefined;
	if (!input) return json({ error: "需要 email+password 或 token" }, 400);
	return json(await deps.accountSwitcher.login(input));
} catch (error) {
	if (error instanceof AccountSwitchBusyError) {
		return json({ code: "ACCOUNT_SWITCH_BUSY", error: error.message }, 409);
	}
	return json({ error: error instanceof Error ? error.message : "登录失败" }, 400);
}
```

Remove the previous credential snapshot/mutate/rollback block.

- [ ] **Step 5: Update UI result copy without changing the client key**

Change both login button handlers to retain the returned result:

```js
const result=await api("/ctl/login",{method:"POST",body:JSON.stringify(payload)});
toast(result.switched?"账号已切换，客户端 API Key 无需修改":"登录信息已更新");
```

Keep `renderProxyToken()` and every `proxyToken` setting unchanged.

- [ ] **Step 6: Run integration and full router tests**

Run: `bun test apps/router/tests/account-switch.test.ts apps/router/tests/integration.test.ts`

Expected: all tests PASS.

Run: `bun test apps/router/tests/proxy.test.ts apps/router/tests/executor.test.ts`

Expected: all tests PASS.

Run: `bunx tsc --noEmit -p tsconfig.json`

Expected: exit code 0.

- [ ] **Step 7: Commit runtime wiring**

```bash
git add apps/router/src/server.ts apps/router/src/main.ts apps/router/src/ui.ts apps/router/tests/harness.ts apps/router/tests/integration.test.ts
git commit -m "feat: hot-switch AIHub accounts without client changes"
```

### Task 5: Startup Ownership Recovery

**Files:**
- Modify: `apps/router/src/main.ts`
- Modify: `apps/router/tests/startup.test.ts`

**Interfaces:**
- Consumes: `alignAccountStateOwner()` from Task 1.
- Produces: startup adoption for legacy state and clearing for verified owner mismatches before executor reconciliation or daemon start.

- [ ] **Step 1: Add a failing startup alignment test around the pure helper**

Add to `startup.test.ts`:

```ts
test("verified startup identity clears state owned by another account", () => {
	const state = StateSchema.parse({
		accountIdentity: "id:old-account",
		pool: { "1": { keyId: 1, sk: "sk-old", lastUsedAt: 1 } },
	});
	const credentials: Credentials = {
		accessToken: "new-token",
		accountIdentity: "id:old-account",
	};
	const result = alignAccountStateOwner(
		state,
		credentials,
		{ id: "new-account", email: "new@example.com" },
	);
	expect(result.reset).toBe(true);
	expect(state.pool).toEqual({});
	expect(state.accountIdentity).toBe("id:new-account");
});
```

- [ ] **Step 2: Run the startup test and confirm the new runtime behavior is not wired**

Run: `bun test apps/router/tests/startup.test.ts`

Expected: the pure assertion passes after Task 1, while source inspection still
shows no `alignAccountStateOwner` call in `main.ts`.

- [ ] **Step 3: Align and persist ownership during the existing profile refresh**

In `refreshSentryIdentity`, after `const me = await client.me()`, call:

```ts
const ownership = alignAccountStateOwner(state, credentials, me);
if (ownership.reset) {
	logger.warn("检测到 AIHub 账号状态归属变化，已清空旧账号本地 Key 与会话");
}
await store.write("credentials.json", credentials);
await store.write("state.json", state);
syncSentryUser(credentials.email);
```

Remove duplicate email parsing in that function. This call already runs before
executor creation and before daemon/reconciliation startup, so old pool `sk`
values cannot be selected first.

- [ ] **Step 4: Run startup, account, and type tests**

Run: `bun test apps/router/tests/startup.test.ts apps/router/tests/account-state.test.ts apps/router/tests/account-switch.test.ts`

Expected: all tests PASS.

Run: `bunx tsc --noEmit -p tsconfig.json`

Expected: exit code 0.

- [ ] **Step 5: Commit startup recovery**

```bash
git add apps/router/src/main.ts apps/router/tests/startup.test.ts
git commit -m "fix: clear mismatched account state at startup"
```

### Task 6: Documentation and End-to-End Verification

**Files:**
- Modify: `README.md`
- Modify: `apps/router/README.md`
- Modify: `docs/superpowers/specs/2026-08-09-seven-day-ui-auth-account-switch-design.md` only if implementation names require a factual correction.

**Interfaces:**
- Consumes: completed account switch service and stable proxy authentication.
- Produces: accurate operating guidance and full regression evidence.

- [ ] **Step 1: Document the two key layers and no-restart switch behavior**

Add:

```md
客户端始终使用路由器的 `proxyToken`，不要填写 AIHub 账号内部生成的 `sk`。
在控制台登录另一个 AIHub 账号后，路由器会清理旧账号的本地自动 Key 和会话，
随后为新账号按需创建 Key；客户端配置不变，也不需要重启路由器。仍有模型请求
运行时，账号切换会提示稍后重试。
```

- [ ] **Step 2: Run source/document consistency checks**

Run: `rg -n "accountIdentity|AccountSwitchService|ACCOUNT_SWITCH_BUSY|客户端 API Key 无需修改|不需要重启" apps/router/src apps/router/tests README.md apps/router/README.md`

Expected: owner tags, service wiring, server/UI messages, tests, and both operator docs are represented.

Run: `git diff --check`

Expected: exit code 0.

- [ ] **Step 3: Run all automated tests and builds**

Run: `bun test`

Expected: all Bun tests PASS.

Run: `bunx tsc --noEmit -p tsconfig.json`

Expected: exit code 0.

Run: `bun run scripts/build.ts`

Expected: all configured router targets build successfully.

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`

Expected: all Rust tests PASS.

- [ ] **Step 4: Perform an API-level two-account smoke test**

Using the account-aware mock or a local test server, verify this sequence:

```text
1. Authenticate /ctl and record the displayed client proxyToken.
2. Route one model request under account 1 and record its managed key owner.
3. POST /ctl/login with account 2 while idle.
4. Confirm the response says switched=true and the UI shows account 2.
5. Route another model request and confirm the upstream key belongs to account 2.
6. Confirm the client Authorization header still uses the original proxyToken.
7. Repeat while a stream is active and confirm HTTP 409 leaves account 1 active.
```

Expected: no old-account `sk` is reused, no restart occurs, and the client key
is unchanged.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md apps/router/README.md
git commit -m "docs: explain AIHub account hot switching"
```
