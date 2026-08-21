import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { handleProxy, isBillingErrorResponse } from "../src/proxy.ts";
import { createHarness, type Harness } from "./harness.ts";
import { makeStat } from "./mock-upstream.ts";

let h: Harness;
afterEach(() => h?.dispose());

/** 准备:pool 模式,组 1/2/3 各有统计,当前路由到组 1 */
async function setupRouted(
	configPatch?: Record<string, unknown>,
): Promise<Harness> {
	const hh = createHarness({
		configPatch: { keyMode: "pool", ...configPatch },
	});
	hh.mock.stats = [
		makeStat({ groupId: 1, rateMultiplier: 0.03, avgTtftMs: 1500 }),
		makeStat({ groupId: 2, rateMultiplier: 0.05, avgTtftMs: 1800 }),
		makeStat({ groupId: 3, rateMultiplier: 0.08, avgTtftMs: 2500 }),
	];
	await hh.daemon.runOnce();
	expect(hh.state.currentGroupId).toBe(1);
	return hh;
}

function proxyReq(path = "/v1/chat/completions", init?: RequestInit): Request {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ model: "gpt-test", messages: [] }),
		...init,
	});
}

function sessionReq(session: string, model = "gpt-test"): Request {
	return proxyReq("/v1/chat/completions", {
		headers: {
			"Content-Type": "application/json",
			"x-aihub-auto-session": session,
		},
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content: "hello" }],
		}),
	});
}

describe("账单错误识别", () => {
	test("只接受明确的余额不足信号", async () => {
		expect(
			await isBillingErrorResponse(
				new Response('{"error":{"message":"余额不足"}}', { status: 403 }),
			),
		).toBe(true);
		expect(
			await isBillingErrorResponse(
				new Response('{"error":{"message":"余额正常"}}', { status: 403 }),
			),
		).toBe(false);
	});

	test("前缀读取超时不等待未结束错误流", async () => {
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						new TextEncoder().encode(
							'{"error":{"message":"insufficient balance"}}',
						),
					);
				},
			}),
			{ status: 403 },
		);
		const started = performance.now();
		expect(await isBillingErrorResponse(response)).toBe(true);
		expect(performance.now() - started).toBeLessThan(800);
	});
});

describe("反代基础", () => {
	test("未配置 Key ⇒ 503 且提示", async () => {
		h = createHarness();
		const res = await handleProxy(proxyReq(), h.proxyDeps);
		expect(res.status).toBe(503);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toContain("没有可用分组");
	});

	test("未知长度请求体超过重试缓冲上限时返回 413", async () => {
		h = createHarness();
		const req = new Request("http://localhost/v1/chat/completions", {
			method: "POST",
			body: "12345",
		});
		expect(req.headers.get("content-length")).toBeNull();
		const res = await handleProxy(req, { ...h.proxyDeps, maxBufferBytes: 4 });
		expect(res.status).toBe(413);
		expect(await res.text()).toContain("请求体超过重试缓冲上限");
	});

	test("正常转发:注入池 Key,响应带 x-aihub-auto-group,TTFT 入观测", async () => {
		h = await setupRouted();
		const res = await handleProxy(proxyReq(), h.proxyDeps);
		expect(res.status).toBe(200);
		expect(res.headers.get("x-aihub-auto-group")).toBe("1");
		const body = (await res.json()) as { group: number };
		expect(body.group).toBe(1);
		const obs = h.observations.getObservation(1);
		expect(obs).toBeDefined();
		expect(obs!.sampleCount).toBe(1);
		expect(obs!.errorRate).toBe(0);
	});

	test("上游 gzip 自动解压后移除编码头,客户端不二次解压", async () => {
		h = await setupRouted();
		h.mock.behavior.groups.set(1, { gzip: true });
		const res = await handleProxy(proxyReq(), h.proxyDeps);
		expect(res.headers.get("content-encoding")).toBeNull();
		expect((await res.json()) as { group: number }).toMatchObject({ group: 1 });
	});

	test("客户端自带 Authorization 被丢弃,注入的是池 Key", async () => {
		h = await setupRouted();
		await handleProxy(
			proxyReq("/v1/chat/completions", {
				method: "POST",
				headers: {
					Authorization: "Bearer client-own-key",
					"Content-Type": "application/json",
				},
				body: "{}",
			}),
			h.proxyDeps,
		);
		const upstream = h.mock.requestLog.filter((r) => r.path.startsWith("/v1/"));
		expect(upstream.at(-1)!.auth).toStartWith("Bearer sk-mock-");
	});

	test("远端已删 managed Key 返回 401 时原组重建并重试", async () => {
		h = await setupRouted();
		const oldEntry = { ...h.state.pool["1"]! };
		h.mock.keys.delete(oldEntry.keyId);
		const authorizations: string[] = [];
		h.proxyDeps.fetch = (async (_input, init) => {
			const authorization =
				new Headers(init?.headers).get("authorization") ?? "";
			authorizations.push(authorization);
			const sk = authorization.replace(/^Bearer\s+/i, "");
			const valid = [...h.mock.keys.values()].some((key) => key.key === sk);
			return valid
				? new Response(JSON.stringify({ group: 1 }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					})
				: new Response(null, { status: 401 });
		}) as typeof fetch;

		const res = await handleProxy(
			sessionReq("deleted-managed-key"),
			h.proxyDeps,
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ group: 1 });
		expect(authorizations).toHaveLength(2);
		expect(authorizations[1]).not.toBe(authorizations[0]);
		expect(h.state.pool["1"]?.keyId).not.toBe(oldEntry.keyId);
	});

	test("自定义 User-Agent 覆盖初次与重试请求,留空时保留客户端值", async () => {
		h = await setupRouted({ upstreamUserAgent: "BenefitClient/2.0" });
		h.mock.behavior.groups.set(1, { status: 500 });
		const retried = await handleProxy(
			proxyReq("/v1/chat/completions", {
				headers: {
					"Content-Type": "application/json",
					"User-Agent": "Caller/1.0",
				},
			}),
			h.proxyDeps,
		);
		expect(retried.status).toBe(200);
		const attempts = h.mock.requestLog.filter((entry) =>
			entry.path.startsWith("/v1/"),
		);
		expect(attempts.length).toBeGreaterThanOrEqual(2);
		expect(
			attempts.every((entry) => entry.userAgent === "BenefitClient/2.0"),
		).toBe(true);

		h.config.upstreamUserAgent = "";
		h.mock.behavior.groups.clear();
		await handleProxy(
			proxyReq("/v1/chat/completions", {
				headers: {
					"Content-Type": "application/json",
					"User-Agent": "Caller/2.0",
				},
			}),
			h.proxyDeps,
		);
		expect(h.mock.requestLog.at(-1)?.userAgent).toBe("Caller/2.0");
	});

	test("SSE 流式直通", async () => {
		h = await setupRouted();
		h.mock.behavior.groups.set(1, { sse: true });
		const res = await handleProxy(proxyReq(), h.proxyDeps);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		const text = await res.text();
		expect(text).toContain("来自组 1");
		expect(text).toContain("[DONE]");
	});

	test("客户端取消时吞掉上游 reader.cancel 错误并归还流量", async () => {
		h = await setupRouted();
		let canceled = false;
		h.proxyDeps.fetch = Object.assign(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("data: started\n\n"));
						},
						cancel() {
							canceled = true;
							return Promise.reject(new Error("upstream already closed"));
						},
					}),
					{ status: 200 },
				),
			{ preconnect() {} },
		);
		const server = Bun.serve({
			port: 0,
			fetch: (request) => handleProxy(request, h.proxyDeps),
		});
		try {
			const payload = JSON.stringify({ model: "gpt-test", messages: [] });
			await new Promise<void>((resolve, reject) => {
				const socket = connect(
					{ host: "127.0.0.1", port: server.port! },
					() => {
						socket.write(
							`POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`,
						);
					},
				);
				socket.once("data", () => {
					socket.destroy();
					resolve();
				});
				socket.once("error", reject);
			});
			for (let i = 0; i < 40 && !canceled; i++) await Bun.sleep(5);
			expect(canceled).toBe(true);
			expect(h.traffic.snapshot().activeStreams).toBe(0);
			expect(h.observations.asMap().get(1)?.recentSamples ?? 0).toBe(0);
		} finally {
			server.stop(true);
		}
	});

	test("客户端取消后继续 pull 不得抛出 Controller is already closed", async () => {
		h = await setupRouted();
		const gate = Promise.withResolvers<void>();
		let upstreamCancel = 0;
		h.proxyDeps.fetch = Object.assign(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						async start(controller) {
							controller.enqueue(new TextEncoder().encode("chunk-1"));
							await gate.promise;
							try {
								controller.enqueue(new TextEncoder().encode("chunk-2"));
								controller.close();
							} catch {
								// 上游在客户端取消后关闭是预期竞态。
							}
						},
						cancel() {
							upstreamCancel += 1;
						},
					}),
					{ status: 200 },
				),
			{ preconnect() {} },
		);
		const downstream = new AbortController();
		const response = await handleProxy(
			proxyReq(undefined, { signal: downstream.signal }),
			h.proxyDeps,
		);
		const reader = response.body!.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toContain(
			"chunk-1",
		);
		downstream.abort("client gone");
		const cancelPromise = reader.cancel("client gone");
		gate.resolve();
		await cancelPromise;
		await Bun.sleep(20);
		expect(upstreamCancel).toBeGreaterThan(0);
		expect(h.traffic.snapshot().activeStreams).toBe(0);
	});

	test("真实 cached_tokens 更新会话缓存证据", async () => {
		h = await setupRouted();
		h.mock.behavior.groups.set(1, { cachedTokens: 80, inputTokens: 100 });
		await (await handleProxy(sessionReq("cache"), h.proxyDeps)).text();
		expect(h.affinity.stats().cacheHits).toBe(1);

		h.mock.behavior.groups.set(1, { cachedTokens: 0, inputTokens: 100 });
		await (await handleProxy(sessionReq("cache"), h.proxyDeps)).text();
		expect(h.affinity.stats().cacheMisses).toBe(1);
	});

	test("OpenAI 路径前缀改写", async () => {
		h = await setupRouted();
		const res = await handleProxy(
			proxyReq("/openai/v1/chat/completions"),
			h.proxyDeps,
		);
		expect(res.status).toBe(200);
		expect(h.mock.requestLog.at(-1)!.path).toBe("/v1/chat/completions");
	});

	test("proxyToken 配置后:无 token 401,带 token 通过", async () => {
		h = await setupRouted({ proxyToken: "supersecrettoken123" });
		const denied = await handleProxy(proxyReq(), h.proxyDeps);
		expect(denied.status).toBe(401);
		const allowed = await handleProxy(
			proxyReq("/v1/chat/completions", {
				method: "POST",
				headers: {
					Authorization: "Bearer supersecrettoken123",
					"Content-Type": "application/json",
				},
				body: "{}",
			}),
			h.proxyDeps,
		);
		expect(allowed.status).toBe(200);
	});
});

describe("故障转移", () => {
	test("首字节前 500 ⇒ 同请求内换组重试成功,观测记失败", async () => {
		h = await setupRouted();
		// 先成功一次让会话 A 绑定组 1
		await (await handleProxy(sessionReq("A"), h.proxyDeps)).text();
		h.mock.behavior.groups.set(1, { status: 500 });

		const res = await handleProxy(sessionReq("A"), h.proxyDeps);
		expect(res.status).toBe(200);
		// 切到了组 2(次优)
		expect(res.headers.get("x-aihub-auto-group")).toBe("2");
		expect(h.state.currentGroupId).toBe(1); // 默认组不随单个会话迁移
		expect(
			Object.values(h.state.sessions).map((binding) => binding.groupId),
		).toEqual([2]);
		// 组 1 观测到失败(1 成功 + 1 失败 ⇒ 窗口错误率 0.5)
		expect(h.observations.getObservation(1)!.errorRate).toBeGreaterThan(0);

		// 组 2 也挂 ⇒ 后续请求落到组 3
		h.mock.behavior.groups.set(2, { status: 500 });
		const res3 = await handleProxy(sessionReq("A"), h.proxyDeps);
		expect(res3.status).toBe(200);
		expect(res3.headers.get("x-aihub-auto-group")).toBe("3");
	});

	test("一个会话故障迁移不影响其他热会话", async () => {
		h = await setupRouted();
		await (await handleProxy(sessionReq("A"), h.proxyDeps)).text();
		await (await handleProxy(sessionReq("B"), h.proxyDeps)).text();
		h.mock.behavior.groups.set(1, { status: 500 });
		const moved = await handleProxy(sessionReq("A"), h.proxyDeps);
		expect(moved.headers.get("x-aihub-auto-group")).toBe("2");
		await moved.text();

		h.mock.behavior.groups.delete(1);
		const stayed = await handleProxy(sessionReq("B"), h.proxyDeps);
		expect(stayed.headers.get("x-aihub-auto-group")).toBe("1");
		await stayed.text();
		expect(
			Object.values(h.state.sessions)
				.map((binding) => binding.groupId)
				.sort(),
		).toEqual([1, 2]);
	});

	test("429 同样触发换组", async () => {
		h = await setupRouted();
		h.mock.behavior.groups.set(1, { status: 429 });
		const res = await handleProxy(proxyReq(), h.proxyDeps);
		expect(res.status).toBe(200);
		expect(res.headers.get("x-aihub-auto-group")).toBe("2");
	});

	test("上游余额不足 403 ⇒ 记失败并换组", async () => {
		h = await setupRouted();
		h.mock.behavior.groups.set(1, {
			status: 403,
			body: '{"error":{"message":"insufficient balance","type":"billing_error"}}',
		});
		const res = await handleProxy(proxyReq(), h.proxyDeps);
		expect(res.status).toBe(200);
		expect(res.headers.get("x-aihub-auto-group")).toBe("2");
		expect(h.observations.getObservation(1)!.errorRate).toBeGreaterThan(0);
	});

	test("非账单 403(如内容过滤)如实透传不换组", async () => {
		h = await setupRouted();
		h.mock.behavior.groups.set(1, {
			status: 403,
			body: '{"error":{"message":"The response was filtered","type":"content_policy"}}',
		});
		const res = await handleProxy(proxyReq(), h.proxyDeps);
		expect(res.status).toBe(403);
		expect(res.headers.get("x-aihub-auto-group")).toBe("1");
		expect(
			((await res.json()) as { error: { message: string } }).error.message,
		).toContain("filtered");
	});

	test("全部候选失败 ⇒ 返回最后上游错误", async () => {
		h = await setupRouted();
		h.mock.behavior.groups.set(1, { status: 500 });
		h.mock.behavior.groups.set(2, { status: 500 });
		h.mock.behavior.groups.set(3, { status: 500, gzip: true });
		const res = await handleProxy(proxyReq(), h.proxyDeps);
		expect(res.status).toBe(500);
		expect(res.headers.get("content-encoding")).toBeNull();
		expect(res.headers.get("x-aihub-auto-local-response")).toBeNull();
		expect(res.headers.get("x-aihub-auto-group")).not.toBeNull();
		expect(
			((await res.json()) as { error: { message: string } }).error.message,
		).toContain("HTTP 500");
	});

	test("Bun.serve 下全部失败返回可读终止体且无控制器拒绝", async () => {
		h = await setupRouted();
		h.mock.behavior.groups.set(1, { status: 500 });
		h.mock.behavior.groups.set(2, { status: 502 });
		h.mock.behavior.groups.set(3, { status: 503, gzip: true });
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		const server = Bun.serve({
			port: 0,
			fetch: (request) => handleProxy(request, h.proxyDeps),
		});
		try {
			const res = await fetch(new URL("/v1/chat/completions", server.url), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "gpt-test", messages: [] }),
			});
			expect(res.status).toBe(503);
			expect(res.headers.get("content-encoding")).toBeNull();
			expect(
				((await res.json()) as { error: { message: string } }).error.message,
			).toContain("HTTP 503");
			await Bun.sleep(20);
			expect(
				unhandled.filter(
					(reason) =>
						reason instanceof Error &&
						/Controller is already closed/i.test(reason.message),
				),
			).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
			server.stop(true);
		}
	});

	test("TTFB 超时 ⇒ 换组", async () => {
		h = await setupRouted({ ttfbTimeoutMs: 1_000 });
		h.proxyDeps.ttfbTimeoutMs = 1_000;
		h.mock.behavior.groups.set(1, { delayMs: 3_000 });
		const res = await handleProxy(proxyReq(), h.proxyDeps);
		expect(res.status).toBe(200);
		expect(res.headers.get("x-aihub-auto-group")).toBe("2");
	}, 10_000);

	test("响应头已返回但首字节卡住 ⇒ 仍按 TTFB 超时换组", async () => {
		h = await setupRouted({ ttfbTimeoutMs: 1_000 });
		h.proxyDeps.ttfbTimeoutMs = 80;
		let calls = 0;
		const realFetch = globalThis.fetch;
		h.proxyDeps.fetch = (async (input, init) => {
			calls++;
			if (calls === 1) {
				return new Response(
					new ReadableStream<Uint8Array>({
						start() {
							/* 只给头,不发 body 字节 */
						},
						cancel() {},
					}),
					{ status: 200, headers: { "Content-Type": "text/event-stream" } },
				);
			}
			return realFetch(input, init);
		}) as typeof fetch;
		const res = await handleProxy(proxyReq(), h.proxyDeps);
		expect(res.status).toBe(200);
		expect(res.headers.get("x-aihub-auto-group")).toBe("2");
		expect(calls).toBeGreaterThan(1);
	}, 5_000);

	test("中途断流 ⇒ 不重试不切组,只透传已收到的部分", async () => {
		h = await setupRouted();
		let upstreamCalls = 0;
		h.proxyDeps.fetch = (async () => {
			upstreamCalls++;
			return new Response(
				new ReadableStream<Uint8Array>({
					async start(controller) {
						controller.enqueue(new TextEncoder().encode("data: partial\n\n"));
						await Bun.sleep(10);
						controller.error(new Error("mid-stream break"));
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		}) as unknown as typeof fetch;
		const res = await handleProxy(proxyReq(), h.proxyDeps);
		expect(res.status).toBe(200); // 头已 200
		const text = await res.text();
		// 已提交的响应必须安全截断,不得再把断流注入下游 controller.error。
		expect(text).toContain("data: partial");
		expect(text).not.toContain("[DONE]");
		// 未发生重试/切组(响应已开始)
		expect(res.headers.get("x-aihub-auto-group")).toBe("1");
		expect(h.state.currentGroupId).toBe(1);
		expect(upstreamCalls).toBe(1);
		expect(h.observations.getObservation(1)?.errorRate).toBe(1);
	});

	test("模型不兼容只屏蔽该 group/model 并迁移会话", async () => {
		h = await setupRouted();
		h.mock.behavior.groups.set(1, { unsupportedModels: new Set(["gpt-sol"]) });
		const res = await handleProxy(sessionReq("sol-A", "gpt-sol"), h.proxyDeps);
		expect(res.status).toBe(200);
		expect(res.headers.get("x-aihub-auto-group")).toBe("2");
		await res.text();
		expect(h.daemon.modelBlockStats().pairs).toBe(1);

		const group1Key = h.state.pool["1"]!.sk;
		const before = h.mock.requestLog.filter(
			(request) => request.auth === `Bearer ${group1Key}`,
		).length;
		const second = await handleProxy(
			sessionReq("sol-B", "gpt-sol"),
			h.proxyDeps,
		);
		expect(second.headers.get("x-aihub-auto-group")).toBe("2");
		await second.text();
		const after = h.mock.requestLog.filter(
			(request) => request.auth === `Bearer ${group1Key}`,
		).length;
		expect(after).toBe(before);
	});

	test("static model capabilities keep incompatible sessions isolated", async () => {
		h = await setupRouted();
		h.mock.stats = [
			makeStat({
				groupId: 1,
				supportedModels: ["gpt-sol"],
				modelAvailabilityKnown: true,
			}),
			makeStat({
				groupId: 2,
				supportedModels: ["claude-haiku"],
				modelAvailabilityKnown: true,
			}),
		];
		h.daemon.resetAccountCaches();
		await h.daemon.runOnce({ dryRun: true });
		const gpt = await handleProxy(sessionReq("static-gpt", "gpt-sol"), h.proxyDeps);
		expect(gpt.status).toBe(200);
		expect(gpt.headers.get("x-aihub-auto-group")).toBe("1");
		await gpt.text();
		const claude = await handleProxy(
			sessionReq("static-claude", "claude-haiku"),
			h.proxyDeps,
		);
		expect(claude.status).toBe(200);
		expect(claude.headers.get("x-aihub-auto-group")).toBe("2");
		await claude.text();
		expect(h.daemon.modelBlockStats().pairs).toBe(0);
	});

	test("非路由性 4xx(400)不换组如实透传", async () => {
		h = await setupRouted();
		h.mock.behavior.groups.set(1, { status: 400 });
		const res = await handleProxy(proxyReq(), h.proxyDeps);
		expect(res.status).toBe(400);
		expect(h.state.currentGroupId).toBe(1);
		expect(h.daemon.modelBlockStats().pairs).toBe(0);
	});

	test("旧流迟到缓存证据不覆盖较新主绑定", async () => {
		h = await setupRouted();
		const session = "stale-cache";
		let finishOld!: () => void;
		const gate = new Promise<void>((resolve) => {
			finishOld = resolve;
		});
		let calls = 0;
		const realFetch = globalThis.fetch;
		h.proxyDeps.fetch = (async (input, init) => {
			calls++;
			if (calls === 1) {
				return new Response(
					new ReadableStream<Uint8Array>({
						async start(controller) {
							const enc = new TextEncoder();
							controller.enqueue(enc.encode('{"id":"resp_old","usage":{'));
							await gate;
							controller.enqueue(
								enc.encode(
									'"prompt_tokens":100,"prompt_tokens_details":{"cached_tokens":0}}}',
								),
							);
							controller.close();
						},
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}
			return realFetch(input, init);
		}) as typeof fetch;

		const oldRes = await handleProxy(sessionReq(session), h.proxyDeps);
		expect(oldRes.headers.get("x-aihub-auto-group")).toBe("1");
		const oldBody = oldRes.text();

		h.mock.behavior.groups.set(1, { status: 500 });
		const newer = await handleProxy(sessionReq(session), h.proxyDeps);
		expect(newer.headers.get("x-aihub-auto-group")).toBe("2");
		await newer.text();
		expect(
			Object.values(h.state.sessions).map((binding) => binding.groupId),
		).toEqual([2]);

		finishOld();
		await oldBody;
		expect(
			Object.values(h.state.sessions).map((binding) => binding.groupId),
		).toEqual([2]);
		expect(h.affinity.stats().cacheMisses).toBe(0);
	});

	test("previous_response_id 分支回到实际组,不改写主绑定", async () => {
		h = await setupRouted();
		await (await handleProxy(sessionReq("branch-main"), h.proxyDeps)).text();
		const mainKey = Object.keys(h.state.sessions)[0]!;
		h.affinity.bindResponse("resp_branch", mainKey, 2);
		h.affinity.bind(mainKey, 1);

		const res = await handleProxy(
			proxyReq("/v1/responses", {
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "gpt-test",
					previous_response_id: "resp_branch",
					input: "continue",
				}),
			}),
			h.proxyDeps,
		);
		expect(res.headers.get("x-aihub-auto-group")).toBe("2");
		await res.text();
		expect(h.state.sessions[mainKey]?.groupId).toBe(1);
	});
});

describe("高并发新会话", () => {
	test("并发新会话在等权候选上分散,且 reservation 先于 begin 可见", async () => {
		h = createHarness({
			configPatch: { keyMode: "pool", mode: "balanced", poolMaxGroups: 4 },
		});
		h.mock.stats = [
			makeStat({ groupId: 1, rateMultiplier: 0.05, avgTtftMs: 1500 }),
			makeStat({ groupId: 2, rateMultiplier: 0.05, avgTtftMs: 1500 }),
			makeStat({ groupId: 3, rateMultiplier: 0.05, avgTtftMs: 1500 }),
			makeStat({ groupId: 4, rateMultiplier: 0.05, avgTtftMs: 1500 }),
		];
		await h.daemon.runOnce();

		const gates: Array<() => void> = [];
		const realFetch = globalThis.fetch;
		let openStreams = 0;
		h.proxyDeps.fetch = (async (input, init) => {
			openStreams++;
			const release = await new Promise<() => void>((resolve) => {
				gates.push(() => resolve(() => {}));
			});
			const upstream = await realFetch(input, init);
			const text = await upstream.text();
			release();
			openStreams--;
			return new Response(text, {
				status: upstream.status,
				headers: upstream.headers,
			});
		}) as typeof fetch;

		const pending = Array.from({ length: 12 }, (_, i) =>
			handleProxy(sessionReq(`burst-${i}`), h.proxyDeps),
		);
		for (let i = 0; i < 40 && gates.length < 12; i++) await Bun.sleep(5);
		expect(gates.length).toBe(12);
		const snap = h.traffic.snapshot();
		const loads = Object.values(snap.activeByGroup ?? {});
		expect(loads.reduce((a, b) => a + b, 0)).toBe(12);
		expect(Math.max(...loads)).toBeLessThanOrEqual(6);
		expect(new Set(Object.keys(snap.activeByGroup ?? {})).size).toBeGreaterThan(
			1,
		);

		for (const release of gates) release();
		const responses = await Promise.all(pending);
		const groups = responses.map((res) =>
			res.headers.get("x-aihub-auto-group"),
		);
		await Promise.all(responses.map((res) => res.text()));
		expect(new Set(groups).size).toBeGreaterThan(1);
		expect(openStreams).toBe(0);
	});
});

describe("single 兼容模式", () => {
	test("共享 Key 等前一个流结束后才允许切组", async () => {
		h = createHarness({ configPatch: { keyMode: "single" } });
		h.mock.stats = [
			makeStat({ groupId: 1, rateMultiplier: 0.03, avgTtftMs: 1500 }),
			makeStat({ groupId: 2, rateMultiplier: 0.05, avgTtftMs: 1800 }),
		];
		h.mock.keys.set(1, {
			id: 1,
			name: "shared",
			key: "sk-single",
			group_id: 1,
		});
		await h.daemon.runOnce();

		let finish!: () => void;
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		let modelCalls = 0;
		const fetchFn = globalThis.fetch;
		h.proxyDeps.fetch = (async (input, init) => {
			modelCalls++;
			if (modelCalls > 1) return fetchFn(input, init);
			return new Response(
				new ReadableStream<Uint8Array>({
					async start(controller) {
						controller.enqueue(new TextEncoder().encode("first"));
						await gate;
						controller.close();
					},
				}),
				{ headers: { "x-aihub-auto-local-response": "1" } },
			);
		}) as typeof fetch;

		const first = await handleProxy(proxyReq(), h.proxyDeps);
		expect(first.headers.get("x-aihub-auto-local-response")).toBeNull();
		const firstBody = first.text();
		h.config.blacklist.push(1);
		let secondResolved = false;
		const secondPending = handleProxy(proxyReq(), h.proxyDeps).then(
			(response) => {
				secondResolved = true;
				return response;
			},
		);
		await Bun.sleep(20);
		expect(secondResolved).toBe(false);
		expect(modelCalls).toBe(1);
		expect(h.mock.keys.get(1)?.group_id).toBe(1);

		finish();
		expect(await firstBody).toBe("first");
		const second = await secondPending;
		expect(second.headers.get("x-aihub-auto-group")).toBe("2");
		await second.text();
		expect(h.mock.keys.get(1)?.group_id).toBe(2);
	});

	test("长流期间控制台锁定等待流结束,不会中途改共享 Key", async () => {
		h = createHarness({
			withServer: true,
			configPatch: { keyMode: "single", mode: "balanced" },
		});
		h.mock.stats = [
			makeStat({ groupId: 1, rateMultiplier: 0.03, avgTtftMs: 1000 }),
			makeStat({ groupId: 2, rateMultiplier: 0.05, avgTtftMs: 2000 }),
		];
		h.mock.keys.set(1, {
			id: 1,
			name: "shared",
			key: "sk-single",
			group_id: 1,
		});
		await h.daemon.runOnce();

		let finish!: () => void;
		const streamGate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		h.proxyDeps.fetch = (async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					async start(controller) {
						controller.enqueue(new TextEncoder().encode("open"));
						await streamGate;
						controller.close();
					},
				}),
			)) as unknown as typeof fetch;

		const response = await handleProxy(proxyReq(), h.proxyDeps);
		const body = response.text();
		let lockResolved = false;
		const lockRequest = fetch(`${h.serverUrl}/ctl/route-lock`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ groupId: 2, expectedRevision: 0 }),
		}).then((result) => {
			lockResolved = true;
			return result;
		});
		await Bun.sleep(20);
		expect(lockResolved).toBe(false);
		expect(h.mock.keys.get(1)?.group_id).toBe(1);

		finish();
		expect(await body).toBe("open");
		const locked = await lockRequest;
		expect(locked.status).toBe(200);
		expect(h.mock.keys.get(1)?.group_id).toBe(2);
	});
});

describe("流量统计", () => {
	test("请求计入 TrafficTracker,流结束归还 activeStreams", async () => {
		h = await setupRouted();
		const res = await handleProxy(proxyReq(), h.proxyDeps);
		await res.text();
		await Bun.sleep(10);
		const snap = h.traffic.snapshot();
		expect(snap.requestsLast5m).toBeGreaterThanOrEqual(1);
		expect(snap.activeStreams).toBe(0);
		expect(snap.lastRequestAt).toBeDefined();
	});
});
