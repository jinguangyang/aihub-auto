import type {
	ApiKeyInfo,
	AuthSession,
	GroupInfo,
	GroupStat,
	Platform,
	ProviderLatencyStat,
	UsageStatsPage,
} from "./types.ts";

export class AIHubApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code?: string,
	) {
		super(message);
		this.name = "AIHubApiError";
	}
}

export interface AIHubClientOptions {
	baseUrl: string;
	/** 账号 Bearer token(公开接口不需要) */
	token?: () => string | undefined;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
	userAgent?: string;
}

interface Envelope {
	code?: number | string;
	message?: string;
	data?: unknown;
}

function num(v: unknown): number {
	if (typeof v === "number") return v;
	if (typeof v === "string" && v.trim() !== "") {
		const n = Number(v);
		if (Number.isFinite(n)) return n;
	}
	return NaN;
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function asRecord(v: unknown): Record<string, unknown> {
	return typeof v === "object" && v !== null
		? (v as Record<string, unknown>)
		: {};
}

function modelNames(raw: unknown): string[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	return raw
		.map((item) =>
			typeof item === "string"
				? item
				: str(
						asRecord(item)["model"] ??
							asRecord(item)["name"] ??
							asRecord(item)["id"],
					),
		)
		.map((value) => value.trim())
		.filter(Boolean);
}

function supportedModelsFrom(record: Record<string, unknown>): {
	models?: string[];
	known?: boolean;
} {
	for (const key of [
		"models",
		"supported_models",
		"available_models",
		"model_names",
	]) {
		if (!(key in record)) continue;
		const models = modelNames(record[key]);
		return { models: models ?? [], known: models !== undefined };
	}
	return {};
}

export function parseGroupStat(raw: unknown): GroupStat | undefined {
	const r = asRecord(raw);
	const platform = str(r["platform"]);
	if (platform !== "openai") return undefined;
	const groupId = num(r["group_id"] ?? r["groupId"]);
	if (!Number.isFinite(groupId)) return undefined;
	const capability = supportedModelsFrom(r);
	return {
		code: str(r["code"]),
		platform,
		...(capability.known
			? { supportedModels: capability.models, modelAvailabilityKnown: true }
			: {}),
		rateMultiplier: num(r["rate_multiplier"] ?? r["rateMultiplier"]),
		avgTtftMs: num(r["avg_ttft_ms"] ?? r["avgTtftMs"]),
		sampleCount: num(r["sample_count"] ?? r["sampleCount"]) || 0,
		lastSampleAt: str(r["last_sample_at"] ?? r["lastSampleAt"]),
		groupId,
	};
}

function positive(v: unknown): number | undefined {
	const value = num(v);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function parseProviderLatencyStat(
	raw: unknown,
): ProviderLatencyStat | undefined {
	const r = asRecord(raw);
	const platform = str(r["platform"]);
	if (platform !== "openai") return undefined;
	const groupId = num(r["group_id"] ?? r["groupId"]);
	if (!Number.isFinite(groupId)) return undefined;
	const capability = supportedModelsFrom(r);
	const available =
		typeof r["available"] === "boolean" ? r["available"] : undefined;
	const probe =
		available === false
			? undefined
			: [
					r["probe_e2e_ttft_ms"],
					r["probeE2eTtftMs"],
					r["probe_ttft_ms"],
					r["probeTtftMs"],
				]
					.map(positive)
					.find((value) => value !== undefined);
	const userHasData = r["user_has_data"] ?? r["userHasData"];
	const userAvgTtftMs =
		userHasData === false
			? undefined
			: positive(r["user_avg_ttft_ms"] ?? r["userAvgTtftMs"]);
	return {
		groupId,
		platform,
		...(capability.known
			? { supportedModels: capability.models, modelAvailabilityKnown: true }
			: {}),
		available,
		cloudProbeTtftMs: probe,
		userAvgTtftMs,
		userSampleCount:
			userAvgTtftMs === undefined
				? 0
				: Math.max(
						0,
						Math.floor(
							num(r["user_sample_count"] ?? r["userSampleCount"]) || 0,
						),
					),
	};
}

export function mergeProviderLatencies(
	stats: readonly GroupStat[],
	providers: ReadonlyMap<number, ProviderLatencyStat>,
): GroupStat[] {
	return stats.map((stat) => {
		const provider = providers.get(stat.groupId);
		return provider
			? {
					...stat,
					providerAvailable: provider.available,
					cloudProbeTtftMs: provider.cloudProbeTtftMs,
					userAvgTtftMs: provider.userAvgTtftMs,
					userSampleCount: provider.userSampleCount,
					...(provider.modelAvailabilityKnown === true
						? {
								supportedModels: provider.supportedModels,
								modelAvailabilityKnown: true,
							}
						: {}),
				}
			: stat;
	});
}

function parseApiKey(raw: unknown): ApiKeyInfo {
	const r = asRecord(raw);
	const gid = r["group_id"] ?? r["groupId"];
	return {
		id: num(r["id"]),
		name: str(r["name"]),
		key: typeof r["key"] === "string" ? r["key"] : undefined,
		groupId: gid === null || gid === undefined ? null : num(gid),
		status: typeof r["status"] === "string" ? r["status"] : undefined,
		createdAt:
			typeof r["created_at"] === "string"
				? (r["created_at"] as string)
				: undefined,
	};
}

/**
 * AIHub(sub2api)API 客户端。
 * 不自动续期:401 抛 AIHubApiError(status=401),由调用方 refresh 后重试。
 * 错误消息绝不包含响应体原文/token/密码。
 */
export class AIHubClient {
	private readonly baseUrl: string;
	private readonly fetchFn: typeof globalThis.fetch;
	private readonly token?: () => string | undefined;
	private readonly timeoutMs: number;
	private readonly userAgent: string;

	constructor(opts: AIHubClientOptions) {
		this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
		this.fetchFn = opts.fetch ?? globalThis.fetch;
		this.token = opts.token;
		this.timeoutMs = opts.timeoutMs ?? 30_000;
		this.userAgent = opts.userAgent ?? "aihub-auto/0.1";
	}

	private async request(
		method: string,
		path: string,
		body?: unknown,
	): Promise<unknown> {
		const headers: Record<string, string> = {
			Accept: "application/json",
			"User-Agent": this.userAgent,
		};
		const tok = this.token?.();
		if (tok) headers["Authorization"] = `Bearer ${tok}`;
		if (body !== undefined) headers["Content-Type"] = "application/json";

		let res: Response;
		try {
			res = await this.fetchFn(`${this.baseUrl}${path}`, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				redirect: "manual",
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (err) {
			const name = err instanceof Error ? err.name : "Error";
			throw new AIHubApiError(
				name === "TimeoutError"
					? `请求超时(${this.timeoutMs}ms): ${method} ${path}`
					: `网络错误: ${method} ${path}`,
				0,
			);
		}

		if (res.status >= 300 && res.status < 400) {
			throw new AIHubApiError(
				`服务器返回重定向(${res.status}),已拒绝跟随: ${path}`,
				res.status,
			);
		}

		let json: unknown;
		try {
			json = await res.json();
		} catch {
			if (!res.ok)
				throw new AIHubApiError(
					`HTTP ${res.status}: ${method} ${path}`,
					res.status,
				);
			throw new AIHubApiError(
				`服务器返回了非 JSON 响应: ${method} ${path}`,
				res.status,
			);
		}

		const env = json as Envelope;
		const hasEnvelope =
			typeof env === "object" && env !== null && "code" in env;

		if (!res.ok) {
			const code = hasEnvelope ? String(env.code) : undefined;
			// message 来自服务端结构化字段,截断防泄漏
			const msg =
				hasEnvelope && typeof env.message === "string"
					? env.message.slice(0, 200)
					: `HTTP ${res.status}`;
			throw new AIHubApiError(`${msg} (${method} ${path})`, res.status, code);
		}

		if (hasEnvelope) {
			const code = String(env.code);
			if (code !== "0") {
				const msg =
					typeof env.message === "string"
						? env.message.slice(0, 200)
						: "业务错误";
				throw new AIHubApiError(`${msg} (${method} ${path})`, res.status, code);
			}
			return env.data;
		}
		return json;
	}

	// ---------- 公开接口 ----------

	async getUsageStats(opts: {
		platform: Platform;
		samples?: number;
		maxRate?: number;
	}): Promise<UsageStatsPage> {
		const samples = opts.samples ?? 100;
		if (!Number.isInteger(samples) || samples <= 0)
			throw new RangeError("samples 必须为正整数");
		if (
			opts.maxRate !== undefined &&
			(!Number.isFinite(opts.maxRate) || opts.maxRate < 0)
		) {
			throw new RangeError("maxRate 必须为非负有限数");
		}
		const q = new URLSearchParams({
			samples: String(samples),
			platform: opts.platform,
		});
		if (opts.maxRate !== undefined) q.set("max_rate", String(opts.maxRate));
		const data = asRecord(
			await this.request("GET", `/api/v1/public/groups/usage-stats?${q}`),
		);
		const rawItems = Array.isArray(data["items"])
			? (data["items"] as unknown[])
			: [];
		const items = rawItems
			.map(parseGroupStat)
			.filter((s): s is GroupStat => s !== undefined);
		return {
			items,
			total: num(data["total"]) || items.length,
			sampleLimit: num(data["sample_limit"]) || samples,
		};
	}

	/** 官网云端探测 + 真实用户平均 TTFT;调用方可在接口不可用时回退 usage-stats。 */
	async getProviderLatencyStats(
		platform: Platform,
	): Promise<Map<number, ProviderLatencyStat>> {
		const data = asRecord(
			await this.request("GET", "/api/v1/public/providers"),
		);
		const rawItems = Array.isArray(data["items"])
			? (data["items"] as unknown[])
			: [];
		const providers = new Map<number, ProviderLatencyStat>();
		for (const raw of rawItems) {
			const provider = parseProviderLatencyStat(raw);
			if (provider?.platform === platform) {
				providers.set(provider.groupId, provider);
			}
		}
		return providers;
	}

	// ---------- 账号接口 ----------

	async login(email: string, password: string): Promise<AuthSession> {
		const data = asRecord(
			await this.request("POST", "/api/v1/auth/login", {
				email: email.trim(),
				password,
			}),
		);
		return this.toSession(data);
	}

	async refreshSession(refreshToken: string): Promise<AuthSession> {
		const data = asRecord(
			await this.request("POST", "/api/v1/auth/refresh", {
				refresh_token: refreshToken,
			}),
		);
		const session = this.toSession(data);
		return session.refreshToken ? session : { ...session, refreshToken };
	}

	private toSession(data: Record<string, unknown>): AuthSession {
		const accessToken =
			str(data["access_token"]) ||
			str(data["token"]) ||
			str(data["accessToken"]);
		if (!accessToken) throw new AIHubApiError("登录响应缺少 access token", 200);
		const refreshToken =
			str(data["refresh_token"]) || str(data["refreshToken"]) || undefined;
		const expiresIn = num(data["expires_in"]);
		return {
			accessToken,
			refreshToken,
			expiresAt: Number.isFinite(expiresIn)
				? Date.now() + expiresIn * 1000
				: undefined,
		};
	}

	async me(): Promise<Record<string, unknown>> {
		return asRecord(await this.request("GET", "/api/v1/auth/me"));
	}

	async getAvailableGroups(): Promise<GroupInfo[]> {
		const data = await this.request("GET", "/api/v1/groups/available");
		const arr = Array.isArray(data) ? data : [];
		return arr.map((g) => {
			const r = asRecord(g);
			return {
				id: num(r["id"]),
				name: str(r["name"]),
				platform:
					typeof r["platform"] === "string"
						? (r["platform"] as string)
						: undefined,
				rateMultiplier: Number.isFinite(num(r["rate_multiplier"]))
					? num(r["rate_multiplier"])
					: undefined,
			};
		});
	}

	/** 用户专属倍率(优先于公开倍率),接口缺失时返回空表 */
	async getUserGroupRates(): Promise<Map<number, number>> {
		const data = await this.request("GET", "/api/v1/groups/rates");
		const out = new Map<number, number>();
		for (const [k, v] of Object.entries(asRecord(data))) {
			const id = Number(k);
			const rate = num(v);
			if (Number.isFinite(id) && Number.isFinite(rate)) out.set(id, rate);
		}
		return out;
	}

	async listAllKeys(): Promise<ApiKeyInfo[]> {
		const pageSize = 50;
		const result: ApiKeyInfo[] = [];
		for (let page = 1; ; page++) {
			const data = asRecord(
				await this.request(
					"GET",
					`/api/v1/keys?page=${page}&page_size=${pageSize}&sort_by=created_at&sort_order=desc`,
				),
			);
			const items = Array.isArray(data["items"])
				? (data["items"] as unknown[])
				: [];
			result.push(...items.map(parseApiKey));
			const pages = num(data["pages"]);
			if (
				items.length === 0 ||
				!Number.isFinite(pages) ||
				page >= Math.max(pages, 1)
			)
				break;
		}
		return result;
	}

	async createKey(opts: {
		name: string;
		groupId: number;
	}): Promise<ApiKeyInfo> {
		const data = await this.request("POST", "/api/v1/keys", {
			name: opts.name,
			group_id: opts.groupId,
		});
		return parseApiKey(data);
	}

	async updateKeyGroup(keyId: number, groupId: number): Promise<ApiKeyInfo> {
		const data = await this.request("PUT", `/api/v1/keys/${keyId}`, {
			group_id: groupId,
		});
		return parseApiKey(data);
	}

	async deleteKey(keyId: number): Promise<void> {
		await this.request("DELETE", `/api/v1/keys/${keyId}`);
	}
}
