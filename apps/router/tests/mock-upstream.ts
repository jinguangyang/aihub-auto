import type { GroupStat } from "@aihub-auto/core";

export interface MockKey {
	id: number;
	name: string;
	key: string;
	group_id: number | null;
	ownerId?: string;
}

export interface MockBehavior {
	/** groupId → 行为 */
	groups: Map<
		number,
		{
			status?: number;
			delayMs?: number;
			/** 中途断流(发送一半后 error) */
			breakMidStream?: boolean;
			unsupportedModels?: Set<string>;
			cachedTokens?: number;
			inputTokens?: number;
			body?: string;
			gzip?: boolean;
			sse?: boolean;
		}
	>;
	requireAuth?: boolean;
}

/** 可编程 mock AIHub:usage-stats + keys CRUD + /v1/chat/completions */
export class MockAIHub {
	server: ReturnType<typeof Bun.serve>;
	stats: GroupStat[] = [];
	groupNames = new Map<number, string>();
	keys = new Map<number, MockKey>();
	behavior: MockBehavior = { groups: new Map() };
	nextKeyId = 1;
	requestLog: {
		method: string;
		path: string;
		auth?: string;
		userAgent?: string;
	}[] = [];
	loginCalls = 0;
	refreshCalls = 0;
	availableGroupsStatus: number | undefined;
	groupRatesStatus: number | undefined;
	listKeysStatus: number | undefined;
	deleteKeyFailures = new Map<
		number,
		{ status: number; code?: string; remaining: number }
	>();
	/** 强制业务接口返回 401(模拟 token 过期);refresh 后復位 */
	expireToken = false;
	meDelayMs = 0;
	accounts = new Map([
		["mock-at", { id: "account-1", email: "mock@test.local" }],
		["mock-at-2", { id: "account-1", email: "mock@test.local" }],
		["manual-token", { id: "account-1", email: "mock@test.local" }],
		[
			"account-two-token",
			{ id: "account-2", email: "second@test.local" },
		],
	]);

	constructor() {
		this.server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			idleTimeout: 0,
			fetch: (req) => this.handle(req),
		});
	}

	get url(): string {
		return `http://127.0.0.1:${this.server.port}`;
	}

	stop(): void {
		this.server.stop(true);
	}

	private json(body: unknown, status = 200): Response {
		return new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	}

	private envelope(data: unknown): Response {
		return this.json({ code: 0, message: "success", data });
	}

	private accountFor(
		auth?: string,
	): { id: string; email: string } | undefined {
		return this.accounts.get((auth ?? "").replace(/^Bearer\s+/i, ""));
	}

	private keyOwner(key: MockKey): string {
		return key.ownerId ?? "account-1";
	}

	private async handle(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const path = url.pathname;
		const auth = req.headers.get("authorization") ?? undefined;
		const userAgent = req.headers.get("user-agent") ?? undefined;
		this.requestLog.push({ method: req.method, path, auth, userAgent });

		// ---- 公开统计 ----
		if (path === "/api/v1/public/groups/usage-stats") {
			const platform = url.searchParams.get("platform");
			const items = this.stats
				.filter((s) => !platform || s.platform === platform)
				.map((s) => ({
					code: s.code,
					platform: s.platform,
					rate_multiplier: s.rateMultiplier,
					avg_ttft_ms: s.avgTtftMs,
					sample_count: s.sampleCount,
					last_sample_at: s.lastSampleAt,
					group_id: s.groupId,
				}));
			return this.envelope({ items, total: items.length, sample_limit: 100 });
		}
		if (path === "/api/v1/public/providers") {
			return this.envelope({
				generated_at: new Date().toISOString(),
				items: this.stats.map((stat) => ({
					code: stat.code,
					platform: stat.platform,
					rate_multiplier: stat.rateMultiplier,
					group_id: stat.groupId,
					available: stat.providerAvailable !== false,
					probe_e2e_ttft_ms: stat.cloudProbeTtftMs ?? null,
					user_avg_ttft_ms: stat.userAvgTtftMs ?? 0,
					user_sample_count: stat.userSampleCount ?? 0,
					user_has_data: stat.userAvgTtftMs !== undefined,
					...(stat.modelAvailabilityKnown === true
						? { models: stat.supportedModels ?? [] }
						: {}),
				})),
			});
		}

		// ---- 认证 ----
		if (path === "/api/v1/auth/login" && req.method === "POST") {
			this.loginCalls++;
			return this.envelope({
				access_token: "mock-at",
				refresh_token: "mock-rt",
				expires_in: 3600,
			});
		}
		if (path === "/api/v1/auth/refresh" && req.method === "POST") {
			this.refreshCalls++;
			this.expireToken = false;
			return this.envelope({
				access_token: "mock-at-2",
				refresh_token: "mock-rt-2",
				expires_in: 3600,
			});
		}
		if (path === "/api/v1/auth/me") {
			if (this.meDelayMs > 0) await Bun.sleep(this.meDelayMs);
			if (this.expireToken)
				return this.json({ code: 1, message: "unauthorized" }, 401);
			const account = this.accountFor(auth);
			if (!account)
				return this.json({ code: 1, message: "unauthorized" }, 401);
			return this.envelope({ ...account, balance: 12.34 });
		}

		// ---- 账号可用组/倍率 ----
		if (path === "/api/v1/groups/available") {
			if (this.availableGroupsStatus !== undefined) {
				return this.json(
					{ code: 1, message: "available groups unavailable" },
					this.availableGroupsStatus,
				);
			}
			if (this.expireToken)
				return this.json({ code: 1, message: "unauthorized" }, 401);
			if (!this.accountFor(auth))
				return this.json({ code: 1, message: "unauthorized" }, 401);
			const groups = [
				...new Map(this.stats.map((stat) => [stat.groupId, stat])).values(),
			].map((stat) => ({
				id: stat.groupId,
				name: this.groupNames.get(stat.groupId) ?? stat.code,
				platform: stat.platform,
				rate_multiplier: stat.rateMultiplier,
			}));
			return this.envelope(groups);
		}
		if (path === "/api/v1/groups/rates") {
			if (this.groupRatesStatus !== undefined) {
				return this.json(
					{ code: 1, message: "group rates unavailable" },
					this.groupRatesStatus,
				);
			}
			if (this.expireToken)
				return this.json({ code: 1, message: "unauthorized" }, 401);
			if (!this.accountFor(auth))
				return this.json({ code: 1, message: "unauthorized" }, 401);
			return this.envelope(
				Object.fromEntries(
					this.stats.map((stat) => [stat.groupId, stat.rateMultiplier]),
				),
			);
		}

		// ---- Keys CRUD ----
		if (path === "/api/v1/keys" && req.method === "GET") {
			if (this.listKeysStatus !== undefined)
				return this.json(
					{ code: "list_keys_failed", message: "list keys failed" },
					this.listKeysStatus,
				);
			if (this.expireToken)
				return this.json({ code: 1, message: "unauthorized" }, 401);
			const account = this.accountFor(auth);
			if (!account)
				return this.json({ code: 1, message: "unauthorized" }, 401);
			const items = [...this.keys.values()].filter(
				(key) => this.keyOwner(key) === account.id,
			);
			return this.envelope({ items, total: items.length, pages: 1 });
		}
		if (path === "/api/v1/keys" && req.method === "POST") {
			if (this.expireToken)
				return this.json({ code: 1, message: "unauthorized" }, 401);
			const account = this.accountFor(auth);
			if (!account)
				return this.json({ code: 1, message: "unauthorized" }, 401);
			const body = (await req.json()) as { name: string; group_id: number };
			const id = this.nextKeyId++;
			const key: MockKey = {
				id,
				name: body.name,
				key: `sk-mock-${id}`,
				group_id: body.group_id,
				ownerId: account.id,
			};
			this.keys.set(id, key);
			return this.envelope(key);
		}
		const keyMatch = path.match(/^\/api\/v1\/keys\/(\d+)$/);
		if (keyMatch) {
			if (this.expireToken)
				return this.json({ code: 1, message: "unauthorized" }, 401);
			const account = this.accountFor(auth);
			if (!account)
				return this.json({ code: 1, message: "unauthorized" }, 401);
			const id = Number(keyMatch[1]);
			const key = this.keys.get(id);
			if (!key || this.keyOwner(key) !== account.id)
				return this.json({ code: 1, message: "not found" }, 404);
			if (req.method === "PUT") {
				const body = (await req.json()) as { group_id: number };
				key.group_id = body.group_id;
				return this.envelope(key);
			}
			if (req.method === "DELETE") {
				const failure = this.deleteKeyFailures.get(id);
				if (failure && failure.remaining > 0) {
					failure.remaining--;
					if (failure.remaining === 0) this.deleteKeyFailures.delete(id);
					return this.json(
						{
							code: failure.code ?? "delete_failed",
							message: "delete failed",
						},
						failure.status,
					);
				}
				this.keys.delete(id);
				return this.envelope({ message: "deleted" });
			}
		}

		// ---- 模型 API(按注入 Key 找组)----
		if (path.startsWith("/v1/")) {
			const sk = (auth ?? "").replace(/^Bearer\s+/i, "");
			const key = [...this.keys.values()].find((k) => k.key === sk);
			if (!key) return this.json({ error: { message: "invalid key" } }, 401);
			const groupId = key.group_id ?? 0;
			const b = this.behavior.groups.get(groupId) ?? {};
			let model = "";
			if (req.method !== "GET") {
				try {
					const payload = (await req.json()) as { model?: unknown };
					if (typeof payload.model === "string") model = payload.model;
				} catch {
					// 测试上游允许空/非 JSON body。
				}
			}
			if (b.delayMs) await Bun.sleep(b.delayMs);
			if (model && b.unsupportedModels?.has(model)) {
				return this.json(
					{
						detail: `The '${model}' model is not supported when using Codex with this group.`,
					},
					400,
				);
			}
			if (b.status && b.status >= 400) {
				if (b.body !== undefined) {
					return new Response(b.body, {
						status: b.status,
						headers: { "Content-Type": "application/json" },
					});
				}
				const payload = { error: { message: `mock error group ${groupId}` } };
				if (b.gzip) {
					return new Response(
						Bun.gzipSync(new TextEncoder().encode(JSON.stringify(payload))),
						{
							status: b.status,
							headers: {
								"Content-Type": "application/json",
								"Content-Encoding": "gzip",
							},
						},
					);
				}
				return this.json(payload, b.status);
			}
			if (b.sse) {
				const breakMid = b.breakMidStream ?? false;
				const stream = new ReadableStream<Uint8Array>({
					async start(c) {
						const enc = new TextEncoder();
						c.enqueue(
							enc.encode(
								`data: {"choices":[{"delta":{"content":"来自组 ${groupId}"}}]}\n\n`,
							),
						);
						await Bun.sleep(10);
						if (breakMid) {
							c.error(new Error("mid-stream break"));
							return;
						}
						c.enqueue(enc.encode("data: [DONE]\n\n"));
						c.close();
					},
				});
				return new Response(stream, {
					headers: { "Content-Type": "text/event-stream" },
				});
			}
			const payload = {
				id: path.includes("/responses") ? `resp_mock_${groupId}` : "cmpl-1",
				group: groupId,
				content: b.body ?? `response from group ${groupId}`,
				usage:
					b.cachedTokens === undefined
						? undefined
						: {
								prompt_tokens: b.inputTokens ?? b.cachedTokens,
								prompt_tokens_details: { cached_tokens: b.cachedTokens },
							},
			};
			if (b.gzip) {
				return new Response(
					Bun.gzipSync(new TextEncoder().encode(JSON.stringify(payload))),
					{
						headers: {
							"Content-Type": "application/json",
							"Content-Encoding": "gzip",
						},
					},
				);
			}
			return this.json(payload);
		}

		return this.json({ error: "not found" }, 404);
	}
}

export function makeStat(
	partial: Partial<GroupStat> & { groupId: number },
): GroupStat {
	return {
		code: `G${partial.groupId}`,
		platform: "openai",
		rateMultiplier: 0.05,
		avgTtftMs: 2000,
		sampleCount: 20,
		lastSampleAt: new Date().toISOString(),
		...partial,
	};
}
