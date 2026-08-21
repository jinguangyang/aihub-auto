import { afterEach, describe, expect, test } from "bun:test";
import { CircuitBreaker, LocalObservationStore } from "@aihub-auto/core";
import { AccountSwitchBusyError } from "../src/account-errors.ts";
import { OutboundProxyProbeError } from "../src/outbound-proxy.ts";
import { handleProxy } from "../src/proxy.ts";
import { browserRequestProblem } from "../src/server.ts";
import { createHarness, type Harness } from "./harness.ts";
import { makeStat } from "./mock-upstream.ts";

let h: Harness;
afterEach(() => h?.dispose());

function proxyReq(): Request {
	return new Request("http://localhost/v1/chat/completions", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: "{}",
	});
}

describe("出站代理连通性控制", () => {
	test("测试未保存的严格候选配置且不修改当前配置", async () => {
		let seen: unknown;
		h = createHarness({
			withServer: true,
			probeOutboundProxy: async (settings) => {
				seen = settings;
				return { latencyMs: 42.4 };
			},
		});
		const before = {
			mode: h.config.outboundProxyMode,
			url: h.config.outboundProxyUrl,
		};
		const response = await fetch(`${h.serverUrl}/ctl/outbound-proxy/test`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				outboundProxyMode: "custom",
				outboundProxyUrl: "http://127.0.0.1:7890",
			}),
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({ ok: true, latencyMs: 42 });
		expect(seen).toEqual({
			outboundProxyMode: "custom",
			outboundProxyUrl: "http://127.0.0.1:7890",
		});
		expect(h.config.outboundProxyMode).toBe(before.mode);
		expect(h.config.outboundProxyUrl).toBe(before.url);

		for (const body of [
			{ outboundProxyMode: "custom", outboundProxyUrl: "" },
			{ outboundProxyMode: "none", outboundProxyUrl: "", extra: true },
		]) {
			const invalid = await fetch(`${h.serverUrl}/ctl/outbound-proxy/test`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(invalid.status).toBe(400);
		}
	});

	test("要求控制台口令并映射脱敏探测错误", async () => {
		let failure: Error = new OutboundProxyProbeError("timeout");
		h = createHarness({
			withServer: true,
			configPatch: { uiPassword: "console-pass-123" },
			probeOutboundProxy: async () => {
				throw failure;
			},
		});
		const request = (headers?: Record<string, string>) =>
			fetch(`${h.serverUrl}/ctl/outbound-proxy/test`, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...headers },
				body: JSON.stringify({
					outboundProxyMode: "none",
					outboundProxyUrl: "",
				}),
			});
		expect((await request()).status).toBe(401);
		const authorized = { "x-ui-password": "console-pass-123" };
		for (const [error, status, message] of [
			[new OutboundProxyProbeError("missing_system_proxy"), 400, "未检测到 HTTPS_PROXY 或 HTTP_PROXY"],
			[new OutboundProxyProbeError("timeout"), 504, "AIHub 连接超时"],
			[new OutboundProxyProbeError("upstream", 503), 502, "AIHub 返回 HTTP 503"],
			[new Error("http://user:secret@proxy private socket detail"), 502, "无法通过该代理连接 AIHub"],
		] as const) {
			failure = error;
			const response = await request(authorized);
			expect(response.status).toBe(status);
			expect(await response.json()).toEqual({ error: message });
		}
	});
});

describe("守护循环", () => {
	test("account plan filters available groups and an empty plan list preserves legacy all", async () => {
		h = createHarness({
			configPatch: {
				keyMode: "pool",
				accountPoolMode: "all",
				accountPoolPlans: ["plus"],
			},
		});
		h.mock.stats = [
			makeStat({
				groupId: 1,
				code: "A001-Plus",
				rateMultiplier: 0.1,
				avgTtftMs: 5_000,
			}),
			makeStat({
				groupId: 2,
				code: "A002-Pro",
				rateMultiplier: 0.01,
				avgTtftMs: 100,
			}),
			makeStat({
				groupId: 8,
				code: "A008-BugTeam",
				rateMultiplier: 0.01,
				avgTtftMs: 100,
			}),
		];
		const filtered = await h.daemon.runOnce({ dryRun: true });
		expect(filtered.evaluation.eligible.map((candidate) => candidate.stat.groupId)).toEqual([1]);
		expect(
			filtered.evaluation.excluded.find(
				(candidate) => candidate.stat.groupId === 8,
			)?.excludeReason,
		).toBe("account_plan");

		h.dispose();
		h = createHarness({
			configPatch: {
				keyMode: "pool",
				accountPoolMode: "all",
				accountPoolPlans: [],
			},
		});
		h.mock.stats = [
			makeStat({ groupId: 1, code: "A001-Plus" }),
			makeStat({ groupId: 2, code: "A002-Pro" }),
		];
		const unfiltered = await h.daemon.runOnce({ dryRun: true });
		expect(unfiltered.evaluation.eligible.map((candidate) => candidate.stat.groupId)).toEqual([1, 2]);
	});

	test("model capability filters static providers and runtime blocks independently", async () => {
		h = createHarness({ configPatch: { keyMode: "pool" } });
		h.mock.stats = [
			makeStat({
				groupId: 1,
				supportedModels: ["gpt-5"],
				modelAvailabilityKnown: true,
				rateMultiplier: 0.1,
				avgTtftMs: 5_000,
			}),
			makeStat({
				groupId: 2,
				supportedModels: ["claude-*"],
				modelAvailabilityKnown: true,
				rateMultiplier: 0.01,
				avgTtftMs: 100,
			}),
		];
		await h.daemon.runOnce({ dryRun: true });
		const staticallyCompatible = await h.daemon.route({ model: "gpt-5" });
		expect(staticallyCompatible?.groupId).toBe(1);
		staticallyCompatible?.release?.();

		h.mock.stats = [
			makeStat({
				groupId: 1,
				supportedModels: ["gpt-5"],
				modelAvailabilityKnown: true,
				rateMultiplier: 0.01,
				avgTtftMs: 100,
			}),
			makeStat({
				groupId: 2,
				supportedModels: ["gpt-5"],
				modelAvailabilityKnown: true,
				rateMultiplier: 0.1,
				avgTtftMs: 5_000,
			}),
		];
		h.daemon.resetAccountCaches();
		await h.daemon.runOnce({ dryRun: true });
		h.daemon.reportModelIncompatible(1, "gpt-5");
		const runtimeCompatible = await h.daemon.route({ model: "gpt-5" });
		expect(runtimeCompatible?.groupId).toBe(2);
		runtimeCompatible?.release?.();
	});

	test("single-key routing never acquires a static model-incompatible group", async () => {
		h = createHarness({ configPatch: { keyMode: "single" } });
		h.mock.stats = [
			makeStat({
				groupId: 1,
				supportedModels: ["other-model"],
				modelAvailabilityKnown: true,
				rateMultiplier: 0.01,
			}),
			makeStat({
				groupId: 2,
				supportedModels: ["target-model"],
				modelAvailabilityKnown: true,
				rateMultiplier: 0.1,
			}),
		];
		h.mock.keys.set(1, {
			id: 1,
			name: "seed",
			key: "sk-seed",
			group_id: 2,
		});
		const key = await h.daemon.route({ model: "target-model" });
		expect(key?.groupId).toBe(2);
		key?.release?.();
		expect([...h.mock.keys.values()].map((item) => item.group_id)).toEqual([2]);
	});

	test("pool affinity and preferred-group continuity honor model filters", async () => {
		h = createHarness({ configPatch: { keyMode: "pool" } });
		h.mock.stats = [
			makeStat({
				groupId: 1,
				supportedModels: ["other-model"],
				modelAvailabilityKnown: true,
			}),
			makeStat({
				groupId: 2,
				supportedModels: ["target-model"],
				modelAvailabilityKnown: true,
			}),
		];
		await h.daemon.runOnce();
		h.affinity.bind("affinity-model", 1);
		const affinity = await h.daemon.route({
			sessionKey: "affinity-model",
			continuity: true,
			model: "target-model",
		});
		expect(affinity?.groupId).toBe(2);
		affinity?.release?.();
		const preferred = await h.daemon.route({
			preferredGroupId: 1,
			continuity: true,
			model: "target-model",
		});
		expect(preferred?.groupId).toBe(2);
		preferred?.release?.();
	});

	test("half-open probes and failed-group retries skip incompatible groups", async () => {
		h = createHarness({ configPatch: { keyMode: "pool" } });
		h.mock.stats = [
			makeStat({
				groupId: 1,
				supportedModels: ["other-model"],
				modelAvailabilityKnown: true,
			}),
			makeStat({
				groupId: 2,
				supportedModels: ["target-model"],
				modelAvailabilityKnown: true,
			}),
		];
		const past = Date.now() - 31_000;
		for (let index = 0; index < 3; index++)
			h.breaker.recordFailure(1, past + index);
		const probe = await h.daemon.route({ model: "target-model" });
		expect(probe?.groupId).toBe(2);
		probe?.release?.();
		const retry = await h.daemon.route({
			model: "target-model",
			failedGroupIds: [1],
		});
		expect(retry?.groupId).toBe(2);
		retry?.release?.();

		h.daemon.resetAccountCaches();
		h.mock.stats = [
			makeStat({
				groupId: 1,
				supportedModels: ["target-model"],
				modelAvailabilityKnown: true,
			}),
			makeStat({
				groupId: 2,
				supportedModels: ["target-model"],
				modelAvailabilityKnown: true,
			}),
		];
		await h.daemon.runOnce({ dryRun: true });
		h.daemon.reportModelIncompatible(1, "target-model");
		const learned = await h.daemon.route({ model: "target-model" });
		expect(learned?.groupId).toBe(2);
		learned?.release?.();
	});

	test("control policy changes invalidate cached allowed groups", async () => {
		h = createHarness({
			withServer: true,
			configPatch: { keyMode: "pool", accountPoolPlans: ["plus"] },
		});
		h.mock.stats = [
			makeStat({ groupId: 1, code: "A001-Plus" }),
			makeStat({ groupId: 2, code: "A002-Pro" }),
		];
		const initial = await h.daemon.runOnce({ dryRun: true });
		expect(initial.evaluation.eligible.map((candidate) => candidate.stat.groupId)).toEqual([1]);
		const update = await fetch(`${h.serverUrl}/ctl/config`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ accountPoolPlans: ["pro"] }),
		});
		expect(update.status).toBe(200);
		expect(h.config.accountPoolMode).toBe("all");
		expect(h.config.accountPoolPlans).toEqual(["pro"]);
		expect(h.daemon.lastRound?.evaluation.eligible.map((candidate) => candidate.stat.groupId)).toEqual([2]);
	});

	test("strict plans and known-empty model lists return no key or upstream access", async () => {
		h = createHarness({
			withServer: true,
			configPatch: { keyMode: "pool", accountPoolPlans: ["plus"] },
		});
		h.mock.stats = [makeStat({ groupId: 1, code: "A001-Pro" })];
		const planRound = await h.daemon.runOnce({ dryRun: true });
		expect(planRound.evaluation.excluded[0]?.excludeReason).toBe("account_plan");
		expect(await h.daemon.route({ model: "target-model" })).toBeUndefined();
		const planResponse = await handleProxy(proxyReq(), h.proxyDeps);
		expect(planResponse.status).toBe(503);
		expect(await planResponse.text()).not.toContain("sk-");
		expect(h.mock.requestLog.some((entry) => entry.path.startsWith("/v1/"))).toBe(false);
		const planStatus = await fetch(`${h.serverUrl}/ctl/status`).then((response) => response.text());
		expect(planStatus).toContain("account_plan");
		expect(planStatus).not.toContain("sk-mock");

		h.dispose();
		h = createHarness({ withServer: true, configPatch: { keyMode: "pool" } });
		h.mock.stats = [
			makeStat({ groupId: 1, supportedModels: [], modelAvailabilityKnown: true }),
			makeStat({ groupId: 2, supportedModels: [], modelAvailabilityKnown: true }),
		];
		await h.daemon.runOnce({ dryRun: true });
		const modelEvaluation = (h.daemon as unknown as {
			evaluate: (
				items: typeof h.mock.stats,
				now: number,
				extraBlacklist: number[],
				allowHalfOpen: boolean,
				model: string,
			) => { excluded: Array<{ excludeReason: string }> };
		}).evaluate(h.mock.stats, Date.now(), [], false, "target-model");
		expect(modelEvaluation.excluded.map((candidate) => candidate.excludeReason)).toEqual([
			"model_unavailable",
			"model_unavailable",
		]);
		expect(await h.daemon.route({ model: "target-model" })).toBeUndefined();
		const modelResponse = await handleProxy(
			new Request("http://localhost/v1/chat/completions", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "target-model" }),
			}),
			h.proxyDeps,
		);
		expect(modelResponse.status).toBe(503);
		const modelBody = (await modelResponse.json()) as {
			error: { code?: string; message: string };
		};
		expect(modelBody.error.code).toBe("model_unavailable");
		expect(modelBody.error.message).toContain("没有可用分组");
		expect(JSON.stringify(modelBody)).not.toContain("sk-");
		expect(h.mock.requestLog.some((entry) => entry.path.startsWith("/v1/"))).toBe(false);
		const modelStatus = await fetch(`${h.serverUrl}/ctl/status`).then((response) => response.text());
		expect(modelStatus).toContain('"models":[]');
		expect(modelStatus).toContain('"modelAvailabilityKnown":true');
		expect(modelStatus).not.toContain("sk-mock");
	});

	test("account switch resets account-plan eligibility cache", async () => {
		h = createHarness({
			configPatch: { keyMode: "pool", accountPoolPlans: ["plus"] },
		});
		h.mock.stats = [makeStat({ groupId: 1 }), makeStat({ groupId: 2 })];
		h.mock.groupNames.set(1, "A001-Plus");
		h.mock.groupNames.set(2, "A002-Pro");
		await h.daemon.runOnce();
		expect(h.state.currentGroupId).toBe(1);
		h.mock.requestLog.length = 0;

		h.mock.groupNames.set(1, "A001-Pro");
		h.mock.groupNames.set(2, "A002-Plus");
		await h.accountSwitcher.login({ token: "account-two-token" });
		expect(h.state.currentGroupId).toBe(2);
		const refreshPaths = h.mock.requestLog.map((entry) => entry.path);
		expect(refreshPaths).toContain("/api/v1/public/groups/usage-stats");
		expect(refreshPaths).toContain("/api/v1/public/providers");
		expect(refreshPaths).toContain("/api/v1/groups/available");
		expect(refreshPaths).toContain("/api/v1/groups/rates");
	});

	test("account refresh failures retain cached eligibility and mark the round stale", async () => {
		h = createHarness({
			configPatch: { keyMode: "pool", accountPoolPlans: ["plus"] },
		});
		h.mock.stats = [makeStat({ groupId: 1, code: "A001-Plus" })];
		await h.daemon.runOnce({ dryRun: true });

		h.mock.stats = [
			makeStat({ groupId: 1, code: "A001-Plus" }),
			makeStat({ groupId: 2, code: "A002-Plus" }),
		];
		h.mock.availableGroupsStatus = 503;
		const round = await h.daemon.runOnce({ dryRun: true });
		expect(round.stale).toBe(true);
		expect(round.evaluation.eligible.map((candidate) => candidate.stat.groupId)).toEqual([1]);
	});

	test("冷启动:选最优组并执行(pool 建 Key)", async () => {
		h = createHarness({ configPatch: { keyMode: "pool" } });
		h.mock.stats = [
			makeStat({ groupId: 1, rateMultiplier: 0.03, avgTtftMs: 1500 }),
			makeStat({ groupId: 2, rateMultiplier: 0.1, avgTtftMs: 5000 }),
		];
		const round = await h.daemon.runOnce();
		expect(round.decision.reason).toBe("initial_route");
		expect(round.executed).toBe(true);
		expect(h.state.currentGroupId).toBe(1);
		expect([...h.mock.keys.values()][0]!.name).toBe("aihub-auto-g1");
		// 反代立即可用
		const res = await handleProxy(proxyReq(), h.proxyDeps);
		expect(res.status).toBe(200);
	});

	test("provider 不可用时排除仍有 usage 样本的分组", async () => {
		h = createHarness({ configPatch: { keyMode: "pool" } });
		h.mock.stats = [
			makeStat({
				groupId: 48,
				providerAvailable: false,
				rateMultiplier: 0.01,
				avgTtftMs: 100,
			}),
			makeStat({ groupId: 49, rateMultiplier: 0.02, avgTtftMs: 1000 }),
		];
		const round = await h.daemon.runOnce();
		expect(h.state.currentGroupId).toBe(49);
		expect(
			round.evaluation.excluded.find(
				(candidate) => candidate.stat.groupId === 48,
			)?.excludeReason,
		).toBe("unavailable_group");
	});

	test("统计拉取失败:容忍并用上轮缓存(标 stale)", async () => {
		h = createHarness({ configPatch: { keyMode: "pool" } });
		h.mock.stats = [makeStat({ groupId: 1 })];
		await h.daemon.runOnce();
		// 模拟上游统计接口挂掉:换成无效 baseUrl 的新 client 不好搞,直接清 stats 并让接口 500 更真实——
		// 这里用行为等价方式:关掉 mock server 后 fetch 失败
		const round1 = h.daemon.lastRound!;
		expect(round1.stale).toBe(false);
		h.mock.stop();
		const round2 = await h.daemon.runOnce();
		expect(round2.stale).toBe(true);
		// 缓存候选仍在(样本时间还新鲜)
		expect(round2.evaluation.eligible.length).toBeGreaterThan(0);
	});

	test("dry-run 不执行切换", async () => {
		h = createHarness({ configPatch: { keyMode: "pool" } });
		h.mock.stats = [makeStat({ groupId: 1 })];
		const round = await h.daemon.runOnce({ dryRun: true });
		expect(round.decision.shouldSwitch).toBe(true);
		expect(round.executed).toBe(false);
		expect(h.state.currentGroupId).toBeUndefined();
		expect(h.mock.keys.size).toBe(0);
	});

	test("熔断冷却独立于用户黑名单:open 组不参与决策", async () => {
		h = createHarness({ configPatch: { keyMode: "pool" } });
		h.mock.stats = [
			makeStat({ groupId: 1, rateMultiplier: 0.02, avgTtftMs: 1000 }),
			makeStat({ groupId: 2, rateMultiplier: 0.05, avgTtftMs: 2000 }),
		];
		for (let i = 0; i < 3; i++) h.breaker.recordFailure(1);
		const round = await h.daemon.runOnce();
		expect(h.state.currentGroupId).toBe(2);
		expect(
			round.evaluation.excluded.find(
				(candidate) => candidate.stat.groupId === 1,
			)?.excludeReason,
		).toBe("circuit_open");
		expect(h.config.blacklist).toEqual([]);
	});

	test("超出价格区间的闲置池组会在守护轮回收并清理亲和", async () => {
		h = createHarness({
			configPatch: {
				keyMode: "pool",
				priceBand: { min: 0, max: 0.05 },
				decision: {
					stickiness: 0.1,
					cachePenaltyMax: 0.25,
					cacheIdleMs: 0,
					minDwellMs: 0,
				},
			},
		});
		h.mock.stats = [
			makeStat({ groupId: 1, rateMultiplier: 0.02 }),
			makeStat({ groupId: 2, rateMultiplier: 0.2 }),
		];
		await h.executor.ensureKey(1);
		await h.executor.ensureKey(2);
		h.affinity.bind("stale-session", 2);
		h.affinity.bindResponse("resp_stale", "stale-session", 2);
		h.state.pool["2"]!.lastUsedAt = 0;

		const round = await h.daemon.runOnce();
		expect(
			round.evaluation.excluded.find(
				(candidate) => candidate.stat.groupId === 2,
			)?.excludeReason,
		).toBe("price_band");
		expect(h.state.pool["2"]).toBeUndefined();
		expect(h.affinity.resolve("stale-session")).toBeUndefined();
		expect(h.affinity.resolveResponse("resp_stale")).toBeUndefined();
	});
});

describe("省钱优先", () => {
	test("新会话只选最低价层,该层失败后才升档,连续会话仍回原组", async () => {
		h = createHarness({
			configPatch: { keyMode: "pool", mode: "economy" },
		});
		h.mock.stats = [
			makeStat({ groupId: 1, rateMultiplier: 0.02, avgTtftMs: 4_000 }),
			makeStat({ groupId: 2, rateMultiplier: 0.02, avgTtftMs: 5_000 }),
			makeStat({ groupId: 3, rateMultiplier: 0.03, avgTtftMs: 100 }),
		];
		const round = await h.daemon.runOnce();
		expect(round.evaluation.eligible.map((c) => c.stat.groupId).sort()).toEqual(
			[1, 2],
		);
		expect(round.evaluation.standby.map((c) => c.stat.groupId)).toEqual([3]);
		expect(round.evaluation.excluded).toHaveLength(0);

		const economyActive = [];
		try {
			for (let index = 0; index < 8; index++) {
				const key = await h.daemon.route({ sessionKey: `new-${index}` });
				expect(key?.groupId === 1 || key?.groupId === 2).toBe(true);
				economyActive.push(key!);
			}
		} finally {
			for (const key of economyActive) key.release?.();
		}

		const fallback = await h.daemon.route({
			sessionKey: "fallback",
			failedGroupIds: [1, 2],
		});
		expect(fallback?.groupId).toBe(3);
		fallback?.release?.();

		h.affinity.bind("continued", 3);
		const continued = await h.daemon.route({
			sessionKey: "continued",
			continuity: true,
		});
		expect(continued?.groupId).toBe(3);
		continued?.release?.();
	});
});

describe("三模式并发调度", () => {
	test("balanced 在最优组积压后使用三候选池内的较贵容量", async () => {
		h = createHarness({
			configPatch: { keyMode: "pool", mode: "balanced", poolMaxGroups: 3 },
		});
		h.mock.stats = [
			makeStat({ groupId: 1, rateMultiplier: 0.01, avgTtftMs: 1000 }),
			makeStat({ groupId: 2, rateMultiplier: 0.02, avgTtftMs: 1000 }),
			makeStat({ groupId: 3, rateMultiplier: 0.04, avgTtftMs: 1000 }),
		];
		await h.daemon.runOnce();
		const active = [];
		try {
			for (let index = 0; index < 12; index++) {
				const key = await h.daemon.route({ sessionKey: `balanced-${index}` });
				expect(key).toBeDefined();
				active.push(key!);
			}
			const groups = active.map((key) => key.groupId);
			expect(groups).toContain(2);
			expect(groups).toContain(3);
		} finally {
			for (const key of active) key.release?.();
		}
	});

	test("speed 在积压后使用三候选池内的快速付费容量", async () => {
		h = createHarness({
			configPatch: { keyMode: "pool", mode: "speed", poolMaxGroups: 3 },
		});
		h.mock.stats = [
			makeStat({ groupId: 1, rateMultiplier: 0.01, avgTtftMs: 1100 }),
			makeStat({ groupId: 2, rateMultiplier: 0.03, avgTtftMs: 700 }),
			makeStat({ groupId: 3, rateMultiplier: 0.05, avgTtftMs: 500 }),
		];
		await h.daemon.runOnce();
		const active = [];
		try {
			for (let index = 0; index < 6; index++) {
				active.push((await h.daemon.route({ sessionKey: `speed-${index}` }))!);
			}
			expect(new Set(active.map((key) => key.groupId)).size).toBeGreaterThan(1);
		} finally {
			for (const key of active) key.release?.();
		}
	});
});

describe("手动锁定", () => {
	test("锁定覆盖软门槛,保留连续会话,失败可逃生且 revision 防旧操作", async () => {
		h = createHarness({
			withServer: true,
			configPatch: { keyMode: "pool", mode: "economy" },
		});
		h.mock.stats = [
			makeStat({ groupId: 1, rateMultiplier: 0.02, avgTtftMs: 2000 }),
			makeStat({ groupId: 2, rateMultiplier: 0.05, avgTtftMs: 30_000 }),
			makeStat({ groupId: 3, rateMultiplier: 0.2, avgTtftMs: 1000 }),
		];
		await h.daemon.runOnce();
		expect(
			h.daemon.lastRound?.evaluation.excluded.find(
				(candidate) => candidate.stat.groupId === 2,
			)?.excludeReason,
		).toBe("economy_too_slow");
		h.affinity.bind("existing", 1);
		const base = h.serverUrl!;

		const locked = await fetch(`${base}/ctl/route-lock`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ groupId: 2, expectedRevision: 0 }),
		});
		expect(locked.status).toBe(200);
		expect(h.state.manualLock).toEqual({ groupId: 2, revision: 1 });
		expect(h.state.currentGroupId).toBe(2);

		const fresh = await h.daemon.route({ sessionKey: "fresh" });
		expect(fresh?.groupId).toBe(2);
		fresh?.release?.();
		const existing = await h.daemon.route({
			sessionKey: "existing",
			continuity: true,
		});
		expect(existing?.groupId).toBe(1);
		existing?.release?.();
		const escaped = await h.daemon.route({
			sessionKey: "escaped",
			failedGroupIds: [2],
		});
		expect(escaped?.groupId).toBe(1);
		escaped?.release?.();

		const hardInvalid = await fetch(`${base}/ctl/route-lock`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ groupId: 3, expectedRevision: 1 }),
		});
		expect(hardInvalid.status).toBe(409);
		expect(h.state.manualLock.revision).toBe(1);
		const stale = await fetch(`${base}/ctl/route-lock`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ groupId: 1, expectedRevision: 0 }),
		});
		expect(stale.status).toBe(409);

		const released = await fetch(`${base}/ctl/route-lock`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ groupId: null, expectedRevision: 1 }),
		});
		expect(released.status).toBe(200);
		expect(h.state.manualLock).toEqual({ groupId: null, revision: 2 });
		const automatic = await h.daemon.route({ sessionKey: "automatic" });
		expect(automatic?.groupId).toBe(1);
		automatic?.release?.();
	});

	test("零倍率组存在时仍可显式锁定硬资格正常的付费组", async () => {
		h = createHarness({
			withServer: true,
			configPatch: { keyMode: "pool", mode: "balanced" },
		});
		h.mock.stats = [
			makeStat({ groupId: 1, rateMultiplier: 0, avgTtftMs: 1000 }),
			makeStat({ groupId: 2, rateMultiplier: 0.05, avgTtftMs: 2000 }),
		];
		await h.daemon.runOnce();
		const response = await fetch(`${h.serverUrl}/ctl/route-lock`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ groupId: 2, expectedRevision: 0 }),
		});
		expect(response.status).toBe(200);
		expect(h.state.currentGroupId).toBe(2);
		const routed = await h.daemon.route({ sessionKey: "paid-lock" });
		expect(routed?.groupId).toBe(2);
		routed?.release?.();
		const status = (await fetch(`${h.serverUrl}/ctl/status`).then((item) =>
			item.json(),
		)) as {
			manualLock: {
				groupId: number | null;
				revision: number;
				effective: boolean;
			};
		};
		expect(status.manualLock).toMatchObject({
			groupId: 2,
			revision: 1,
			effective: true,
		});
	});

	test("配置更新后锁定资格按当前黑名单重算,不接受旧轮次候选", async () => {
		h = createHarness({
			withServer: true,
			configPatch: { keyMode: "pool", mode: "balanced" },
		});
		h.mock.stats = [
			makeStat({ groupId: 1, rateMultiplier: 0.02, avgTtftMs: 1000 }),
			makeStat({ groupId: 2, rateMultiplier: 0.05, avgTtftMs: 2000 }),
		];
		await h.daemon.runOnce();
		const configResponse = await fetch(`${h.serverUrl}/ctl/config`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ blacklist: [2] }),
		});
		expect(configResponse.status).toBe(200);
		const lockResponse = await fetch(`${h.serverUrl}/ctl/route-lock`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ groupId: 2, expectedRevision: 0 }),
		});
		expect(lockResponse.status).toBe(409);
		expect(await lockResponse.json()).toMatchObject({ reason: "blacklisted" });
		expect(h.state.manualLock).toEqual({ groupId: null, revision: 0 });
	});

	test("旧守护轮与锁定更新串行,锁定成功后不会被过期决策覆盖", async () => {
		h = createHarness({
			withServer: true,
			configPatch: { keyMode: "pool", mode: "balanced" },
		});
		h.mock.stats = [
			makeStat({ groupId: 1, rateMultiplier: 0.02, avgTtftMs: 500 }),
			makeStat({ groupId: 2, rateMultiplier: 0.05, avgTtftMs: 3000 }),
		];
		await h.executor.switchTo(2);
		await h.daemon.runOnce({ dryRun: true });

		const originalSwitchTo = h.executor.switchTo.bind(h.executor);
		let releaseSwitch!: () => void;
		const switchGate = new Promise<void>((resolve) => {
			releaseSwitch = resolve;
		});
		let enteredSwitch!: () => void;
		const switchEntered = new Promise<void>((resolve) => {
			enteredSwitch = resolve;
		});
		let pauseAutomatic = true;
		h.executor.switchTo = async (groupId) => {
			if (pauseAutomatic && groupId === 1) {
				pauseAutomatic = false;
				enteredSwitch();
				await switchGate;
			}
			return originalSwitchTo(groupId);
		};

		const oldRound = h.daemon.runOnce();
		await switchEntered;
		const lockRequest = fetch(`${h.serverUrl}/ctl/route-lock`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ groupId: 2, expectedRevision: 0 }),
		});
		await Bun.sleep(20);
		expect(h.state.manualLock.revision).toBe(0);
		releaseSwitch();
		await oldRound;
		const locked = await lockRequest;
		expect(locked.status).toBe(200);
		expect(h.state.manualLock).toEqual({ groupId: 2, revision: 1 });
		expect(h.state.currentGroupId).toBe(2);
	});

	test("single 模式锁定全局 Key,锁组失败后本请求可切备用组", async () => {
		h = createHarness({ configPatch: { keyMode: "single", mode: "balanced" } });
		h.mock.stats = [
			makeStat({ groupId: 1, rateMultiplier: 0.02, avgTtftMs: 1000 }),
			makeStat({ groupId: 2, rateMultiplier: 0.05, avgTtftMs: 2000 }),
		];
		h.mock.keys.set(11, {
			id: 11,
			name: "manual",
			key: "sk-user-11",
			group_id: 1,
		});
		h.state.manualLock = { groupId: 2, revision: 1 };
		await h.daemon.runOnce();
		const locked = await h.daemon.route({});
		expect(locked?.groupId).toBe(2);
		const escaped = await h.daemon.route({ failedGroupIds: [2] });
		expect(escaped?.groupId).toBe(1);
		expect(h.state.manualLock).toEqual({ groupId: 2, revision: 1 });
	});
});

describe("缓存感知端到端", () => {
	test("持续流量中小幅更优 ⇒ 不切(hold_cache);流量停止后 ⇒ pending_realized", async () => {
		h = createHarness({
			configPatch: {
				keyMode: "pool",
				decision: {
					stickiness: 0.1,
					cachePenaltyMax: 0.25,
					cacheIdleMs: 1_000,
					minDwellMs: 0,
				},
			},
		});
		// 先路由到组 2
		h.mock.stats = [
			makeStat({ groupId: 2, rateMultiplier: 0.05, avgTtftMs: 3000 }),
		];
		await h.daemon.runOnce();
		expect(h.state.currentGroupId).toBe(2);

		// 出现小幅更优的组 1(分差落在 stickiness ~ stickiness+penalty 之间)
		h.mock.stats = [
			makeStat({ groupId: 1, rateMultiplier: 0.05, avgTtftMs: 2400 }),
			makeStat({ groupId: 2, rateMultiplier: 0.05, avgTtftMs: 3300 }),
		];
		// 制造活跃流量(直接打点,不走真实代理以免污染本地观测延迟)
		h.traffic.begin();
		h.traffic.end();

		const hot = await h.daemon.runOnce();
		expect(hot.decision.reason).toBe("hold_cache");
		expect(h.state.currentGroupId).toBe(2);
		expect(h.state.pendingSwitch?.groupId).toBe(1);

		// 等流量转冷(cacheIdleMs=1s)
		await Bun.sleep(1_100);
		const cold = await h.daemon.runOnce();
		expect(cold.decision.reason).toBe("pending_realized");
		expect(h.state.currentGroupId).toBe(1);
	}, 10_000);

	test("活跃流量中大幅优势 ⇒ 当场切换", async () => {
		h = createHarness({
			configPatch: {
				keyMode: "pool",
				decision: {
					stickiness: 0.1,
					cachePenaltyMax: 0.25,
					cacheIdleMs: 300_000,
					minDwellMs: 0,
				},
			},
		});
		h.mock.stats = [
			makeStat({ groupId: 2, rateMultiplier: 0.12, avgTtftMs: 6000 }),
		];
		await h.daemon.runOnce();
		h.mock.stats = [
			makeStat({ groupId: 1, rateMultiplier: 0.02, avgTtftMs: 1000 }),
			makeStat({ groupId: 2, rateMultiplier: 0.12, avgTtftMs: 6000 }),
		];
		// 只制造缓存/流量热度,不写入组 2 的本地 TTFT,否则会改变本用例的公开延迟前提。
		h.traffic.begin();
		h.traffic.end();
		const round = await h.daemon.runOnce();
		expect(round.decision.shouldSwitch).toBe(true);
		expect(h.state.currentGroupId).toBe(1);
	});
});

describe("状态持久化与恢复", () => {
	test("breaker/observations 序列化进 state,重建后语义保留", async () => {
		h = createHarness({ configPatch: { keyMode: "pool" } });
		h.mock.stats = [makeStat({ groupId: 1 })];
		for (let i = 0; i < 3; i++) h.breaker.recordFailure(9);
		h.observations.recordSuccess(1, 1234);
		await h.daemon.runOnce();

		// 模拟重启:从序列化数据重建
		const b2 = CircuitBreaker.fromJSON(
			JSON.parse(JSON.stringify(h.state.breaker)),
		);
		const o2 = LocalObservationStore.fromJSON(
			JSON.parse(JSON.stringify(h.state.observations)),
		);
		expect(b2.isTripped(9)).toBe(true);
		expect(o2.getObservation(1)?.ewmaTtftMs).toBe(1234);
	});

	test("401 全链路:token 过期 → refresh → 路由继续", async () => {
		h = createHarness({ configPatch: { keyMode: "pool" } });
		h.mock.stats = [makeStat({ groupId: 1 })];
		h.mock.expireToken = true; // 业务接口 401,refresh 后复位
		const round = await h.daemon.runOnce();
		expect(round.executed).toBe(true);
		expect(h.mock.refreshCalls).toBe(1);
		expect(h.state.currentGroupId).toBe(1);
		expect(h.accounts.profiles[0]).toMatchObject({
			accessToken: "mock-at-2",
			refreshToken: "mock-rt-2",
		});
	});
});

describe("账号切换并发边界", () => {
	test("route preparation makes an account mutation busy", async () => {
		h = createHarness();
		let enter!: () => void;
		let release!: () => void;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const originalFetchStats = h.daemon.fetchStats.bind(h.daemon);
		h.daemon.fetchStats = async (platform) => {
			enter();
			await blocked;
			return originalFetchStats(platform);
		};
		const route = h.daemon.route({});

		await entered;
		let committed = false;
		await expect(
			h.daemon.runAccountSwitchMutation(async () => {
				committed = true;
			}),
		).rejects.toBeInstanceOf(AccountSwitchBusyError);
		expect(committed).toBe(false);
		release();
		await route;
	});

	test("routes receive retryable 503 during an account commit window", async () => {
		h = createHarness({ withServer: true });
		let enter!: () => void;
		let release!: () => void;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
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
});

describe("AIHub 账号热切换", () => {
	test("two-account API smoke keeps the client proxy token", async () => {
		const clientProxyToken = "stable-client-token";
		h = createHarness({
			withServer: true,
			configPatch: { keyMode: "pool", proxyToken: clientProxyToken },
		});
		h.mock.stats = [makeStat({ groupId: 1 })];
		const base = h.serverUrl!;
		const routeModel = () =>
			fetch(`${base}/v1/chat/completions`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${clientProxyToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: "smoke-model",
					messages: [{ role: "user", content: "ping" }],
				}),
			});

		expect(
			await fetch(`${base}/ctl/proxy-token`).then((response) => response.json()),
		).toEqual({ proxyToken: clientProxyToken });
		const firstResponse = await routeModel();
		expect(firstResponse.status).toBe(200);
		await firstResponse.text();
		const firstAuth = h.mock.requestLog
			.filter((entry) => entry.path === "/v1/chat/completions")
			.at(-1)?.auth;
		const firstSk = firstAuth?.replace(/^Bearer\s+/i, "");
		const firstKey = [...h.mock.keys.values()].find(
			(key) => key.key === firstSk,
		);
		expect(firstKey?.ownerId).toBe("account-1");

		const switchResponse = await fetch(`${base}/ctl/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: "account-two-token" }),
		});
		expect(switchResponse.status).toBe(200);
		expect(await switchResponse.json()).toMatchObject({
			ok: true,
			switched: true,
			email: "second@test.local",
		});
		expect(h.mock.keys.has(firstKey!.id)).toBe(false);
		expect(
			await fetch(`${base}/ctl/account`).then((response) => response.json()),
		).toEqual({ email: "second@test.local", balance: 12.34 });

		const secondResponse = await routeModel();
		expect(secondResponse.status).toBe(200);
		await secondResponse.text();
		const secondAuth = h.mock.requestLog
			.filter((entry) => entry.path === "/v1/chat/completions")
			.at(-1)?.auth;
		const secondSk = secondAuth?.replace(/^Bearer\s+/i, "");
		const secondKey = [...h.mock.keys.values()].find(
			(key) => key.key === secondSk,
		);
		expect(secondKey?.ownerId).toBe("account-2");
		expect(secondSk).not.toBe(firstSk);
		expect(h.config.proxyToken).toBe(clientProxyToken);

		h.traffic.begin(secondKey!.group_id ?? 1);
		try {
			const busyResponse = await fetch(`${base}/ctl/login`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token: "mock-at" }),
			});
			expect(busyResponse.status).toBe(409);
			expect(await busyResponse.json()).toMatchObject({
				code: "ACCOUNT_SWITCH_BUSY",
			});
			expect(h.credentials.accountIdentity).toBe("id:account-2");
		} finally {
			h.traffic.end(secondKey!.group_id ?? 1);
		}
	});
});

describe("控制台 API", () => {
	test("status/config/route-once/login 全链路", async () => {
		h = createHarness({
			withServer: true,
			configPatch: {
				keyMode: "pool",
				mode: "economy",
				sentryDsn: "https://public@example.ingest.sentry.io/1",
			},
		});
		h.mock.stats = [
			makeStat({
				groupId: 1,
				supportedModels: ["gpt-5", "gpt-4o-mini"],
				modelAvailabilityKnown: true,
				rateMultiplier: 0.03,
				avgTtftMs: 1500,
				cloudProbeTtftMs: 1000,
				userAvgTtftMs: 2000,
				userSampleCount: 50,
			}),
			makeStat({ groupId: 2, rateMultiplier: 0.2, avgTtftMs: 900 }), // 出价格区间 ⇒ excluded
			makeStat({ groupId: 3, rateMultiplier: 0.01, avgTtftMs: 30_000 }), // 超过省钱延迟门槛
		];
		h.observations.recordSuccess(1, 1_000);
		h.observations.recordLatency(1, 1500);
		const base = h.serverUrl!;

		// route-once
		const routeRes = await fetch(`${base}/ctl/route-once`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ dryRun: false }),
		});
		const route = (await routeRes.json()) as {
			shouldSwitch: boolean;
			targetGroupId: number;
		};
		expect(route.shouldSwitch).toBe(true);
		expect(route.targetGroupId).toBe(1);

		// status 含候选、排除原因和逐组使用状态。纯历史亲和保留在汇总,
		// 但没有 Key/在飞/当前/锁定角色时不占“分组使用”表格行。
		h.affinity.bind("session-1", 1);
		h.affinity.bindResponse("resp_1", "session-1", 1);
		h.affinity.bind("historical-session", 2);
		h.affinity.bindResponse("resp_historical", "historical-session", 2);
		h.traffic.begin(1);
		const statusRes = await fetch(`${base}/ctl/status`);
		const statusText = await statusRes.text();
		expect(statusText).not.toContain("sk-mock");
		expect(statusText).not.toMatch(/"sk"\s*:/);
		const status = JSON.parse(statusText) as {
			currentGroupId: number;
			candidates: {
				groupId: number;
				models?: string[];
				modelAvailabilityKnown?: boolean;
				excluded: boolean;
				excludeReason?: string;
				ttft?: number;
				conservative?: number;
				cloudProbeTtft?: number;
				userTtft?: number;
				userSamples?: number;
				upstreamTtft?: number;
				localTtft?: number;
				successRate?: number;
				outcomeSamples?: number;
			}[];
			pool: Record<string, { keyId: number; lastUsedAt: number }>;
			affinity: { sessions: number; responseAliases: number };
			manualLock: { groupId: number | null; revision: number };
			sentry: { dsn: string; userEmail: string | null };
			desktopMode: boolean;
			groups: Array<{
				groupId: number;
				keyId: number | null;
				sessions: number;
				responseAliases: number;
				activeRequests: number;
			}>;
			hasToken: boolean;
			config: {
				listen: { host: string; port: number };
				proxyAuthRequired: boolean;
				uiAuthRequired: boolean;
				accountPoolMode: "all" | "plus" | "pro" | "team" | "mixed";
				accountPoolPlans: Array<"plus" | "pro" | "team">;
				priceBand: { min: number; max: number } | null;
				updateMirrors: string[];
				outboundProxyMode: "none" | "system" | "custom";
				outboundProxyUrl: string;
			};
		};
		expect(status.currentGroupId).toBe(1);
		expect(status.pool["1"]?.keyId).toBeDefined();
		expect(status.affinity.sessions).toBe(2);
		expect(status.affinity.responseAliases).toBe(2);
		expect(status.manualLock.groupId).toBeNull();
		expect(status.sentry).toEqual({
			dsn: "https://public@example.ingest.sentry.io/1",
			userEmail: null,
		});
		expect(status.groups.find((group) => group.groupId === 1)).toMatchObject({
			keyId: status.pool["1"]?.keyId,
			sessions: 1,
			responseAliases: 1,
			activeRequests: 1,
		});
		expect(status.groups.some((group) => group.groupId === 2)).toBe(false);
		h.traffic.end(1);
		expect(status.hasToken).toBe(true);
		expect(status.desktopMode).toBe(false);
		expect(status.config).toMatchObject({
			listen: { host: "127.0.0.1", port: 0 },
			proxyAuthRequired: false,
			uiAuthRequired: false,
			accountPoolMode: "all",
			accountPoolPlans: [],
			priceBand: { min: 0, max: 0.15 },
			updateMirrors: [],
			outboundProxyMode: "none",
			outboundProxyUrl: "",
		});

		await Bun.write(
			`${h.configDir}/app.log`,
			"2026-07-31T00:00:00.000Z [INFO] first\n2026-07-31T00:00:01.000Z [WARN] Bearer secret-token-value\n",
		);
		const logs = (await fetch(`${base}/ctl/logs?limit=1`).then((response) =>
			response.json(),
		)) as { lines: string[]; at: number };
		expect(logs.lines).toEqual(["2026-07-31T00:00:01.000Z [WARN] Bearer ***"]);
		expect(logs.at).toBeNumber();
		expect((await fetch(`${base}/ctl/logs?limit=1001`)).status).toBe(400);

		const ui = await fetch(`${base}/ui`).then((response) => response.text());
		expect(ui).toContain("[hidden]{display:none!important}");
		expect(ui).toContain("个本地运行分组");
		expect(ui).not.toContain("未入池");
		expect(ui).toContain("bundle.feedback.min.js");
		expect(ui).toContain(
			'feedbackIntegration({autoInject:false,colorScheme:"system",styleNonce:CSP_NONCE})',
		);
		expect(ui).toContain("defaultIntegrations:false");
		expect(ui).toContain("cookies:false");
		expect(ui).toContain("httpHeaders:{request:false,response:false}");
		expect(ui).toContain("beforeSendFeedback(event)");
		expect(ui).toContain("location.origin+location.pathname");
		expect(ui).toContain("Sentry.getFeedback()?.attachTo(button)");
		expect(ui).toContain("连接你的第一个客户端");
		expect(ui).toContain("/ctl/logs?limit=500");
		expect(ui).toContain("desktop-open-logs");
		expect(ui).toContain("https://github.com/WSXYT/aihub-auto");
		expect(ui).toContain('aria-current="page"');
		expect(ui).toContain('tabindex="0" role="region"');
		expect(ui).toContain('role="progressbar"');
		expect(ui).toContain(
			'const GUIDE_DISMISSED_KEY="aihub-auto.guide-dismissed"',
		);
		expect(ui).toContain('$("#refresh").focus()');
		expect(ui).toContain('id="guideVerify"');
		expect(ui).toContain("async function verifyGuide()");
		expect(ui).toContain('localBaseUrl()+"/models"');
		expect(ui).toContain("需要 proxyToken");
		expect(ui).toContain("无头路由器");
		expect(ui).toContain("saveUpdateMirrors");
		expect(ui).toContain("账户余额");
		expect(ui).toContain("/ctl/account");
		expect(ui).toContain('id="accountProfiles"');
		expect(ui).toContain('id="logoutAccount"');
		expect(ui).toContain('id="restartService"');
		expect(ui).toContain("/ctl/accounts/switch");
		expect(ui).toContain("/ctl/accounts/remove");
		expect(ui).toContain("/ctl/logout");
		expect(ui).toContain("/ctl/restart");
		expect(ui).toContain("async function refreshProfiles()");
		expect(ui).toContain("void refreshProfiles().catch(error=>");
		expect(ui).toContain("账户列表刷新失败");
		expect(ui).toContain("confirm(\"移除已保存账户");
		expect(ui).toContain("confirm(\"重启本地路由服务");
		expect(ui).toContain("客户端 API Key 无需修改");
		expect(ui).toContain("outboundProxyMode");
		expect(ui).toContain("saveOutboundProxy");
		expect(ui).toContain('id="accountPoolPlans"');
		expect(ui).toContain('type="checkbox" value="plus"');
		expect(ui).toContain('type="checkbox" value="pro"');
		expect(ui).toContain('type="checkbox" value="team"');
		expect(ui).toContain('accountPoolMode:"all"');
		expect(ui).toContain('const priceBand=status.config.priceBand');
		expect(ui).toContain('candidate.modelAvailabilityKnown===true');
		expect(ui).toContain("倍率不限");
		expect(ui).toContain("套餐池不匹配");
		expect(ui).toContain("模型不可用");
		expect(ui).toContain("模型运行时禁用");
		expect(ui).toContain('id="testOutboundProxy"');
		expect(ui).toContain('id="outboundProxyTestResult"');
		expect(ui).toContain('role="status" aria-live="polite"');
		expect(ui).toContain("async function testOutboundProxy");
		expect(ui).toContain("outboundProxyDirty");
		expect(ui).toContain("/ctl/outbound-proxy/test");
		expect(ui).toContain("autostart_enabled");
		expect(ui).toContain("set_autostart");
		expect(ui).toContain(
			'$("#guideLogin").addEventListener("click",()=>{$("#email").focus()',
		);
		const eligible = status.candidates.find((c) => c.groupId === 1);
		expect(eligible).toMatchObject({
			models: ["gpt-5", "gpt-4o-mini"],
			modelAvailabilityKnown: true,
			cloudProbeTtft: 1000,
			userTtft: 2000,
			userSamples: 50,
			upstreamTtft: 1414,
			localTtft: 1500,
		});
		expect(eligible?.successRate).toBe(1);
		expect(eligible?.outcomeSamples).toBe(1);
		const excluded = status.candidates.find((c) => c.groupId === 2);
		expect(excluded?.excluded).toBe(true);
		expect(excluded?.excludeReason).toBe("price_band");
		const tooSlow = status.candidates.find((c) => c.groupId === 3);
		expect(tooSlow).toMatchObject({
			excluded: true,
			excludeReason: "economy_too_slow",
			ttft: 30_000,
			conservative: 30_000,
		});

		// config 热更新
		const cfgRes = await fetch(`${base}/ctl/config`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mode: "speed", priceBand: { min: 0, max: 0.3 } }),
		});
		expect(cfgRes.status).toBe(200);
		expect(h.config.mode).toBe("speed");
		expect(h.config.priceBand?.max).toBe(0.3);

		h.config.economyPolicy = {
			minOutcomeSamples: 9,
			minSuccessRate: 0.9,
			maxConservativeLatencyMs: 40_000,
		};
		const partialCfgRes = await fetch(`${base}/ctl/config`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				priceBand: { max: 0.25 },
				economyPolicy: { minSuccessRate: 0.85 },
			}),
		});
		expect(partialCfgRes.status).toBe(200);
		expect(h.config.priceBand).toEqual({ min: 0, max: 0.25 });
		expect(h.config.economyPolicy).toEqual({
			minOutcomeSamples: 9,
			minSuccessRate: 0.85,
			maxConservativeLatencyMs: 40_000,
		});

		const poolCfgRes = await fetch(`${base}/ctl/config`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				accountPoolMode: "all",
				accountPoolPlans: ["plus", "team"],
				priceBand: null,
			}),
		});
		expect(poolCfgRes.status).toBe(200);
		expect(h.config.accountPoolMode).toBe("all");
		expect(h.config.accountPoolPlans).toEqual(["plus", "team"]);
		expect(h.config.priceBand).toBeNull();

		const partialUnlimitedRes = await fetch(`${base}/ctl/config`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ priceBand: { max: 0.4 } }),
		});
		expect(partialUnlimitedRes.status).toBe(200);
		expect(h.config.priceBand).toEqual({ min: 0, max: 0.4 });

		const stablePolicy = {
			accountPoolMode: h.config.accountPoolMode,
			accountPoolPlans: [...h.config.accountPoolPlans],
			priceBand: h.config.priceBand,
		};
		for (const invalidPatch of [
			{ accountPoolPlans: ["enterprise"] },
			{ priceBand: { min: 0.5, max: 0.4 } },
		]) {
			const response = await fetch(`${base}/ctl/config`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(invalidPatch),
			});
			expect(response.status).toBe(400);
			expect({
				accountPoolMode: h.config.accountPoolMode,
				accountPoolPlans: h.config.accountPoolPlans,
				priceBand: h.config.priceBand,
			}).toEqual(stablePolicy);
		}
		const uaRes = await fetch(`${base}/ctl/config`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ upstreamUserAgent: "BenefitClient/2.0" }),
		});
		expect(uaRes.status).toBe(200);
		expect(h.config.upstreamUserAgent).toBe("BenefitClient/2.0");
		const badUaRes = await fetch(`${base}/ctl/config`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ upstreamUserAgent: "bad\r\nheader" }),
		});
		expect(badUaRes.status).toBe(400);
		expect(h.config.upstreamUserAgent).toBe("BenefitClient/2.0");
		const proxyRes = await fetch(`${base}/ctl/config`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				outboundProxyMode: "custom",
				outboundProxyUrl: "http://127.0.0.1:7890",
			}),
		});
		expect(proxyRes.status).toBe(200);
		expect(h.config.outboundProxyMode).toBe("custom");
		expect(h.config.outboundProxyUrl).toBe("http://127.0.0.1:7890");
		const badProxyRes = await fetch(`${base}/ctl/config`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ outboundProxyMode: "custom", outboundProxyUrl: "" }),
		});
		expect(badProxyRes.status).toBe(400);

		const restartRes = await fetch(`${base}/ctl/config`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ keyMode: "single" }),
		});
		expect(restartRes.status).toBe(409);
		expect(h.config.keyMode).toBe("pool");

		// 非法配置被拒
		const badRes = await fetch(`${base}/ctl/config`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mode: "warp-speed" }),
		});
		expect(badRes.status).toBe(400);

		// login(email+password)
		const loginRes = await fetch(`${base}/ctl/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "a@b.c", password: "pw" }),
		});
		expect(loginRes.status).toBe(200);
		expect(h.credentials.accessToken).toBe("mock-at");
		expect(h.credentials.email).toBe("mock@test.local");
		const loggedInStatus = (await fetch(`${base}/ctl/status`).then((response) =>
			response.json(),
		)) as { sentry: { userEmail: string | null } };
		expect(loggedInStatus.sentry.userEmail).toBe("mock@test.local");
		const account = (await fetch(`${base}/ctl/account`).then((response) =>
			response.json(),
		)) as { email: string | null; balance: number | null };
		expect(account).toEqual({ email: "mock@test.local", balance: 12.34 });

		// 账号切换必须先拒绝在飞流量,旧凭据保持不变。
		const oldAccessToken = h.credentials.accessToken;
		h.traffic.begin(1);
		const busyLoginRes = await fetch(`${base}/ctl/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: "account-two-token" }),
		});
		expect(busyLoginRes.status).toBe(409);
		expect(await busyLoginRes.json()).toMatchObject({
			code: "ACCOUNT_SWITCH_BUSY",
		});
		expect(h.credentials.accessToken).toBe(oldAccessToken);
		h.traffic.end(1);

		// 直接 token 登录属于新身份边界,不得沿用上一个账号的 refresh token。
		const originalProxyToken = h.config.proxyToken;
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
		expect(h.credentials.expiresAt).toBeUndefined();
		expect(h.credentials.email).toBe("second@test.local");
		expect(h.affinity.resolve("old-session")).toBeUndefined();
		expect(Object.values(h.state.pool).every((entry) => entry.sk !== oldSk)).toBe(true);
		expect(h.config.proxyToken).toBe(originalProxyToken);
	});

	test("saved-account endpoints redact secrets and support switch, remove, and logout", async () => {
		h = createHarness({ withServer: true });
		const base = h.serverUrl!;

		const initialText = await fetch(`${base}/ctl/accounts`).then((response) =>
			response.text(),
		);
		expect(initialText).not.toContain("mock-at");
		expect(initialText).not.toContain("mock-rt");
		expect(JSON.parse(initialText)).toMatchObject({
			activeIdentity: "id:account-1",
			accounts: [
				{
					identity: "id:account-1",
					email: "mock@test.local",
					active: true,
				},
			],
		});

		const add = await fetch(`${base}/ctl/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: "account-two-token" }),
		});
		expect(add.status).toBe(200);
		expect(h.accounts.profiles).toHaveLength(2);

		const switched = await fetch(`${base}/ctl/accounts/switch`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ identity: "id:account-1" }),
		});
		expect(switched.status).toBe(200);
		expect(h.accounts.activeIdentity).toBe("id:account-1");
		expect(h.credentials.accessToken).toBe("mock-at");

		const malformed = await fetch(`${base}/ctl/accounts/switch`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ identity: "id:account-2", unexpected: true }),
		});
		expect(malformed.status).toBe(400);

		const removed = await fetch(`${base}/ctl/accounts/remove`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ identity: "id:account-2" }),
		});
		expect(removed.status).toBe(200);
		expect(h.accounts.profiles.map((profile) => profile.identity)).toEqual([
			"id:account-1",
		]);

		const logout = await fetch(`${base}/ctl/logout`, { method: "POST" });
		expect(logout.status).toBe(200);
		expect(h.credentials.accessToken).toBeUndefined();
		expect(h.accounts.activeIdentity).toBeUndefined();
		expect(h.accounts.profiles).toHaveLength(1);
		const afterLogout = await fetch(`${base}/ctl/accounts`).then((response) =>
			response.json(),
		);
		expect(afterLogout).toMatchObject({
			activeIdentity: null,
			accounts: [{ identity: "id:account-1", active: false }],
		});
	});

	test("restart is delayed, single-flight, and blocked by active traffic", async () => {
		h = createHarness({ withServer: true });
		const base = h.serverUrl!;
		h.traffic.begin(1);
		try {
			const blocked = await fetch(`${base}/ctl/restart`, { method: "POST" });
			expect(blocked.status).toBe(409);
			expect(await blocked.json()).toMatchObject({ code: "TRAFFIC_ACTIVE" });
			expect(h.restartRequested.value).toBe(false);
		} finally {
			h.traffic.end(1);
		}

		const accepted = await fetch(`${base}/ctl/restart`, { method: "POST" });
		expect(accepted.status).toBe(202);
		expect(await accepted.json()).toEqual({ ok: true, restarting: true });
		expect(h.restartRequested.value).toBe(false);
		const duplicate = await fetch(`${base}/ctl/restart`, { method: "POST" });
		expect(duplicate.status).toBe(409);
		expect(await duplicate.json()).toMatchObject({ code: "RESTART_PENDING" });
		await Bun.sleep(70);
		expect(h.restartRequested.value).toBe(true);
	});

	test("restart rejects while account mutation is pending", async () => {
		h = createHarness({ withServer: true });
		h.mock.meDelayMs = 50;
		const mutation = h.accountSwitcher.login({ token: "account-two-token" });
		try {
			const response = await fetch(`${h.serverUrl}/ctl/restart`, { method: "POST" });
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({ code: "ACCOUNT_SWITCH_BUSY" });
		} finally {
			await mutation;
		}
	});

	test("account mutations reject while restart is pending", async () => {
		h = createHarness({ withServer: true });
		h.restartState.pending = true;
		const headers = { "Content-Type": "application/json" };
		for (const [path, body] of [
			["/ctl/login", { token: "account-two-token" }],
			["/ctl/accounts/switch", { identity: "id:account-1" }],
			["/ctl/accounts/remove", { identity: "id:account-1" }],
		] as const) {
			const response = await fetch(`${h.serverUrl}${path}`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({ code: "RESTART_PENDING" });
		}
		const logout = await fetch(`${h.serverUrl}/ctl/logout`, { method: "POST" });
		expect(logout.status).toBe(409);
		expect(await logout.json()).toMatchObject({ code: "RESTART_PENDING" });
	});

	test("CC Switch usage endpoint requires proxy auth and returns balance", async () => {
		h = createHarness({
			withServer: true,
			configPatch: { proxyToken: "proxy-token-123456" },
		});
		const base = h.serverUrl!;

		const missing = await fetch(`${base}/v1/usage`);
		expect(missing.status).toBe(401);
		expect(await missing.json()).toMatchObject({ error: "代理口令错误" });

		const wrong = await fetch(`${base}/v1/usage`, {
			headers: { Authorization: "Bearer wrong-token" },
		});
		expect(wrong.status).toBe(401);

		const bearer = await fetch(`${base}/v1/usage`, {
			headers: { Authorization: "Bearer proxy-token-123456" },
		});
		expect(bearer.status).toBe(200);
		expect(bearer.headers.get("cache-control")).toBe("no-store");
		expect(await bearer.json()).toEqual({
			is_active: true,
			remaining: 12.34,
			balance: 12.34,
			unit: "USD",
		});

		const apiKey = await fetch(`${base}/v1/usage`, {
			headers: { "x-api-key": "proxy-token-123456" },
		});
		expect(apiKey.status).toBe(200);
		expect(
			h.mock.requestLog.filter((entry) => entry.path === "/v1/usage"),
		).toHaveLength(0);

		const method = await fetch(`${base}/v1/usage`, {
			method: "POST",
			headers: { Authorization: "Bearer proxy-token-123456" },
		});
		expect(method.status).toBe(405);
		expect(method.headers.get("allow")).toBe("GET");
	});

	test("CC Switch usage endpoint distinguishes AIHub login failures", async () => {
		h = createHarness({
			withServer: true,
			configPatch: { proxyToken: "proxy-token-123456" },
		});
		const headers = { Authorization: "Bearer proxy-token-123456" };
		const base = h.serverUrl!;

		h.credentials.accessToken = undefined;
		const loggedOut = await fetch(`${base}/v1/usage`, { headers });
		expect(loggedOut.status).toBe(503);
		expect(await loggedOut.json()).toEqual({ error: "尚未登录 AIHub" });

		h.credentials.accessToken = "expired-token";
		h.mock.expireToken = true;
		const expired = await fetch(`${base}/v1/usage`, { headers });
		expect(expired.status).toBe(401);
		expect(await expired.json()).toEqual({ error: "AIHub 登录已失效" });
	});

	test("uiPassword 配置后:无口令 401,带口令通过;/healthz 与 /ui 开放", async () => {
		h = createHarness({
			withServer: true,
			configPatch: {
				uiPassword: "console-pass-123",
				proxyToken: "proxy-token-123456",
			},
		});
		const base = h.serverUrl!;
		const unauthorized = await fetch(`${base}/ctl/status`);
		expect(unauthorized.status).toBe(401);
		expect(await unauthorized.json()).toEqual({
			code: "UI_AUTH_REQUIRED",
			error: "需要控制台口令",
		});
		expect((await fetch(`${base}/ctl/logs`)).status).toBe(401);
		expect((await fetch(`${base}/ctl/proxy-token`)).status).toBe(401);
		expect((await fetch(`${base}/ctl/accounts`)).status).toBe(401);
		expect(
			(await fetch(`${base}/ctl/logout`, { method: "POST" })).status,
		).toBe(401);
		expect(
			(await fetch(`${base}/ctl/restart`, { method: "POST" })).status,
		).toBe(401);

		const invalidAuth = await fetch(`${base}/ctl/auth`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password: "wrong-password" }),
		});
		expect(invalidAuth.status).toBe(401);
		expect(invalidAuth.headers.get("set-cookie")).toBeNull();

		const auth = await fetch(`${base}/ctl/auth`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password: "console-pass-123" }),
		});
		expect(auth.status).toBe(200);
		expect(await auth.clone().json()).toMatchObject({ ok: true });
		const setCookie = auth.headers.get("set-cookie")!;
		expect(setCookie).toContain("Max-Age=604800");
		expect(setCookie).toContain("HttpOnly");
		const cookie = setCookie.split(";", 1)[0]!;
		expect(
			(
				await fetch(`${base}/ctl/status`, {
					headers: { Cookie: cookie },
				})
			).status,
		).toBe(200);

		const cleared = await fetch(`${base}/ctl/auth`, {
			method: "DELETE",
			headers: { Cookie: cookie },
		});
		expect(cleared.status).toBe(200);
		expect(cleared.headers.get("set-cookie")).toContain("Max-Age=0");
		expect(
			(
				await fetch(`${base}/ctl/status`, {
					headers: { "x-ui-password": "console-pass-123" },
				})
			).status,
		).toBe(200);
		const proxyTokenResponse = await fetch(`${base}/ctl/proxy-token`, {
			headers: { "x-ui-password": "console-pass-123" },
		});
		expect(proxyTokenResponse.status).toBe(200);
		expect(proxyTokenResponse.headers.get("cache-control")).toBe("no-store");
		expect(await proxyTokenResponse.json()).toEqual({
			proxyToken: "proxy-token-123456",
		});
		h.credentials.accessToken = undefined;
		h.credentials.email = "stale@example.com";
		const anonymousStatus = (await fetch(`${base}/ctl/status`, {
			headers: { "x-ui-password": "console-pass-123" },
		}).then((response) => response.json())) as {
			sentry: { userEmail: string | null };
		};
		expect(anonymousStatus.sentry.userEmail).toBeNull();
		expect((await fetch(`${base}/healthz`)).status).toBe(200);
		const apiRoot = await fetch(`${base}/v1`);
		expect(apiRoot.status).toBe(200);
		expect(await apiRoot.json()).toMatchObject({
			name: "aihub-auto",
			status: "ok",
			ui: "/ui",
		});
		const ui = await fetch(`${base}/ui`);
		expect(ui.status).toBe(200);
		const html = await ui.text();
		const csp = ui.headers.get("content-security-policy") ?? "";
		const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
		expect(nonce).toBeTruthy();
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toContain("'strict-dynamic'");
		expect(csp).toContain("https://browser.sentry-cdn.com");
		expect(csp).toContain("https://o4510289605296128.ingest.de.sentry.io");
		expect(csp).not.toContain("'unsafe-inline'");
		expect(html).toContain(`<style nonce="${nonce}">`);
		expect(html).toContain(`<script nonce="${nonce}">`);
		expect(html).toContain(`const CSP_NONCE="${nonce}"`);
		expect(html).toContain("script.nonce=CSP_NONCE");
		expect(ui.headers.get("cache-control")).toBe("no-store");
		expect(ui.headers.get("x-content-type-options")).toBe("nosniff");
		expect(ui.headers.get("referrer-policy")).toBe("no-referrer");
		expect(html).toContain("aihub-auto");
		expect(html).toContain(
			'const GUIDE_DISMISSED_KEY="aihub-auto.guide-dismissed"',
		);
		expect(html).toContain("styleNonce:CSP_NONCE");
		expect(html).not.toContain("sessionStorage");
		expect(html).toContain('id="revealGuideKey"');
		expect(html).toContain('id="revealSettingsKey"');
		expect(html).toContain("function hideProxyToken");
		expect(html).toContain("10_000");
		expect(html).toContain("visibilitychange");
		expect(html).not.toContain("proxy-token-123456");
		expect(html).toContain('id="uiAuthSessionRow"');
		expect(html).toContain('id="forgetUiAuth"');
		expect(html).toContain("验证后 7 天内免输控制台口令");
		expect(html).toContain("let uiAuthPromise;");
		expect(html).toContain("let uiAuthGeneration=0;");
		expect(html).toContain("generation!==uiAuthGeneration");
		expect(html).toContain('body.code==="UI_AUTH_REQUIRED"');
		expect(html).toContain('fetch("/ctl/auth"');
		expect(html).toContain('credentials:"same-origin"');
		expect(html).not.toContain('let uiPass=""');
		expect(html).not.toContain("aihub-auto-pass");

		const ctl = await fetch(`${base}/ctl/status`, {
			headers: { "x-ui-password": "console-pass-123" },
		});
		expect(ctl.headers.get("cache-control")).toBe("no-store");

		h.credentials.accessToken = "expired-token";
		h.mock.expireToken = true;
		const accountFailure = await fetch(`${base}/ctl/account`, {
			headers: { Cookie: cookie },
		});
		expect(accountFailure.status).toBe(401);
		expect(await accountFailure.json()).toEqual({
			code: "AIHUB_REAUTH_REQUIRED",
			error: "读取 AIHub 账户信息失败",
		});
	});
});

describe("浏览器请求边界", () => {
	test("允许同源浏览器和无 Origin 客户端", async () => {
		h = createHarness({ withServer: true });
		const base = h.serverUrl!;
		expect((await fetch(`${base}/healthz`)).status).toBe(200);
		expect(
			(
				await fetch(`${base}/healthz`, {
					headers: { Origin: base },
				})
			).status,
		).toBe(200);
	});

	test("拒绝跨站 Origin、null Origin 和 Sec-Fetch-Site", async () => {
		h = createHarness({ withServer: true });
		const base = h.serverUrl!;
		expect(
			(
				await fetch(`${base}/ctl/status`, {
					headers: { Origin: "https://attacker.example" },
				})
			).status,
		).toBe(403);
		expect(
			(
				await fetch(`${base}/ctl/status`, {
					headers: { Origin: "null" },
				})
			).status,
		).toBe(403);
		expect(
			(
				await fetch(`${base}/v1/models`, {
					headers: { "Sec-Fetch-Site": "cross-site" },
				})
			).status,
		).toBe(403);
	});

	test("loopback 监听拒绝 rebound Host 并接受本机 Host", () => {
		h = createHarness();
		expect(
			browserRequestProblem(
				new Request("http://attacker.example/ctl/status"),
				h.config,
			),
		).toMatchObject({ status: 421 });
		for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
			expect(
				browserRequestProblem(
					new Request(`http://${host}:8787/ctl/status`),
					h.config,
				),
			).toBeUndefined();
		}
	});

	test("TLS 反向代理只接受显式 publicOrigin,不信任 forwarded proto", () => {
		h = createHarness({
			configPatch: {
				listen: { host: "0.0.0.0", port: 8787 },
				publicOrigin: "https://router.example",
				proxyToken: "proxy-token-123456",
				uiPassword: "console-pass-123",
			},
		});
		const proxied = new Request("http://router.example/ctl/status", {
			headers: { Origin: "https://router.example" },
		});
		expect(browserRequestProblem(proxied, h.config)).toBeUndefined();
		expect(
			browserRequestProblem(
				new Request("http://router.example/ctl/status", {
					headers: { Origin: "https://attacker.example" },
				}),
				h.config,
			),
		).toMatchObject({ status: 403 });
		h.config.publicOrigin = "";
		expect(
			browserRequestProblem(
				new Request("http://router.example/ctl/status", {
					headers: {
						Origin: "https://router.example",
						"X-Forwarded-Proto": "https",
					},
				}),
				h.config,
			),
		).toMatchObject({ status: 403 });
	});
});
