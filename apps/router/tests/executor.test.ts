import { afterEach, describe, expect, test } from "bun:test";
import { createHarness, type Harness } from "./harness.ts";

let h: Harness;
afterEach(() => h?.dispose());

describe("executor 模式 single", () => {
	test("首次 switchTo 自动选 Key、PUT 切组、缓存 sk", async () => {
		h = createHarness({ configPatch: { keyMode: "single" } });
		h.mock.keys.set(11, {
			id: 11,
			name: "我的Key",
			key: "sk-user-11",
			group_id: 5,
		});
		const key = await h.executor.switchTo(9);
		expect(key.groupId).toBe(9);
		expect(key.sk).toBe("sk-user-11");
		expect(h.mock.keys.get(11)!.group_id).toBe(9);
		expect(h.credentials.singleKeySk).toBe("sk-user-11");
		expect(h.state.currentGroupId).toBe(9);
		// currentKey 反映最新
		expect(h.executor.currentKey()).toMatchObject({
			sk: "sk-user-11",
			groupId: 9,
		});
	});

	test("无任何 Key 时报清晰错误", async () => {
		h = createHarness({ configPatch: { keyMode: "single" } });
		expect(h.executor.switchTo(9)).rejects.toThrow(/没有可用 API Key/);
	});

	test("token 过期 → 自动 refresh → 重试成功", async () => {
		h = createHarness({ configPatch: { keyMode: "single" } });
		h.mock.keys.set(11, { id: 11, name: "k", key: "sk-user-11", group_id: 5 });
		h.mock.expireToken = true;
		const key = await h.executor.switchTo(7);
		expect(key.groupId).toBe(7);
		expect(h.mock.refreshCalls).toBe(1);
	});
});

describe("executor 模式 pool", () => {
	function poolHarness(poolMaxGroups = 3, cacheIdleMs = 0): Harness {
		return createHarness({
			configPatch: {
				keyMode: "pool",
				poolMaxGroups,
				decision: {
					stickiness: 0.1,
					cachePenaltyMax: 0.25,
					cacheIdleMs,
					minDwellMs: 0,
				},
			},
		});
	}

	test("首次切组自动建 aihub-auto-g{gid} Key;二次复用", async () => {
		h = poolHarness();
		const k1 = await h.executor.switchTo(5);
		expect(k1.sk).toStartWith("sk-mock-");
		const created = [...h.mock.keys.values()].find(
			(k) => k.name === "aihub-auto-g5",
		);
		expect(created).toBeDefined();
		expect(created!.group_id).toBe(5);

		const countAfterFirst = h.mock.keys.size;
		const k2 = await h.executor.switchTo(5);
		expect(k2.sk).toBe(k1.sk);
		expect(h.mock.keys.size).toBe(countAfterFirst); // 未重复创建
	});

	test("ensureKey 同组并发只创建一次且不改变默认组", async () => {
		h = poolHarness();
		const keys = await Promise.all([
			h.executor.ensureKey(5),
			h.executor.ensureKey(5),
			h.executor.ensureKey(5),
		]);
		expect(new Set(keys.map((key) => key.sk)).size).toBe(1);
		expect(h.state.currentGroupId).toBeUndefined();
		expect(
			h.mock.requestLog.filter(
				(request) =>
					request.method === "POST" && request.path === "/api/v1/keys",
			),
		).toHaveLength(1);
	});

	test("LRU 逐出:超过上限删最久未用,当前组受保护", async () => {
		h = poolHarness(2);
		await h.executor.switchTo(1);
		await Bun.sleep(5);
		await h.executor.switchTo(2);
		await Bun.sleep(5);
		await h.executor.switchTo(3); // 触发逐出 group1
		const names = [...h.mock.keys.values()].map((k) => k.name).sort();
		expect(names).toEqual(["aihub-auto-g2", "aihub-auto-g3"]);
		expect(Object.keys(h.state.pool).sort()).toEqual(["2", "3"]);
	});

	test("缓存窗口不让无亲和 Key 突破池上限", async () => {
		h = poolHarness(1, 60_000);
		await h.executor.ensureKey(1);
		await h.executor.ensureKey(2);
		expect(Object.keys(h.state.pool)).toEqual(["2"]);
	});

	test("近期缓存亲和允许池短暂软超限", async () => {
		h = poolHarness(1, 60_000);
		await h.executor.ensureKey(1);
		h.affinity.bind("session", 1);
		await h.executor.ensureKey(2);
		expect(Object.keys(h.state.pool).sort()).toEqual(["1", "2"]);
	});

	test("手动锁定 Key 受普通 LRU 软保护,强无效回收后仍保留锁定意图", async () => {
		h = poolHarness(1);
		h.state.manualLock = { groupId: 1, revision: 1 };
		await h.executor.ensureKey(1);
		await h.executor.ensureKey(2);
		expect(Object.keys(h.state.pool).sort()).toEqual(["1", "2"]);
		h.state.pool["1"]!.lastUsedAt = 0;
		expect(await h.executor.trimPool(new Set([1]))).toBe(1);
		expect(h.state.pool["1"]).toBeUndefined();
		expect(h.state.manualLock).toEqual({ groupId: 1, revision: 1 });
	});

	test("缓存窗口结束后回收旧 Key,但保留会话映射供按需重建", async () => {
		h = poolHarness(1, 60_000);
		await h.executor.ensureKey(1);
		h.affinity.bind("session", 1);
		await h.executor.ensureKey(2);
		const expiredAt = Date.now() - 60_001;
		h.state.pool["1"]!.lastUsedAt = expiredAt;
		Object.values(h.state.sessions)[0]!.lastUsedAt = expiredAt;

		expect(await h.executor.trimPool()).toBe(1);
		expect(Object.keys(h.state.pool)).toEqual(["2"]);
		expect(h.affinity.resolve("session")).toBe(1);
		expect([...h.mock.keys.values()].map((key) => key.name)).toEqual([
			"aihub-auto-g2",
		]);
	});

	test("强无效闲置组越过会话软保护回收并清理 Responses 亲和", async () => {
		h = poolHarness(3);
		await h.executor.ensureKey(1);
		await h.executor.ensureKey(2);
		h.affinity.bind("session-1", 1);
		h.affinity.bindResponse("resp_1", "session-1", 1);
		h.state.pool["1"]!.lastUsedAt = 0;

		expect(await h.executor.trimPool(new Set([1]))).toBe(1);
		expect(h.state.pool["1"]).toBeUndefined();
		expect(h.affinity.resolve("session-1")).toBeUndefined();
		expect(h.affinity.resolveResponse("resp_1")).toBeUndefined();
		expect(h.state.pool["2"]).toBeDefined();
	});

	test("在飞组即使强无效也必须等请求结束才能回收", async () => {
		h = poolHarness(3);
		await h.executor.ensureKey(1);
		h.state.pool["1"]!.lastUsedAt = 0;
		h.traffic.begin(1);

		expect(await h.executor.trimPool(new Set([1]))).toBe(0);
		expect(h.state.pool["1"]).toBeDefined();
		h.traffic.end(1);
		expect(await h.executor.trimPool(new Set([1]))).toBe(1);
		expect(h.state.pool["1"]).toBeUndefined();
	});

	test("对账:保留其他实例的未知前缀 Key,清理本地失效记录", async () => {
		h = poolHarness();
		// 远端孤儿(前缀但 state 不认识)
		h.mock.keys.set(91, {
			id: 91,
			name: "aihub-auto-g99",
			key: "sk-orphan",
			group_id: 99,
		});
		// 用户自己的 Key(非前缀)
		h.mock.keys.set(92, {
			id: 92,
			name: "my-precious",
			key: "sk-user",
			group_id: 1,
		});
		// state 记录但远端已删
		h.state.pool["77"] = { keyId: 777, sk: "sk-gone", lastUsedAt: Date.now() };

		await h.executor.reconcile();

		expect(h.mock.keys.has(91)).toBe(true); // 可能属于同账号另一实例
		expect(h.mock.keys.has(92)).toBe(true); // 用户 Key 不动
		expect(h.state.pool["77"]).toBeUndefined(); // 失效记录清理
	});

	test("上游拒绝旧 sk 时 CAS 作废并重建,旧请求不能删新 Key", async () => {
		h = poolHarness();
		const old = await h.executor.acquireKey(1);
		old.release?.();
		const oldEntry = { ...h.state.pool["1"]! };

		expect(await h.executor.invalidatePoolKey(1, "sk-other")).toBe(false);
		expect(h.state.pool["1"]?.keyId).toBe(oldEntry.keyId);
		const invalidations = await Promise.all(
			Array.from({ length: 8 }, () => old.invalidateCredential!()),
		);
		expect(invalidations.filter(Boolean)).toHaveLength(1);
		expect(h.state.pool["1"]).toBeUndefined();

		const refreshed = await Promise.all(
			Array.from({ length: 8 }, () => h.executor.ensureKey(1)),
		);
		expect(new Set(refreshed.map((key) => key.sk)).size).toBe(1);
		const fresh = refreshed[0]!;
		expect(fresh.sk).not.toBe(old.sk);
		expect(h.state.pool["1"]?.keyId).not.toBe(oldEntry.keyId);
		expect(await old.invalidateCredential?.()).toBe(false);
		expect(h.state.pool["1"]?.sk).toBe(fresh.sk);
	});

	test("cleanup 删除全部自建 Key", async () => {
		h = poolHarness();
		await h.executor.switchTo(1);
		await h.executor.switchTo(2);
		h.mock.keys.set(92, {
			id: 92,
			name: "my-precious",
			key: "sk-user",
			group_id: 1,
		});
		await h.executor.cleanup();
		expect([...h.mock.keys.values()].map((k) => k.name)).toEqual([
			"my-precious",
		]);
		expect(Object.keys(h.state.pool)).toHaveLength(0);
	});

	test("account reset deletes only recorded managed pool keys and clears local entries", async () => {
		h = poolHarness(2);
		await h.executor.ensureKey(1);
		await h.executor.ensureKey(2);
		h.mock.keys.set(999, {
			id: 999,
			name: "manual",
			key: "sk-manual",
			group_id: 1,
		});

		expect(await h.executor.clearManagedKeysForAccountSwitch()).toEqual({
			orphanedKeyIds: [],
		});
		expect(h.state.pool).toEqual({});
		expect([...h.mock.keys.keys()]).toEqual([999]);
	});

	test("failed victim is detached, queued without sk, and does not block later victims", async () => {
		h = poolHarness(3);
		await h.executor.ensureKey(1);
		await h.executor.ensureKey(2);
		await h.executor.ensureKey(3);
		const first = h.state.pool["1"]!;
		const second = h.state.pool["2"]!;
		first.lastUsedAt = 0;
		second.lastUsedAt = 1;
		h.mock.deleteKeyFailures.set(first.keyId, {
			status: 503,
			remaining: 1,
		});

		expect(await h.executor.trimPool(new Set([1, 2]))).toBe(2);
		expect(h.state.pool["1"]).toBeUndefined();
		expect(h.state.pool["2"]).toBeUndefined();
		expect(h.state.pendingPoolDeletes[String(first.keyId)]).toMatchObject({
			keyId: first.keyId,
			groupId: 1,
			accountIdentity: "id:account-1",
			attempts: 1,
			lastErrorCode: "upstream",
		});
		const serialized = JSON.parse(
			await Bun.file(`${h.configDir}/state.json`).text(),
		) as { pendingPoolDeletes: Record<string, Record<string, unknown>> };
		expect(serialized.pendingPoolDeletes[String(first.keyId)]).not.toHaveProperty(
			"sk",
		);
		expect(h.mock.keys.has(second.keyId)).toBe(false);
	});

	test("pending delete retries with backoff and removes after success", async () => {
		h = poolHarness(2);
		await h.executor.ensureKey(1);
		const entry = h.state.pool["1"]!;
		h.state.pool["1"]!.lastUsedAt = 0;
		h.mock.deleteKeyFailures.set(entry.keyId, {
			status: 503,
			remaining: 2,
		});
		await h.executor.trimPool(new Set([1]));
		const pending = h.state.pendingPoolDeletes[String(entry.keyId)]!;
		expect(pending.attempts).toBe(1);
		const now = Date.now();
		pending.nextRetryAt = now;
		await h.executor.retryPendingPoolDeletes(now);
		expect(h.state.pendingPoolDeletes[String(entry.keyId)]?.attempts).toBe(2);
		h.state.pendingPoolDeletes[String(entry.keyId)]!.nextRetryAt = now;
		await h.executor.retryPendingPoolDeletes(now);
		expect(h.state.pendingPoolDeletes[String(entry.keyId)]).toBeUndefined();
		expect(h.mock.keys.has(entry.keyId)).toBe(false);
	});

	test("remote not-found delete is idempotent success", async () => {
		h = poolHarness(2);
		await h.executor.ensureKey(1);
		const entry = h.state.pool["1"]!;
		h.mock.keys.delete(entry.keyId);
		h.state.pool["1"]!.lastUsedAt = 0;
		expect(await h.executor.trimPool(new Set([1]))).toBe(1);
		expect(h.state.pendingPoolDeletes[String(entry.keyId)]).toBeUndefined();
		expect(h.state.pool["1"]).toBeUndefined();
	});

	test("pending deletes stay owned by the old account", async () => {
		h = poolHarness(2);
		await h.executor.ensureKey(1);
		const entry = h.state.pool["1"]!;
		h.mock.deleteKeyFailures.set(entry.keyId, { status: 503, remaining: 1 });
		const oldToken = h.credentials.accessToken;
		await h.executor.clearManagedKeysForAccountSwitch();
		expect(h.state.pendingPoolDeletes[String(entry.keyId)]?.accountIdentity).toBe(
			"id:account-1",
		);
		h.credentials.accessToken = "account-two-token";
		h.credentials.accountIdentity = "id:account-2";
		h.state.accountIdentity = "id:account-2";
		h.state.pendingPoolDeletes[String(entry.keyId)]!.nextRetryAt = 0;
		await h.executor.retryPendingPoolDeletes(0);
		expect(h.mock.keys.has(entry.keyId)).toBe(true);
		h.credentials.accessToken = oldToken;
		h.credentials.accountIdentity = "id:account-1";
		h.state.accountIdentity = "id:account-1";
		await h.executor.retryPendingPoolDeletes(0);
		expect(h.mock.keys.has(entry.keyId)).toBe(false);
		expect(h.state.pendingPoolDeletes[String(entry.keyId)]).toBeUndefined();
	});

	test("pending delete retry processes at most eight due entries per pass", async () => {
		h = poolHarness();
		for (let keyId = 101; keyId <= 110; keyId++) {
			h.mock.keys.set(keyId, {
				id: keyId,
				name: `aihub-auto-g${keyId}`,
				key: `sk-test-${keyId}`,
				group_id: keyId,
			});
			h.state.pendingPoolDeletes[String(keyId)] = {
				keyId,
				groupId: keyId,
				accountIdentity: "id:account-1",
				attempts: 1,
				nextRetryAt: 0,
				queuedAt: keyId,
				lastErrorCode: "upstream",
			};
		}

		expect(await h.executor.retryPendingPoolDeletes(1_000)).toBe(8);
		expect(Object.keys(h.state.pendingPoolDeletes).sort()).toEqual([
			"109",
			"110",
		]);
		expect(h.mock.keys.has(109)).toBe(true);
		expect(h.mock.keys.has(110)).toBe(true);
	});

	test("pending delete attempts saturate at 31 with one-hour backoff", async () => {
		h = poolHarness();
		const keyId = 777;
		h.mock.keys.set(keyId, {
			id: keyId,
			name: "aihub-auto-g7",
			key: "sk-test-777",
			group_id: 7,
		});
		h.mock.deleteKeyFailures.set(keyId, { status: 503, remaining: 1 });
		h.state.pendingPoolDeletes[String(keyId)] = {
			keyId,
			groupId: 7,
			accountIdentity: "id:account-1",
			attempts: 31,
			nextRetryAt: 0,
			queuedAt: 0,
			lastErrorCode: "upstream",
		};

		await h.executor.retryPendingPoolDeletes(1_000);
		expect(h.state.pendingPoolDeletes[String(keyId)]).toMatchObject({
			attempts: 31,
			nextRetryAt: 3_601_000,
			lastErrorCode: "upstream",
		});
	});

	test("410 and exact key-not-found codes are idempotent but broad codes are not", async () => {
		h = poolHarness();
		for (const [keyId, status, code] of [
			[801, 410, "gone"],
			[802, 400, "key_not_found"],
			[803, 400, "account_not_found"],
		] as const) {
			h.mock.keys.set(keyId, {
				id: keyId,
				name: `aihub-auto-g${keyId}`,
				key: `sk-test-${keyId}`,
				group_id: keyId,
			});
			h.mock.deleteKeyFailures.set(keyId, { status, code, remaining: 1 });
			h.state.pendingPoolDeletes[String(keyId)] = {
				keyId,
				groupId: keyId,
				accountIdentity: "id:account-1",
				attempts: 1,
				nextRetryAt: 0,
				queuedAt: keyId,
				lastErrorCode: "upstream",
			};
		}

		expect(await h.executor.retryPendingPoolDeletes(1_000)).toBe(2);
		expect(h.state.pendingPoolDeletes["801"]).toBeUndefined();
		expect(h.state.pendingPoolDeletes["802"]).toBeUndefined();
		expect(h.state.pendingPoolDeletes["803"]?.attempts).toBe(2);
	});

	test("startup reconcile retries pending deletes even when key listing fails", async () => {
		h = poolHarness();
		const keyId = 901;
		h.mock.keys.set(keyId, {
			id: keyId,
			name: "aihub-auto-g9",
			key: "sk-test-901",
			group_id: 9,
		});
		h.state.pendingPoolDeletes[String(keyId)] = {
			keyId,
			groupId: 9,
			accountIdentity: "id:account-1",
			attempts: 1,
			nextRetryAt: 0,
			queuedAt: 0,
			lastErrorCode: "upstream",
		};
		h.mock.listKeysStatus = 503;

		await h.executor.reconcile();
		expect(h.mock.keys.has(keyId)).toBe(false);
		expect(h.state.pendingPoolDeletes[String(keyId)]).toBeUndefined();
	});

	test("401 refresh never retries an old-account delete with a new identity", async () => {
		h = createHarness({
			configPatch: { keyMode: "pool" },
			reauth: async (credentials, state) => {
				credentials.accessToken = "account-two-token";
				credentials.accountIdentity = "id:account-2";
				state.accountIdentity = "id:account-2";
				return true;
			},
		});
		const keyId = 902;
		h.mock.keys.set(keyId, {
			id: keyId,
			name: "aihub-auto-g9",
			key: "sk-test-902",
			group_id: 9,
		});
		h.mock.deleteKeyFailures.set(keyId, { status: 401, remaining: 1 });
		h.state.pendingPoolDeletes[String(keyId)] = {
			keyId,
			groupId: 9,
			accountIdentity: "id:account-1",
			attempts: 1,
			nextRetryAt: 0,
			queuedAt: 0,
			lastErrorCode: "unauthorized",
		};

		await h.executor.retryPendingPoolDeletes(1_000);
		expect(h.mock.keys.has(keyId)).toBe(true);
		expect(
			h.mock.requestLog.filter(
				(request) => request.method === "DELETE" && request.path.endsWith("/902"),
			),
		).toHaveLength(1);
		expect(h.state.pendingPoolDeletes[String(keyId)]?.accountIdentity).toBe(
			"id:account-1",
		);
	});
});
