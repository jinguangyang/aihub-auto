/** AIHub 当前仅提供 OpenAI 分组。 */
export type Platform = "openai";

export const PLATFORMS: readonly Platform[] = ["openai"];

/** /api/v1/public/groups/usage-stats 单条分组统计 */
export interface GroupStat {
	code: string;
	platform: Platform;
	supportedModels?: string[];
	modelAvailabilityKnown?: boolean;
	rateMultiplier: number;
	/** 旧 usage-stats 的真实请求平均 TTFT;新接口缺失时作为用户均值回退。 */
	avgTtftMs: number;
	/** 官网 provider 列表明确标记的当前可用性;false 时硬排除历史 usage 条目。 */
	providerAvailable?: boolean;
	/** 官网标准化云端探测端到端 TTFT。 */
	cloudProbeTtftMs?: number;
	/** 官网真实用户平均 TTFT。 */
	userAvgTtftMs?: number;
	/** 官网真实用户 TTFT 样本数;只用于解释,不因样本少排除。 */
	userSampleCount?: number;
	sampleCount: number;
	/** ISO 8601 */
	lastSampleAt: string;
	groupId: number;
}

export interface UsageStatsPage {
	items: GroupStat[];
	total: number;
	sampleLimit: number;
}

export interface ProviderLatencyStat {
	groupId: number;
	platform: Platform;
	supportedModels?: string[];
	modelAvailabilityKnown?: boolean;
	available?: boolean;
	cloudProbeTtftMs?: number;
	userAvgTtftMs?: number;
	userSampleCount: number;
}

export interface GroupInfo {
	id: number;
	name: string;
	platform?: string;
	rateMultiplier?: number;
}

export interface ApiKeyInfo {
	id: number;
	name: string;
	/** sk- 明文,通常仅创建响应携带 */
	key?: string;
	groupId: number | null;
	status?: string;
	createdAt?: string;
}

export interface AuthSession {
	accessToken: string;
	refreshToken?: string;
	/** epoch ms */
	expiresAt?: number;
}

export type RoutingMode = "economy" | "balanced" | "speed";

export interface ModeWeights {
	priceWeight: number;
	latencyWeight: number;
}

export interface EconomyPolicy {
	/** 达到该样本数后启用最低稳定率门槛;已有结果但 0% 成功率会立即淘汰。 */
	minOutcomeSamples: number;
	/** 最近 3 小时最低成功率。 */
	minSuccessRate: number;
	/** 可进入价格层选择的最大保守 TTFT。 */
	maxConservativeLatencyMs: number;
}

/** 反代实测得到的单组本地观测(由 LocalObservationStore 提供) */
export interface LocalObservation {
	groupId: number;
	/** 常规 EWMA 首字延迟;纯失败组可能没有 */
	ewmaTtftMs?: number;
	/** 对延迟突增立即响应、缓慢恢复的 Peak EWMA */
	peakEwmaTtftMs?: number;
	/** 最近窗口首字延迟 P90 */
	p90TtftMs?: number;
	/** 最近 3 小时最终结果窗口的错误率 0..1。 */
	errorRate: number;
	/** 最近 3 小时最终结果窗口的成功率 0..1;旧观测对象可省略。 */
	successRate?: number;
	/** 近窗口 TTFT 变异系数(std/mean),样本不足时为 undefined */
	cv?: number;
	/** 已完成请求结果总数 */
	sampleCount: number;
	/** 最近 3 小时结果窗口中的样本数(最多 500 条)。 */
	recentSamples?: number;
	/** 最近窗口中的 TTFT 样本数 */
	latencySampleCount?: number;
	/** epoch ms,最后一次任意观测(兼容字段) */
	lastAt: number;
	/** 最后一个真实 TTFT 样本;失败结果不得刷新它。 */
	latencyLastAt?: number;
	/** 最后一个最终成败结果。 */
	outcomeLastAt?: number;
	/** TTFT 样本量与新鲜度置信度。 */
	latencyConfidence?: number;
	/** 最终成败样本量与新鲜度置信度。 */
	outcomeConfidence?: number;
	/** 0..1,兼容字段;取延迟/结果证据的联合置信度。 */
	confidence: number;
}

export interface ScoringOptions {
	mode: RoutingMode;
	model?: string;
	modelBlockedGroupIds?: readonly number[];
	accountPoolFilterActive?: boolean;
	/** 生效倍率硬约束区间(含边界) */
	priceBand: { min: number; max: number };
	/** 用户明确配置的 groupId 黑名单。 */
	blacklist: number[];
	/** 熔断器冷却中的组;与用户黑名单分开呈现。 */
	circuitOpenGroupIds?: readonly number[];
	/** 省钱模式的显式健康门槛。 */
	economyPolicy?: EconomyPolicy;
	/** 账号实际可用分组;未取得时不限制 */
	allowedGroupIds?: readonly number[];
	/** 本地错误率淘汰阈值 */
	errorRateCap: number;
	/** 目标平台 */
	platform: Platform;
	/** epoch ms */
	now: number;
}

export type ExcludeReason =
	| "platform_mismatch"
	| "unavailable_group"
	| "account_plan"
	| "model_unavailable"
	| "model_blocked"
	| "invalid_rate"
	| "price_band"
	| "blacklisted"
	| "circuit_open"
	| "invalid_latency"
	| "local_error_rate"
	/** economy 最低价层近期结果不稳定,自动升到下一层。 */
	| "economy_unstable"
	/** economy 最低价层延迟极端,自动升到下一层。 */
	| "economy_too_slow";

export interface ScoredCandidate {
	stat: GroupStat;
	/** 用户专属倍率覆盖后的真实倍率 */
	effectiveRate: number;
	/** 上游延迟证据可用度 0..1。 */
	publicConfidence: number;
	/** 官网云端探测 TTFT。 */
	cloudProbeTtftMs?: number;
	/** 官网真实用户平均 TTFT(旧 usage-stats 可回退)。 */
	userTtftMs?: number;
	userSampleCount: number;
	/** 两路上游证据的对数融合 TTFT。 */
	upstreamTtftMs?: number;
	/** 本地 Peak/P90 风险 TTFT。 */
	localTtftMs?: number;
	/** 本地观测置信度 0..1 */
	localConfidence: number;
	localSampleCount: number;
	/** 最近 3 小时本地最终结果窗口样本数。 */
	outcomeSampleCount: number;
	/** 最近 3 小时本地最终结果窗口成功率。 */
	successRate: number;
	/** 本地近期失败率 */
	errorRate: number;
	/** 本地融合后的延迟(未保守修正) */
	blendedTtftMs: number;
	/** 综合不确定性、尾延迟与失败重试成本后的延迟 */
	conservativeLatencyMs: number;
	/** 相对最低倍率的溢价比;基准为 0 */
	premium: number;
	/** 相对基准的速度收益比 */
	speedup: number;
	/** 加权得分,越大越好 */
	score: number;
	/** 综合置信度 0..1 */
	confidence: number;
	excluded: false;
}

export interface ExcludedCandidate {
	stat: GroupStat;
	/** 已知时使用账号专属倍率,避免控制台回退为公开倍率。 */
	effectiveRate?: number;
	/** 进入 economy 健康门槛后被排除时保留的解释证据。 */
	evidence?: Pick<
		ScoredCandidate,
		| "cloudProbeTtftMs"
		| "userTtftMs"
		| "userSampleCount"
		| "upstreamTtftMs"
		| "localTtftMs"
		| "localConfidence"
		| "localSampleCount"
		| "outcomeSampleCount"
		| "successRate"
		| "confidence"
		| "blendedTtftMs"
		| "conservativeLatencyMs"
	>;
	excluded: true;
	excludeReason: ExcludeReason;
}

export type EvaluatedCandidate = ScoredCandidate | ExcludedCandidate;

export interface Evaluation {
	/** 当前模式直接参与路由的候选。 */
	eligible: ScoredCandidate[];
	/** economy 下健康可用但价格更高的升档候选。 */
	standby: ScoredCandidate[];
	excluded: ExcludedCandidate[];
	/** 最低有效倍率(基准),无候选时 undefined */
	minimumRate?: number;
	/** 当前可路由候选中保守延迟最低者。 */
	baseline?: ScoredCandidate;
}

/** 反代当前流量情况(Koishi 等无流量场景传 idleTraffic()) */
export interface TrafficSnapshot {
	/** epoch ms,最近一次请求 */
	lastRequestAt?: number;
	activeStreams: number;
	requestsLast5m: number;
	/** groupId 字符串 -> 在飞请求 */
	activeByGroup?: Record<string, number>;
}

export interface RouteState {
	currentGroupId?: number;
	/** epoch ms */
	lastSwitchAt?: number;
	pendingSwitch?: { groupId: number; since: number };
}

export interface DecisionPolicy {
	/** 基础粘性:得分优势须超过它才考虑切换 */
	stickiness: number;
	/** 缓存惩罚上限,按流量新近度线性叠加到门槛 */
	cachePenaltyMax: number;
	/** 空闲超过该时长视为缓存已冷,惩罚归零 */
	cacheIdleMs: number;
	/** 切换后最短驻留 */
	minDwellMs: number;
}

export type DecisionReason =
	| "no_candidate"
	| "initial_route"
	| "manual_lock"
	| "current_invalid"
	| "failover"
	| "already_optimal"
	| "dwell"
	| "hold_sticky"
	| "hold_cache"
	| "better_price"
	| "faster_weighted"
	| "pending_realized";

export interface Decision {
	targetGroupId?: number;
	shouldSwitch: boolean;
	reason: DecisionReason;
	currentScore?: number;
	targetScore?: number;
	/** targetScore - currentScore */
	advantage?: number;
	/** 本次实际生效的切换门槛 */
	effectiveThreshold: number;
	nextState: RouteState;
}
