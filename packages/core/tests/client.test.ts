import { describe, expect, test } from "bun:test";
import {
	AIHubApiError,
	AIHubClient,
	mergeProviderLatencies,
	parseGroupStat,
} from "../src/index.ts";
import fixtureOpenai from "./fixtures/usage-stats-openai.json";

function mockFetch(
	handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) =>
		handler(String(input), init)) as typeof fetch;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("AIHubClient.getUsageStats", () => {
	test("parses group model capabilities and preserves unknown fields", () => {
		expect(
			parseGroupStat({
				code: "model-group",
				platform: "openai",
				group_id: 1,
				models: [" gpt-4o ", { model: "o1" }, { name: "o3" }, { id: "gpt-5" }],
			}),
		).toMatchObject({
			supportedModels: ["gpt-4o", "o1", "o3", "gpt-5"],
			modelAvailabilityKnown: true,
		});
		expect(
			parseGroupStat({
				code: "unknown-models",
				platform: "openai",
				group_id: 2,
				models: "not-an-array",
				supported_models: ["must-not-win"],
			}),
		).not.toHaveProperty("modelAvailabilityKnown");
		expect(
			parseGroupStat({
				code: "missing-models",
				platform: "openai",
				group_id: 3,
			}),
		).not.toHaveProperty("modelAvailabilityKnown");
	});

	test("解析真实响应样本(envelope + snake_case)", async () => {
		const client = new AIHubClient({
			baseUrl: "https://aihub.top/",
			fetch: mockFetch((url) => {
				expect(url).toBe(
					"https://aihub.top/api/v1/public/groups/usage-stats?samples=20&platform=openai",
				);
				return json(fixtureOpenai);
			}),
		});
		const page = await client.getUsageStats({
			platform: "openai",
			samples: 20,
		});
		expect(page.items).toHaveLength(9);
		const first = page.items[0]!;
		expect(first.code).toBe("A003-Plus");
		expect(first.rateMultiplier).toBe(0.12);
		expect(first.groupId).toBe(41);
		expect(page.sampleLimit).toBe(20);
	});

	test("maxRate 参数传递,字符串数字容忍", async () => {
		const client = new AIHubClient({
			baseUrl: "https://aihub.top",
			fetch: mockFetch((url) => {
				expect(url).toContain("max_rate=0.1");
				return json({
					code: 0,
					data: {
						items: [
							{
								code: "X",
								platform: "openai",
								rate_multiplier: "0.05",
								avg_ttft_ms: "1200.5",
								sample_count: "10",
								last_sample_at: "2026-07-26T14:00:00Z",
								group_id: "3",
							},
						],
						total: 1,
						sample_limit: 100,
					},
				});
			}),
		});
		const page = await client.getUsageStats({
			platform: "openai",
			maxRate: 0.1,
		});
		expect(page.items[0]!.rateMultiplier).toBe(0.05);
		expect(page.items[0]!.groupId).toBe(3);
	});

	test("未知平台条目被丢弃", async () => {
		const client = new AIHubClient({
			baseUrl: "https://aihub.top",
			fetch: mockFetch(() =>
				json({
					code: 0,
					data: {
						items: [{ code: "X", platform: "gemini", group_id: 1 }],
						total: 1,
						sample_limit: 100,
					},
				}),
			),
		});
		const page = await client.getUsageStats({ platform: "openai" });
		expect(page.items).toHaveLength(0);
	});

	test("参数校验", async () => {
		const client = new AIHubClient({
			baseUrl: "https://aihub.top",
			fetch: mockFetch(() => json({})),
		});
		expect(
			client.getUsageStats({ platform: "openai", samples: 0 }),
		).rejects.toThrow(RangeError);
		expect(
			client.getUsageStats({ platform: "openai", maxRate: -1 }),
		).rejects.toThrow(RangeError);
	});
});

describe("AIHubClient.getProviderLatencyStats", () => {
	test("解析云端探测与真实用户平均 TTFT,0 值不伪造数据", async () => {
		const client = new AIHubClient({
			baseUrl: "https://aihub.top",
			fetch: mockFetch((url) => {
				expect(url).toBe("https://aihub.top/api/v1/public/providers");
				return json({
					code: 0,
					data: {
						items: [
							{
								group_id: 3,
								platform: "openai",
								available: true,
								probe_ttft_ms: 900,
								probe_e2e_ttft_ms: 1200,
								user_avg_ttft_ms: 2400,
								user_sample_count: 50,
								user_has_data: true,
								models: [
									" gpt-4o ",
									{ model: "o1" },
									{ name: "o3" },
									{ id: "gpt-5" },
								],
							},
							{
								group_id: 4,
								platform: "openai",
								available: false,
								probe_e2e_ttft_ms: 800,
								user_avg_ttft_ms: 0,
								user_sample_count: 0,
								user_has_data: false,
								supported_models: [],
							},
							{
								group_id: 5,
								platform: "openai",
								available: true,
								probe_e2e_ttft_ms: 0,
								probe_ttft_ms: 700,
								user_has_data: false,
								available_models: ["claude-3-5-sonnet"],
							},
							{
								group_id: 6,
								platform: "openai",
								model_names: [{ name: "gemini-2.5-pro" }],
							},
							{
								group_id: 7,
								platform: "openai",
							},
							{
								group_id: 8,
								platform: "openai",
								models: "not-an-array",
								supported_models: ["must-not-win"],
							},
							{
								group_id: 9,
								platform: "openai",
								models: ["first-field"],
								supported_models: ["second-field"],
							},
						],
					},
				});
			}),
		});
		const providers = await client.getProviderLatencyStats("openai");
		expect(providers.get(3)).toEqual({
			groupId: 3,
			platform: "openai",
			available: true,
			cloudProbeTtftMs: 1200,
			userAvgTtftMs: 2400,
			userSampleCount: 50,
			supportedModels: ["gpt-4o", "o1", "o3", "gpt-5"],
			modelAvailabilityKnown: true,
		});
		expect(providers.get(4)).toEqual({
			groupId: 4,
			platform: "openai",
			available: false,
			cloudProbeTtftMs: undefined,
			userAvgTtftMs: undefined,
			userSampleCount: 0,
			supportedModels: [],
			modelAvailabilityKnown: true,
		});
		expect(providers.get(5)).toEqual(
			expect.objectContaining({
				available: true,
				cloudProbeTtftMs: 700,
				supportedModels: ["claude-3-5-sonnet"],
				modelAvailabilityKnown: true,
			}),
		);
		expect(providers.get(6)).toMatchObject({
			supportedModels: ["gemini-2.5-pro"],
			modelAvailabilityKnown: true,
		});
		expect(providers.get(7)).not.toHaveProperty("modelAvailabilityKnown");
		expect(providers.get(8)).not.toHaveProperty("modelAvailabilityKnown");
		expect(providers.get(9)).toMatchObject({
			supportedModels: ["first-field"],
			modelAvailabilityKnown: true,
		});
	});

	test("known provider capability overlays group capability only when present", () => {
		const group = parseGroupStat({
			code: "group",
			platform: "openai",
			group_id: 1,
			models: ["group-model"],
		})!;
		const unknownProvider = new Map([
			[1, { groupId: 1, platform: "openai" as const, userSampleCount: 0 }],
		]);
		expect(mergeProviderLatencies([group], unknownProvider)[0]).toMatchObject({
			supportedModels: ["group-model"],
			modelAvailabilityKnown: true,
		});

		const knownProvider = new Map([
			[
				1,
				{
					groupId: 1,
					platform: "openai" as const,
					userSampleCount: 0,
					supportedModels: [],
					modelAvailabilityKnown: true,
				},
			],
		]);
		expect(mergeProviderLatencies([group], knownProvider)[0]).toMatchObject({
			supportedModels: [],
			modelAvailabilityKnown: true,
		});
	});
});

describe("错误处理", () => {
	test("业务 code!=0 抛 AIHubApiError,携带 code", async () => {
		const client = new AIHubClient({
			baseUrl: "https://aihub.top",
			fetch: mockFetch(() =>
				json({ code: 401001, message: "token expired" }, 200),
			),
		});
		try {
			await client.me();
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(AIHubApiError);
			expect((err as AIHubApiError).code).toBe("401001");
		}
	});

	test("HTTP 401 状态透出", async () => {
		const client = new AIHubClient({
			baseUrl: "https://aihub.top",
			fetch: mockFetch(() => json({ code: 1, message: "unauthorized" }, 401)),
		});
		try {
			await client.me();
			expect.unreachable();
		} catch (err) {
			expect((err as AIHubApiError).status).toBe(401);
		}
	});

	test("错误消息不回显 token/密码", async () => {
		const client = new AIHubClient({
			baseUrl: "https://aihub.top",
			token: () => "SECRET_TOKEN_VALUE",
			fetch: mockFetch(
				() =>
					new Response("<html>gateway error SECRET_LEAK</html>", {
						status: 502,
					}),
			),
		});
		try {
			await client.me();
			expect.unreachable();
		} catch (err) {
			const msg = (err as Error).message;
			expect(msg).not.toContain("SECRET_TOKEN_VALUE");
			expect(msg).not.toContain("SECRET_LEAK");
		}
	});

	test("重定向被拒绝", async () => {
		const client = new AIHubClient({
			baseUrl: "https://aihub.top",
			fetch: mockFetch(
				() =>
					new Response(null, {
						status: 302,
						headers: { Location: "https://evil.example" },
					}),
			),
		});
		expect(client.me()).rejects.toThrow(/重定向/);
	});
});

describe("账号接口", () => {
	test("login 解析 session,token 注入后续请求", async () => {
		let sawAuth = "";
		const client = new AIHubClient({
			baseUrl: "https://aihub.top",
			token: () => "tok123",
			fetch: mockFetch((url, init) => {
				const headers = init?.headers as Record<string, string>;
				sawAuth = headers["Authorization"] ?? "";
				if (url.endsWith("/api/v1/auth/login")) {
					return json({
						code: 0,
						data: { access_token: "at", refresh_token: "rt", expires_in: 3600 },
					});
				}
				return json({ code: 0, data: {} });
			}),
		});
		const session = await client.login("a@b.c", "pw");
		expect(session.accessToken).toBe("at");
		expect(session.refreshToken).toBe("rt");
		expect(session.expiresAt).toBeGreaterThan(Date.now());
		expect(sawAuth).toBe("Bearer tok123");
	});

	test("refreshSession 保留旧 refreshToken(响应未携带时)", async () => {
		const client = new AIHubClient({
			baseUrl: "https://aihub.top",
			fetch: mockFetch(() =>
				json({ code: 0, data: { access_token: "new-at" } }),
			),
		});
		const s = await client.refreshSession("old-rt");
		expect(s.accessToken).toBe("new-at");
		expect(s.refreshToken).toBe("old-rt");
	});

	test("listAllKeys 翻页聚合", async () => {
		let calls = 0;
		const client = new AIHubClient({
			baseUrl: "https://aihub.top",
			fetch: mockFetch((url) => {
				calls++;
				const page = Number(new URL(url).searchParams.get("page"));
				return json({
					code: 0,
					data: {
						items:
							page === 1
								? Array.from({ length: 50 }, (_, i) => ({
										id: i + 1,
										name: `k${i}`,
										group_id: 1,
									}))
								: [{ id: 51, name: "k51", group_id: 2 }],
						total: 51,
						pages: 2,
					},
				});
			}),
		});
		const keys = await client.listAllKeys();
		expect(keys).toHaveLength(51);
		expect(calls).toBe(2);
		expect(keys[50]!.groupId).toBe(2);
	});

	test("createKey/updateKeyGroup/deleteKey 请求形状", async () => {
		const seen: { method: string; url: string; body?: unknown }[] = [];
		const client = new AIHubClient({
			baseUrl: "https://aihub.top",
			fetch: mockFetch((url, init) => {
				seen.push({
					method: init?.method ?? "GET",
					url,
					body: init?.body ? JSON.parse(String(init.body)) : undefined,
				});
				return json({
					code: 0,
					data: { id: 9, name: "aihub-auto-g5", key: "sk-xxx", group_id: 5 },
				});
			}),
		});
		const created = await client.createKey({
			name: "aihub-auto-g5",
			groupId: 5,
		});
		expect(created.key).toBe("sk-xxx");
		await client.updateKeyGroup(9, 6);
		await client.deleteKey(9);

		expect(seen[0]).toMatchObject({
			method: "POST",
			body: { name: "aihub-auto-g5", group_id: 5 },
		});
		expect(seen[1]).toMatchObject({
			method: "PUT",
			url: "https://aihub.top/api/v1/keys/9",
			body: { group_id: 6 },
		});
		expect(seen[2]).toMatchObject({
			method: "DELETE",
			url: "https://aihub.top/api/v1/keys/9",
		});
	});

	test("getUserGroupRates 解析数字键", async () => {
		const client = new AIHubClient({
			baseUrl: "https://aihub.top",
			fetch: mockFetch(() =>
				json({ code: 0, data: { "5": 0.03, "8": "0.06" } }),
			),
		});
		const rates = await client.getUserGroupRates();
		expect(rates.get(5)).toBe(0.03);
		expect(rates.get(8)).toBe(0.06);
	});
});
