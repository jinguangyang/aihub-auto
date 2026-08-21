import { describe, expect, test } from "bun:test";
import { StateSchema } from "../src/config.ts";
import {
	SessionAffinity,
	findResponseId,
	requestRoutingContext,
} from "../src/session.ts";

function jsonBody(value: unknown): ArrayBuffer {
	return new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer;
}

describe("requestRoutingContext", () => {
	test("显式会话按模型隔离,仅 model 不伪造会话", () => {
		const headers = new Headers({ "x-aihub-auto-session": "same" });
		const a = requestRoutingContext(
			"/v1/responses",
			headers,
			jsonBody({ model: "gpt-a" }),
			() => undefined,
		);
		const b = requestRoutingContext(
			"/v1/responses",
			headers,
			jsonBody({ model: "gpt-b" }),
			() => undefined,
		);
		expect(a.sessionKey).toBeDefined();
		expect(a.continuity).toBe(true);
		expect(a.cacheEvidence).toBe(false);
		expect(a.sessionKey).not.toBe(b.sessionKey);
		expect(
			requestRoutingContext(
				"/v1/responses",
				new Headers(),
				jsonBody({ model: "gpt-a" }),
				() => undefined,
			).sessionKey,
		).toBeUndefined();
	});

	test("unknown previous_response_id 有稳定回退,已知 alias 恢复原会话", () => {
		const body = jsonBody({
			model: "gpt-a",
			previous_response_id: "resp_previous",
		});
		const unknown = requestRoutingContext(
			"/v1/responses",
			new Headers(),
			body,
			() => undefined,
		);
		expect(unknown.sessionKey).toBeDefined();
		expect(
			requestRoutingContext("/v1/responses", new Headers(), body, () => ({
				sessionKey: "bound-session",
				groupId: 7,
			})).sessionKey,
		).toBe("bound-session");
		expect(
			requestRoutingContext("/v1/responses", new Headers(), body, () => ({
				sessionKey: "bound-session",
				groupId: 7,
			})).preferredGroupId,
		).toBe(7);
	});

	test("model-scoped session bindings coexist without cross-model reuse", () => {
		const state = StateSchema.parse({});
		const affinity = new SessionAffinity(state, 60_000, 100);
		const headers = new Headers({ "x-aihub-auto-session": "shared" });
		const gpt = requestRoutingContext(
			"/v1/responses",
			headers,
			jsonBody({ model: "gpt-a" }),
			() => undefined,
		);
		const claude = requestRoutingContext(
			"/v1/responses",
			headers,
			jsonBody({ model: "claude-a" }),
			() => undefined,
		);
		affinity.bind(gpt.sessionKey!, 1);
		affinity.bind(claude.sessionKey!, 2);
		expect(affinity.resolve(gpt.sessionKey!)).toBe(1);
		expect(affinity.resolve(claude.sessionKey!)).toBe(2);
	});

	test("响应 ID 可跨分块累计识别", () => {
		const chunks = [
			'data: {"type":"response.created","response":{',
			'"id":"resp_abc-1"}}',
		];
		expect(findResponseId(chunks[0]!)).toBeUndefined();
		expect(findResponseId(chunks.join(""))).toBe("resp_abc-1");
	});
});

describe("StateSchema", () => {
	test("手动锁定默认关闭且 revision 在序列化后保留", () => {
		const initial = StateSchema.parse({});
		expect(initial.manualLock).toEqual({ groupId: null, revision: 0 });
		initial.manualLock = { groupId: 7, revision: 3 };
		const restored = StateSchema.parse(JSON.parse(JSON.stringify(initial)));
		expect(restored.manualLock).toEqual({ groupId: 7, revision: 3 });
	});
});

describe("SessionAffinity", () => {
	test("CAS rebind 防止旧失败覆盖新绑定", () => {
		const state = StateSchema.parse({});
		const affinity = new SessionAffinity(state, 60_000, 100);
		affinity.bind("session", 1, 1_000);
		expect(affinity.rebind("session", 1, 2, 1_100)).toBe(true);
		expect(affinity.rebind("session", 1, 3, 1_200)).toBe(false);
		expect(affinity.resolve("session", 1_300)).toBe(2);
	});

	test("并发旧请求的版本化回滚不覆盖新绑定", () => {
		const state = StateSchema.parse({});
		const affinity = new SessionAffinity(state, 60_000, 100);
		const old = affinity.bindForRoute("session", 1, 1_000);
		const current = affinity.bindForRoute("session", 2, 1_100);
		expect(old.isCurrent()).toBe(false);
		old.rollback();
		expect(affinity.resolve("session", 1_200)).toBe(2);
		current.rollback();
		expect(affinity.resolve("session", 1_300)).toBe(1);
	});

	test("缓存热度同时考虑 recency 与真实 hit/miss", () => {
		const state = StateSchema.parse({});
		const affinity = new SessionAffinity(state, 60_000, 100);
		affinity.bind("session", 1, 1_000);
		expect(affinity.cacheLikelyHot("session", 5_000, 2_000)).toBe(true);
		affinity.recordCache("session", "miss", 2_100);
		expect(affinity.cacheLikelyHot("session", 5_000, 2_200)).toBe(false);
		affinity.recordCache("session", "hit", 2_300);
		expect(affinity.cacheLikelyHot("session", 5_000, 2_400)).toBe(true);
		expect(affinity.cacheLikelyHot("session", 5_000, 6_001)).toBe(false);
	});

	test("Key 保护只看缓存窗口,会话映射继续保留到 TTL", () => {
		const state = StateSchema.parse({});
		const affinity = new SessionAffinity(state, 60_000, 100);
		affinity.bind("session", 7, 1_000);
		affinity.bindResponse("resp_1", "session", 7, 1_500);
		expect(affinity.protectedGroupIds(5_000, 2_000)).toEqual(new Set([7]));
		expect(affinity.protectedGroupIds(5_000, 7_001)).toEqual(new Set());
		expect(affinity.resolve("session", 7_001)).toBe(7);
		expect(affinity.resolveResponse("resp_1", 7_001)?.groupId).toBe(7);
	});

	test("TTL prune 同时清理失效响应 alias", () => {
		const state = StateSchema.parse({});
		const affinity = new SessionAffinity(state, 1_000, 100);
		affinity.bind("session", 1, 1_000);
		affinity.bindResponse("resp_1", "session", 1, 1_000);
		expect(affinity.resolveResponse("resp_1", 1_500)).toEqual({
			sessionKey: "session",
			groupId: 1,
		});
		expect(affinity.prune(2_001)).toEqual({ sessions: 1, aliases: 0 });
		expect(affinity.resolveResponse("resp_1", 2_001)).toEqual({
			sessionKey: "session",
			groupId: 1,
		});
		expect(affinity.prune(3_002)).toEqual({ sessions: 0, aliases: 1 });
	});
});
