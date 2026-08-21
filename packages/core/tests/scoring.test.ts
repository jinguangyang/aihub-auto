import { describe, expect, test } from "bun:test";
import { evaluate, recommendTopN } from "../src/index.ts";
import type { GroupStat, LocalObservation } from "../src/index.ts";
import { NOW, opts, stat } from "./helpers.ts";

describe("硬过滤", () => {
	test("model capabilities support exact case-insensitive and trailing wildcard matches", () => {
		const ev = evaluate(
			[
				stat({
					groupId: 1,
					supportedModels: [" gPt-4O-MINI "],
					modelAvailabilityKnown: true,
				}),
				stat({
					groupId: 2,
					supportedModels: ["GPT-4O-*"],
					modelAvailabilityKnown: true,
				}),
				stat({
					groupId: 3,
					supportedModels: [],
					modelAvailabilityKnown: true,
				}),
				stat({ groupId: 4 }),
			],
			opts({ model: "gpt-4o-mini" }),
		);
		expect(ev.eligible.map((candidate) => candidate.stat.groupId)).toEqual([
			1,
			2,
			4,
		]);
		expect(ev.excluded).toContainEqual(
			expect.objectContaining({
				stat: expect.objectContaining({ groupId: 3 }),
				excludeReason: "model_unavailable",
			}),
		);
	});

	test("account pool misses use account_plan while legacy allowed-group misses remain unavailable", () => {
		const poolFiltered = evaluate(
			[stat({ groupId: 1 })],
			opts({ allowedGroupIds: [2], accountPoolFilterActive: true }),
		);
		expect(poolFiltered.excluded[0]?.excludeReason).toBe("account_plan");

		const legacy = evaluate(
			[stat({ groupId: 1 })],
			opts({ allowedGroupIds: [2] }),
		);
		expect(legacy.excluded[0]?.excludeReason).toBe("unavailable_group");
	});

	test("model blocks precede account-plan and rate checks", () => {
		const ev = evaluate(
			[stat({ groupId: 1, rateMultiplier: Number.NaN })],
			opts({
				allowedGroupIds: [],
				accountPoolFilterActive: true,
				modelBlockedGroupIds: [1],
			}),
		);
		expect(ev.excluded[0]?.excludeReason).toBe("model_blocked");
	});

	test("platform and provider availability keep precedence over model policy", () => {
		const ev = evaluate(
			[
				stat({ groupId: 1, platform: "invalid" as never }),
				stat({ groupId: 2, providerAvailable: false }),
			],
			opts({
				model: "gpt-4o",
				modelBlockedGroupIds: [1, 2],
			}),
		);
		expect(ev.excluded).toEqual([
			expect.objectContaining({ excludeReason: "platform_mismatch" }),
			expect.objectContaining({ excludeReason: "unavailable_group" }),
		]);
	});

	test("平台不匹配被排除", () => {
		const ev = evaluate(
			[stat({ groupId: 1, platform: "invalid" as never })],
			opts(),
		);
		expect(ev.eligible).toHaveLength(0);
		expect(ev.excluded[0]?.excludeReason).toBe("platform_mismatch");
	});

	test("provider 已标记不可用时排除残留 usage 统计", () => {
		const ev = evaluate(
			[
				stat({ groupId: 48, providerAvailable: false, avgTtftMs: 100 }),
				stat({ groupId: 49, providerAvailable: true, avgTtftMs: 1000 }),
			],
			opts(),
		);
		expect(ev.eligible.map((candidate) => candidate.stat.groupId)).toEqual([
			49,
		]);
		expect(ev.excluded).toEqual([
			expect.objectContaining({
				stat: expect.objectContaining({ groupId: 48 }),
				excludeReason: "unavailable_group",
			}),
		]);
	});

	test("价格区间硬边界:0.15 含,0.151 排除", () => {
		const ev = evaluate(
			[
				stat({ groupId: 1, rateMultiplier: 0.15 }),
				stat({ groupId: 2, rateMultiplier: 0.151 }),
			],
			opts(),
		);
		expect(ev.eligible.map((c) => c.stat.groupId)).toEqual([1]);
		expect(ev.excluded[0]?.excludeReason).toBe("price_band");
	});

	test("倍率非法(负/NaN)排除", () => {
		const ev = evaluate(
			[
				stat({ groupId: 1, rateMultiplier: -0.1 }),
				stat({ groupId: 2, rateMultiplier: NaN }),
			],
			opts(),
		);
		expect(ev.eligible).toHaveLength(0);
		expect(ev.excluded.every((e) => e.excludeReason === "invalid_rate")).toBe(
			true,
		);
	});

	test("黑名单排除", () => {
		const ev = evaluate([stat({ groupId: 7 })], opts({ blacklist: [7] }));
		expect(ev.excluded[0]?.excludeReason).toBe("blacklisted");
	});

	test("熔断冷却与用户黑名单分开呈现", () => {
		const ev = evaluate(
			[stat({ groupId: 7 }), stat({ groupId: 8 })],
			opts({ blacklist: [7], circuitOpenGroupIds: [8] }),
		);
		expect(ev.excluded).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					stat: expect.objectContaining({ groupId: 7 }),
					excludeReason: "blacklisted",
				}),
				expect.objectContaining({
					stat: expect.objectContaining({ groupId: 8 }),
					excludeReason: "circuit_open",
				}),
			]),
		);
	});

	test("上游样本时间和数量不参与排除", () => {
		const ev = evaluate(
			[
				stat({
					groupId: 1,
					sampleCount: 0,
					lastSampleAt: new Date(NOW - 24 * 60 * 60_000).toISOString(),
				}),
				stat({
					groupId: 2,
					sampleCount: 1,
					lastSampleAt: new Date(NOW + 2 * 60_000).toISOString(),
				}),
				stat({ groupId: 3, sampleCount: 0, lastSampleAt: "invalid" }),
			],
			opts(),
		);
		expect(ev.eligible.map((c) => c.stat.groupId)).toEqual([1, 2, 3]);
		expect(ev.excluded).toHaveLength(0);
	});

	test("上下游延迟都无效才排除", () => {
		const ev = evaluate([stat({ groupId: 2, avgTtftMs: 0 })], opts());
		expect(ev.eligible).toHaveLength(0);
		expect(ev.excluded[0]?.excludeReason).toBe("invalid_latency");
	});

	test("本地错误率超阈直接淘汰", () => {
		const obs = new Map<number, LocalObservation>([
			[
				1,
				{
					groupId: 1,
					ewmaTtftMs: 500,
					errorRate: 0.8,
					sampleCount: 10,
					lastAt: NOW,
					confidence: 0.9,
				},
			],
		]);
		const ev = evaluate(
			[stat({ groupId: 1 }), stat({ groupId: 2 })],
			opts(),
			obs,
		);
		expect(ev.eligible.map((c) => c.stat.groupId)).toEqual([2]);
		expect(ev.excluded[0]?.excludeReason).toBe("local_error_rate");
	});
});

describe("评分与模式", () => {
	// 便宜慢组 vs 贵快组;快组足够快时,旧版 economy 也会选它。
	const cheap = stat({ groupId: 1, rateMultiplier: 0.02, avgTtftMs: 5000 });
	const fast = stat({ groupId: 2, rateMultiplier: 0.08, avgTtftMs: 200 });

	test("economy 当前层锁定最低健康倍率,高价健康组进入可用升档", () => {
		const eco = evaluate([cheap, fast], opts({ mode: "economy" }));
		expect(eco.eligible.map((candidate) => candidate.stat.groupId)).toEqual([
			1,
		]);
		expect(eco.standby.map((candidate) => candidate.stat.groupId)).toEqual([2]);
		expect(eco.excluded).toHaveLength(0);
		const spd = evaluate([cheap, fast], opts({ mode: "speed" }));
		expect(spd.eligible[0]?.stat.groupId).toBe(2);
		expect(spd.standby).toHaveLength(0);
	});

	test("economy 有结果但 0% 稳定率时不进入可用升档", () => {
		const obs = new Map<number, LocalObservation>([
			[
				2,
				{
					groupId: 2,
					errorRate: 1,
					successRate: 0,
					sampleCount: 1,
					recentSamples: 1,
					lastAt: NOW,
					confidence: 1,
				},
			],
		]);
		const ev = evaluate(
			[
				stat({ groupId: 1, rateMultiplier: 0.02, avgTtftMs: 3000 }),
				stat({ groupId: 2, rateMultiplier: 0.04, avgTtftMs: 2000 }),
			],
			opts({ mode: "economy" }),
			obs,
		);
		expect(ev.eligible.map((candidate) => candidate.stat.groupId)).toEqual([1]);
		expect(ev.standby).toHaveLength(0);
		expect(ev.excluded).toContainEqual(
			expect.objectContaining({
				stat: expect.objectContaining({ groupId: 2 }),
				excludeReason: "economy_unstable",
				evidence: expect.objectContaining({
					successRate: 0,
					outcomeSampleCount: 1,
				}),
			}),
		);
	});

	test("economy 最低价层不稳定或太慢时升到下一健康价格层", () => {
		const obs = new Map<number, LocalObservation>([
			[
				1,
				{
					groupId: 1,
					ewmaTtftMs: 4000,
					errorRate: 0.3,
					successRate: 0.7,
					sampleCount: 5,
					recentSamples: 5,
					outcomeConfidence: 1,
					lastAt: NOW,
					confidence: 1,
				},
			],
		]);
		const unstable = evaluate(
			[cheap, stat({ groupId: 2, rateMultiplier: 0.03, avgTtftMs: 3000 })],
			opts({ mode: "economy" }),
			obs,
		);
		expect(unstable.eligible[0]?.stat.groupId).toBe(2);
		expect(unstable.excluded[0]?.excludeReason).toBe("economy_unstable");
		expect(unstable.excluded[0]?.evidence).toMatchObject({
			successRate: 0.7,
			outcomeSampleCount: 5,
			localSampleCount: 5,
		});

		const slow = evaluate(
			[
				stat({ groupId: 1, rateMultiplier: 0.01, avgTtftMs: 30_000 }),
				stat({ groupId: 2, rateMultiplier: 0.02, avgTtftMs: 3000 }),
			],
			opts({ mode: "economy" }),
		);
		expect(slow.eligible[0]?.stat.groupId).toBe(2);
		expect(slow.excluded[0]?.excludeReason).toBe("economy_too_slow");
		expect(slow.excluded[0]?.evidence).toMatchObject({
			blendedTtftMs: 30_000,
			conservativeLatencyMs: 30_000,
		});
	});

	test("基准溢价为 0,溢价按最低倍率计算", () => {
		const ev = evaluate([cheap, fast], opts());
		const base = ev.eligible.find((c) => c.stat.groupId === 1)!;
		const other = ev.eligible.find((c) => c.stat.groupId === 2)!;
		expect(base.premium).toBe(0);
		expect(other.premium).toBeCloseTo((0.08 - 0.02) / 0.02, 5);
		expect(ev.minimumRate).toBe(0.02);
	});

	test("三种模式:省钱锁最低价,均衡取几何折中,速度偏向低延迟", () => {
		const groups = [
			stat({ groupId: 1, rateMultiplier: 0.05, avgTtftMs: 4000 }),
			stat({ groupId: 2, rateMultiplier: 0.1, avgTtftMs: 2200 }),
		];
		expect(
			evaluate(groups, opts({ mode: "economy" })).eligible[0]?.stat.groupId,
		).toBe(1);
		expect(
			evaluate(groups, opts({ mode: "balanced" })).eligible[0]?.stat.groupId,
		).toBe(1);
		expect(
			evaluate(groups, opts({ mode: "speed" })).eligible[0]?.stat.groupId,
		).toBe(2);
	});

	test("对数效用的相对排序不受无关候选或统一量纲缩放影响", () => {
		const a = stat({ groupId: 1, rateMultiplier: 0.05, avgTtftMs: 1200 });
		const b = stat({ groupId: 2, rateMultiplier: 0.1, avgTtftMs: 500 });
		const difference = (items: GroupStat[]) => {
			const evaluation = evaluate(items, opts({ mode: "balanced" }));
			const left = evaluation.eligible.find(
				(candidate) => candidate.stat.groupId === 1,
			)!;
			const right = evaluation.eligible.find(
				(candidate) => candidate.stat.groupId === 2,
			)!;
			return left.score - right.score;
		};
		const pairDifference = difference([a, b]);
		expect(
			difference([
				a,
				b,
				stat({ groupId: 3, rateMultiplier: 0.01, avgTtftMs: 10_000 }),
			]),
		).toBeCloseTo(pairDifference, 10);
		expect(
			difference([
				{
					...a,
					rateMultiplier: a.rateMultiplier * 1.2,
					avgTtftMs: a.avgTtftMs * 3,
				},
				{
					...b,
					rateMultiplier: b.rateMultiplier * 1.2,
					avgTtftMs: b.avgTtftMs * 3,
				},
			]),
		).toBeCloseTo(pairDifference, 10);
	});

	test("零倍率基准:非零倍率得分 −∞,零倍率按延迟竞争", () => {
		const ev = evaluate(
			[
				stat({ groupId: 1, rateMultiplier: 0, avgTtftMs: 4000 }),
				stat({ groupId: 2, rateMultiplier: 0, avgTtftMs: 2000 }),
				stat({ groupId: 3, rateMultiplier: 0.05, avgTtftMs: 500 }),
			],
			opts(),
		);
		expect(ev.eligible[0]?.stat.groupId).toBe(2);
		const paid = ev.eligible.find((c) => c.stat.groupId === 3)!;
		expect(paid.score).toBe(Number.NEGATIVE_INFINITY);
	});

	test("tie-break:同分时倍率低→延迟低→groupId 小", () => {
		const a = stat({ groupId: 9, rateMultiplier: 0.05, avgTtftMs: 3000 });
		const b = stat({ groupId: 3, rateMultiplier: 0.05, avgTtftMs: 3000 });
		const ev = evaluate([a, b], opts());
		expect(ev.eligible.map((c) => c.stat.groupId)).toEqual([3, 9]);
	});

	test("用户专属倍率覆盖公开倍率", () => {
		const ev = evaluate(
			[stat({ groupId: 1, rateMultiplier: 0.5 })],
			opts(),
			undefined,
			new Map([[1, 0.03]]),
		);
		expect(ev.eligible).toHaveLength(1);
		expect(ev.minimumRate).toBe(0.03);
	});

	test("本地融合:高置信度本地观测拉动 blended 延迟", () => {
		const obs = new Map<number, LocalObservation>([
			[
				1,
				{
					groupId: 1,
					ewmaTtftMs: 1000,
					errorRate: 0,
					sampleCount: 20,
					lastAt: NOW,
					confidence: 1,
				},
			],
		]);
		const ev = evaluate([stat({ groupId: 1, avgTtftMs: 5000 })], opts(), obs);
		expect(ev.eligible[0]?.blendedTtftMs).toBeCloseTo(1000, 0);
	});

	test("有本地样本时按置信度与上游在对数空间双向融合", () => {
		const faster = new Map<number, LocalObservation>([
			[
				1,
				{
					groupId: 1,
					ewmaTtftMs: 1000,
					errorRate: 0,
					sampleCount: 5,
					lastAt: NOW,
					confidence: 0.5,
				},
			],
		]);
		const local = evaluate(
			[stat({ groupId: 1, avgTtftMs: 3000 })],
			opts(),
			faster,
		);
		expect(local.eligible[0]?.blendedTtftMs).toBeCloseTo(
			Math.sqrt(3000 * 1000),
			6,
		);

		faster.get(1)!.ewmaTtftMs = 5000;
		const upstream = evaluate(
			[stat({ groupId: 1, avgTtftMs: 3000 })],
			opts(),
			faster,
		);
		expect(upstream.eligible[0]?.blendedTtftMs).toBeCloseTo(
			Math.sqrt(3000 * 5000),
			6,
		);
	});

	test("官网用户、云端探测与本地风险 TTFT 三源融合且不重复旧用户字段", () => {
		const obs = new Map<number, LocalObservation>([
			[
				1,
				{
					groupId: 1,
					ewmaTtftMs: 8000,
					peakEwmaTtftMs: 8000,
					latencySampleCount: 5,
					latencyConfidence: 0.5,
					errorRate: 0,
					sampleCount: 5,
					lastAt: NOW,
					confidence: 0.5,
				},
			],
		]);
		const candidate = evaluate(
			[
				stat({
					groupId: 1,
					avgTtftMs: 9000,
					userAvgTtftMs: 4000,
					userSampleCount: 50,
					cloudProbeTtftMs: 1000,
				}),
			],
			opts(),
			obs,
		).eligible[0]!;
		expect(candidate.userTtftMs).toBe(4000);
		expect(candidate.userSampleCount).toBe(50);
		expect(candidate.cloudProbeTtftMs).toBe(1000);
		expect(candidate.upstreamTtftMs).toBeCloseTo(2000, 6);
		expect(candidate.localTtftMs).toBe(8000);
		expect(candidate.blendedTtftMs).toBeCloseTo(4000, 6);
	});

	test("官网新字段为 0 或无数据时回退旧用户均值", () => {
		const candidate = evaluate(
			[
				stat({
					groupId: 1,
					avgTtftMs: 3000,
					userAvgTtftMs: 0,
					userSampleCount: 0,
					cloudProbeTtftMs: 0,
				}),
			],
			opts(),
		).eligible[0]!;
		expect(candidate.userTtftMs).toBe(3000);
		expect(candidate.upstreamTtftMs).toBe(3000);
		expect(candidate.blendedTtftMs).toBe(3000);
	});

	test("本地 TTFT 为零样本时完全忽略本地延迟", () => {
		const obs = new Map<number, LocalObservation>([
			[
				1,
				{
					groupId: 1,
					ewmaTtftMs: 100,
					latencySampleCount: 0,
					latencyConfidence: 1,
					errorRate: 0,
					sampleCount: 0,
					lastAt: NOW,
					confidence: 1,
				},
			],
		]);
		const candidate = evaluate(
			[stat({ groupId: 1, avgTtftMs: 3000 })],
			opts(),
			obs,
		).eligible[0]!;
		expect(candidate.blendedTtftMs).toBe(3000);
		expect(candidate.localSampleCount).toBe(0);
	});

	test("有效上游 TTFT 不因样本时间或数量降权", () => {
		const upstream = stat({
			groupId: 1,
			avgTtftMs: 1000,
			sampleCount: 0,
			lastSampleAt: "invalid",
		});
		const candidate = evaluate([upstream], opts()).eligible[0]!;
		expect(candidate.blendedTtftMs).toBe(1000);
		expect(candidate.conservativeLatencyMs).toBe(1000);
		expect(candidate.publicConfidence).toBe(1);
	});
});

describe("recommendTopN", () => {
	test("窗口截断:仅保留 best−window 内候选", () => {
		const ev = evaluate(
			[
				stat({ groupId: 1, rateMultiplier: 0.02, avgTtftMs: 1000 }),
				stat({ groupId: 2, rateMultiplier: 0.02, avgTtftMs: 1050 }),
				stat({ groupId: 3, rateMultiplier: 0.14, avgTtftMs: 9000 }),
			],
			opts(),
		);
		const top = recommendTopN(ev, { scoreWindow: 0.15, max: 6 });
		expect(top.map((c) => c.stat.groupId)).toEqual([1, 2]);
	});

	test("至少 1 条(有候选时)", () => {
		const ev = evaluate([stat({ groupId: 1 })], opts());
		expect(recommendTopN(ev, { scoreWindow: 0 })).toHaveLength(1);
	});

	test("至多 max 条", () => {
		const stats = Array.from({ length: 10 }, (_, i) =>
			stat({ groupId: i + 1, rateMultiplier: 0.05, avgTtftMs: 3000 + i }),
		);
		const ev = evaluate(stats, opts());
		expect(recommendTopN(ev, { scoreWindow: 10, max: 6 })).toHaveLength(6);
		expect(recommendTopN(ev, { scoreWindow: 10 })).toHaveLength(6);
	});

	test("无候选返回空", () => {
		const ev = evaluate([], opts());
		expect(recommendTopN(ev)).toHaveLength(0);
	});

	test("−∞ 分不进推荐", () => {
		const ev = evaluate(
			[
				stat({ groupId: 1, rateMultiplier: 0 }),
				stat({ groupId: 2, rateMultiplier: 0.05 }),
			],
			opts(),
		);
		const top = recommendTopN(ev, { scoreWindow: 100 });
		expect(top.map((c) => c.stat.groupId)).toEqual([1]);
	});
});
