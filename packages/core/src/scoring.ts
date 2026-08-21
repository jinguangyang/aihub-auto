import {
	DEFAULT_ECONOMY_POLICY,
	DEFAULT_SCORE_WINDOW,
	DEFAULT_TOPN_MAX,
	MIN_CONFIDENCE,
	MODE_WEIGHTS,
} from "./defaults.ts";
import type {
	EvaluatedCandidate,
	Evaluation,
	ExcludedCandidate,
	GroupStat,
	LocalObservation,
	ScoredCandidate,
	ScoringOptions,
} from "./types.ts";

function exclude(
	stat: GroupStat,
	reason: ExcludedCandidate["excludeReason"],
	effectiveRate?: number,
): ExcludedCandidate {
	return effectiveRate === undefined
		? { stat, excluded: true, excludeReason: reason }
		: { stat, effectiveRate, excluded: true, excludeReason: reason };
}

function clamp01(value: number): number {
	return Math.min(Math.max(value, 0), 1);
}

function positive(value: number | undefined): number | undefined {
	return value !== undefined && Number.isFinite(value) && value > 0
		? value
		: undefined;
}

function geometricMean(values: readonly number[]): number | undefined {
	if (values.length === 0) return undefined;
	if (values.length === 1) return values[0];
	return Math.exp(
		values.reduce((total, value) => total + Math.log(value), 0) / values.length,
	);
}

function supportsModel(
	models: readonly string[] | undefined,
	requested: string,
): boolean {
	if (!models) return true;
	const target = requested.trim().toLowerCase();
	return models.some((model) => {
		const candidate = model.trim().toLowerCase();
		return (
			candidate === target ||
			(candidate.endsWith("*") && target.startsWith(candidate.slice(0, -1)))
		);
	});
}

/**
 * 硬约束 + 官网用户/云端探测/本地三源对数融合 + 失败/尾延迟风险修正。
 * 缺失来源不占权重;本地证据按实时置信度逐步接管上游基线。
 */
export function evaluate(
	stats: GroupStat[],
	options: ScoringOptions,
	localObs?: ReadonlyMap<number, LocalObservation>,
	/** 用户专属倍率(优先于公开倍率) */
	userRates?: ReadonlyMap<number, number>,
): Evaluation {
	const excluded: ExcludedCandidate[] = [];
	const blacklist = new Set(options.blacklist);
	const circuitOpen = new Set(options.circuitOpenGroupIds);
	const modelBlocked = new Set(options.modelBlockedGroupIds);
	const allowed = options.allowedGroupIds
		? new Set(options.allowedGroupIds)
		: undefined;

	interface Pre {
		stat: GroupStat;
		rate: number;
		publicConfidence: number;
		cloudProbeTtftMs?: number;
		userTtftMs?: number;
		userSampleCount: number;
		upstreamTtftMs?: number;
		localTtftMs?: number;
		localConfidence: number;
		localSampleCount: number;
		outcomeSampleCount: number;
		successRate: number;
		errorRate: number;
		confidence: number;
		blendedTtftMs: number;
		conservativeLatencyMs: number;
	}
	const pre: Pre[] = [];
	const economyExclude = (
		candidate: Pre,
		reason: "economy_unstable" | "economy_too_slow",
	): ExcludedCandidate => ({
		...exclude(candidate.stat, reason, candidate.rate),
		evidence: {
			cloudProbeTtftMs: candidate.cloudProbeTtftMs,
			userTtftMs: candidate.userTtftMs,
			userSampleCount: candidate.userSampleCount,
			upstreamTtftMs: candidate.upstreamTtftMs,
			localTtftMs: candidate.localTtftMs,
			localConfidence: candidate.localConfidence,
			localSampleCount: candidate.localSampleCount,
			outcomeSampleCount: candidate.outcomeSampleCount,
			successRate: candidate.successRate,
			confidence: candidate.confidence,
			blendedTtftMs: candidate.blendedTtftMs,
			conservativeLatencyMs: candidate.conservativeLatencyMs,
		},
	});

	for (const stat of stats) {
		if (stat.platform !== options.platform) {
			excluded.push(exclude(stat, "platform_mismatch"));
			continue;
		}
		if (stat.providerAvailable === false) {
			excluded.push(exclude(stat, "unavailable_group"));
			continue;
		}
		if (modelBlocked.has(stat.groupId)) {
			excluded.push(exclude(stat, "model_blocked"));
			continue;
		}
		if (allowed && !allowed.has(stat.groupId)) {
			excluded.push(
				exclude(
					stat,
					options.accountPoolFilterActive === true
						? "account_plan"
						: "unavailable_group",
				),
			);
			continue;
		}
		if (
			options.model &&
			stat.modelAvailabilityKnown === true &&
			!supportsModel(stat.supportedModels, options.model)
		) {
			excluded.push(exclude(stat, "model_unavailable"));
			continue;
		}

		const rate = userRates?.get(stat.groupId) ?? stat.rateMultiplier;
		if (!Number.isFinite(rate) || rate < 0) {
			excluded.push(exclude(stat, "invalid_rate"));
			continue;
		}
		if (rate < options.priceBand.min || rate > options.priceBand.max) {
			excluded.push(exclude(stat, "price_band", rate));
			continue;
		}
		if (blacklist.has(stat.groupId)) {
			excluded.push(exclude(stat, "blacklisted", rate));
			continue;
		}
		if (circuitOpen.has(stat.groupId)) {
			excluded.push(exclude(stat, "circuit_open", rate));
			continue;
		}

		const observation = localObs?.get(stat.groupId);
		const outcomeSampleCount =
			observation?.recentSamples ?? (observation ? observation.sampleCount : 0);
		const outcomeConfidence =
			observation?.outcomeConfidence ?? observation?.confidence ?? 0;
		const successRate =
			observation?.successRate ?? (observation ? 1 - observation.errorRate : 1);
		if (
			observation &&
			outcomeConfidence >= MIN_CONFIDENCE &&
			outcomeSampleCount >= 3 &&
			observation.errorRate > options.errorRateCap
		) {
			excluded.push(exclude(stat, "local_error_rate", rate));
			continue;
		}

		// 新 provider 用户均值与旧 usage-stats 是同类真实请求证据,只取一个,
		// 避免把同一批用户请求重复计权。云端探测是独立来源。
		const providerUserTtftMs = positive(stat.userAvgTtftMs);
		const userTtftMs = providerUserTtftMs ?? positive(stat.avgTtftMs);
		const userSampleCount =
			providerUserTtftMs === undefined
				? stat.sampleCount
				: (stat.userSampleCount ?? 0);
		const cloudProbeTtftMs = positive(stat.cloudProbeTtftMs);
		const upstreamTtftMs = geometricMean(
			[userTtftMs, cloudProbeTtftMs].filter(
				(value): value is number => value !== undefined,
			),
		);
		const publicConfidence = upstreamTtftMs === undefined ? 0 : 1;
		const localSampleCount =
			observation?.latencySampleCount ??
			(observation?.ewmaTtftMs !== undefined ? observation.sampleCount : 0);
		const localLatencyConfidence =
			observation?.latencyConfidence ?? observation?.confidence ?? 0;
		const localLatencyAvailable =
			localSampleCount > 0 && positive(observation?.ewmaTtftMs) !== undefined;
		const localConfidence = localLatencyAvailable
			? clamp01(localLatencyConfidence)
			: 0;
		const localRiskLatency = localLatencyAvailable
			? positive(
					observation?.peakEwmaTtftMs ??
						0.7 * observation!.ewmaTtftMs! +
							0.3 * (observation!.p90TtftMs ?? observation!.ewmaTtftMs!),
				)
			: undefined;

		if (
			upstreamTtftMs === undefined &&
			(localRiskLatency === undefined || localConfidence < MIN_CONFIDENCE)
		) {
			excluded.push(exclude(stat, "invalid_latency", rate));
			continue;
		}

		const blendedTtftMs =
			upstreamTtftMs === undefined
				? localRiskLatency!
				: localRiskLatency === undefined
					? upstreamTtftMs
					: Math.exp(
							Math.log(upstreamTtftMs) * (1 - localConfidence) +
								Math.log(localRiskLatency) * localConfidence,
						);
		const confidence =
			upstreamTtftMs === undefined ? localConfidence : publicConfidence;
		const errorRate = observation
			? Math.min(0.95, observation.errorRate * clamp01(outcomeConfidence))
			: 0;
		const conservativeLatencyMs =
			(blendedTtftMs * (2 - confidence)) / Math.max(1 - errorRate, 0.2);

		pre.push({
			stat,
			rate,
			publicConfidence,
			cloudProbeTtftMs,
			userTtftMs,
			userSampleCount,
			upstreamTtftMs,
			localTtftMs: localRiskLatency,
			localConfidence,
			localSampleCount,
			outcomeSampleCount,
			successRate,
			errorRate,
			confidence,
			blendedTtftMs,
			conservativeLatencyMs,
		});
	}

	if (pre.length === 0) return { eligible: [], standby: [], excluded };

	const strictEconomy = options.mode === "economy";
	const economyPolicy = options.economyPolicy ?? DEFAULT_ECONOMY_POLICY;
	const priceCandidates = strictEconomy
		? pre.filter((candidate) => {
				if (
					(candidate.outcomeSampleCount > 0 && candidate.successRate <= 0) ||
					(candidate.outcomeSampleCount >= economyPolicy.minOutcomeSamples &&
						candidate.successRate < economyPolicy.minSuccessRate)
				) {
					excluded.push(economyExclude(candidate, "economy_unstable"));
					return false;
				}
				if (
					candidate.conservativeLatencyMs >
					economyPolicy.maxConservativeLatencyMs
				) {
					excluded.push(economyExclude(candidate, "economy_too_slow"));
					return false;
				}
				return true;
			})
		: pre;
	if (priceCandidates.length === 0) {
		return { eligible: [], standby: [], excluded };
	}

	const minimumRate = Math.min(
		...priceCandidates.map((candidate) => candidate.rate),
	);
	const fastestPre = priceCandidates.reduce((left, right) =>
		right.conservativeLatencyMs < left.conservativeLatencyMs ? right : left,
	);
	const weights = MODE_WEIGHTS[options.mode];
	const zeroBase = minimumRate <= 0;

	const scored: ScoredCandidate[] = priceCandidates.map((candidate) => {
		const speedup =
			fastestPre.conservativeLatencyMs / candidate.conservativeLatencyMs - 1;
		const premium = zeroBase
			? candidate.rate <= 0
				? 0
				: Number.POSITIVE_INFINITY
			: (candidate.rate - minimumRate) / minimumRate;
		const pricePenalty = zeroBase
			? candidate.rate <= 0
				? 0
				: Number.POSITIVE_INFINITY
			: Math.log(candidate.rate / minimumRate);
		const latencyGain = Math.log(
			fastestPre.conservativeLatencyMs / candidate.conservativeLatencyMs,
		);
		const score =
			zeroBase && candidate.rate > 0
				? Number.NEGATIVE_INFINITY
				: weights.latencyWeight * latencyGain -
					weights.priceWeight * pricePenalty;

		return {
			stat: candidate.stat,
			effectiveRate: candidate.rate,
			publicConfidence: candidate.publicConfidence,
			cloudProbeTtftMs: candidate.cloudProbeTtftMs,
			userTtftMs: candidate.userTtftMs,
			userSampleCount: candidate.userSampleCount,
			upstreamTtftMs: candidate.upstreamTtftMs,
			localTtftMs: candidate.localTtftMs,
			localConfidence: candidate.localConfidence,
			localSampleCount: candidate.localSampleCount,
			outcomeSampleCount: candidate.outcomeSampleCount,
			successRate: candidate.successRate,
			errorRate: candidate.errorRate,
			confidence: candidate.confidence,
			blendedTtftMs: candidate.blendedTtftMs,
			conservativeLatencyMs: candidate.conservativeLatencyMs,
			premium,
			speedup,
			score,
			excluded: false,
		};
	});

	sortCandidates(scored);
	const eligible = strictEconomy
		? scored.filter((candidate) => candidate.effectiveRate === minimumRate)
		: scored;
	const standby = strictEconomy
		? scored
				.filter((candidate) => candidate.effectiveRate > minimumRate)
				.sort(
					(left, right) =>
						left.effectiveRate - right.effectiveRate ||
						left.conservativeLatencyMs - right.conservativeLatencyMs,
				)
		: [];
	const baseline = eligible
		.filter((candidate) => Number.isFinite(candidate.score))
		.reduce<ScoredCandidate | undefined>(
			(best, candidate) =>
				!best || candidate.conservativeLatencyMs < best.conservativeLatencyMs
					? candidate
					: best,
			undefined,
		);
	return { eligible, standby, excluded, minimumRate, baseline };
}

/** 降序:score -> 生效倍率低 -> 保守延迟低 -> groupId 小 */
export function sortCandidates(list: ScoredCandidate[]): void {
	list.sort((left, right) => {
		if (left.score !== right.score) return right.score - left.score;
		if (left.effectiveRate !== right.effectiveRate) {
			return left.effectiveRate - right.effectiveRate;
		}
		if (left.conservativeLatencyMs !== right.conservativeLatencyMs) {
			return left.conservativeLatencyMs - right.conservativeLatencyMs;
		}
		return left.stat.groupId - right.stat.groupId;
	});
}

export function recommendTopN(
	evaluation: Evaluation,
	opts?: { scoreWindow?: number; max?: number },
): ScoredCandidate[] {
	const scoreWindow = opts?.scoreWindow ?? DEFAULT_SCORE_WINDOW;
	const max = opts?.max ?? DEFAULT_TOPN_MAX;
	const list = evaluation.eligible.filter((candidate) =>
		Number.isFinite(candidate.score),
	);
	if (list.length === 0) return [];
	const best = list[0]!.score;
	return list
		.filter((candidate) => candidate.score >= best - scoreWindow)
		.slice(0, Math.max(1, max));
}

export function allCandidates(evaluation: Evaluation): EvaluatedCandidate[] {
	return [
		...evaluation.eligible,
		...evaluation.standby,
		...evaluation.excluded,
	];
}
