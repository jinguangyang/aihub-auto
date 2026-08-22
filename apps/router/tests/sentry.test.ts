import { describe, expect, test } from "bun:test";
import { AIHubApiError } from "@aihub-auto/core";
import * as Sentry from "@sentry/bun";
import { CredentialsSchema, ConfigSchema } from "../src/config.ts";
import { initRouterSentry, isExpectedUpstreamError } from "../src/sentry.ts";

describe("Sentry 过滤边界", () => {
	test("AIHub/OpenAI 响应、超时和连接失败不作为应用错误上报", () => {
		expect(
			isExpectedUpstreamError(new AIHubApiError("unauthorized", 401)),
		).toBe(true);
		expect(
			isExpectedUpstreamError(
				new Error("OpenAI API error (401): 401 status code (no body)"),
			),
		).toBe(true);
		expect(isExpectedUpstreamError(new Error("TTFB timeout"))).toBe(true);
		expect(isExpectedUpstreamError(new Error("read ECONNRESET"))).toBe(true);
		expect(
			isExpectedUpstreamError(new DOMException("client aborted", "AbortError")),
		).toBe(true);
	});

	test("路由器自身异常仍可进入 Sentry", () => {
		expect(
			isExpectedUpstreamError(
				new TypeError("Cannot read properties of undefined (reading state)"),
			),
		).toBe(false);
	});

	test("DSN 默认启用且已验证邮箱可以持久化", () => {
		expect(ConfigSchema.parse({}).sentryDsn).toBe(
			"https://b8e9b3b5f1d86b44f01dae7fe83cfcce@o4510289605296128.ingest.de.sentry.io/4511828894548048",
		);
		expect(
			ConfigSchema.parse({
				sentryDsn: "https://public@example.ingest.sentry.io/1",
			}).sentryDsn,
		).toBe("https://public@example.ingest.sentry.io/1");
		expect(() =>
			ConfigSchema.parse({ sentryDsn: "https://example.com/not-a-dsn" }),
		).toThrow();
		expect(() =>
			ConfigSchema.parse({
				sentryDsn: "https://public:secret@example.ingest.sentry.io/1",
			}),
		).toThrow();
		expect(() =>
			ConfigSchema.parse({
				sentryDsn: "https://public@user:pass@example.ingest.sentry.io/1",
			}),
		).toThrow();
		expect(() =>
			ConfigSchema.parse({
				sentryDsn: "https://public@example.ingest.sentry.io/project-name",
			}),
		).toThrow();
		expect(() =>
			ConfigSchema.parse({
				sentryDsn: "https://public@example.ingest.sentry.io/1/",
			}),
		).toThrow();
		expect(CredentialsSchema.parse({ email: "user@example.com" }).email).toBe(
			"user@example.com",
		);
		expect(() => CredentialsSchema.parse({ email: "not-an-email" })).toThrow();
	});

	test("更新镜像只接受 HTTPS endpoint", () => {
		expect(
			ConfigSchema.parse({
				updateMirrors: ["https://mirror.example/latest.json"],
			}).updateMirrors,
		).toEqual(["https://mirror.example/latest.json"]);
		expect(() =>
			ConfigSchema.parse({
				updateMirrors: ["http://mirror.example/latest.json"],
			}),
		).toThrow();
	});

	test("AIHub source accepts HTTPS origins and loopback HTTP only", () => {
		expect(ConfigSchema.parse({ baseUrl: "https://aihub.dog" }).baseUrl).toBe(
			"https://aihub.dog",
		);
		expect(ConfigSchema.parse({ baseUrl: "https://aihub.dog/" }).baseUrl).toBe(
			"https://aihub.dog",
		);
		expect(ConfigSchema.parse({ baseUrl: "https://AIHUB.DOG:443/" }).baseUrl).toBe(
			"https://aihub.dog",
		);
		expect(
			ConfigSchema.parse({ baseUrl: "http://127.0.0.1:8787" }).baseUrl,
		).toBe("http://127.0.0.1:8787");
		expect(
			ConfigSchema.parse({ baseUrl: "http://localhost:8787" }).baseUrl,
		).toBe("http://localhost:8787");

		for (const baseUrl of [
			"http://aihub.dog",
			"https://aihub.dog/path",
			"https://aihub.dog/..",
			"https://aihub.dog/%2e%2e",
			"https://aihub.dog?query=1",
			"https://aihub.dog/#fragment",
			"https://aihub.dog?",
			"https://aihub.dog#",
			"https://@aihub.dog",
			"https://:@aihub.dog",
			"https://user:secret@aihub.dog",
			"https://*",
			"https://*.dog",
			"https://foo..bar",
			"https://aihub.dog:",
			"https://aihub.dog\\",
			"http://127.0.0.1.",
			"file:///tmp/aihub",
		]) {
			expect(() => ConfigSchema.parse({ baseUrl })).toThrow();
		}
	});

	test("publicOrigin 只接受无路径的完整 HTTP(S) origin", () => {
		expect(
			ConfigSchema.parse({ publicOrigin: "https://router.example" })
				.publicOrigin,
		).toBe("https://router.example");
		for (const publicOrigin of [
			"https://router.example/path",
			"https://router.example?query=1",
			"file:///tmp/ui",
		]) {
			expect(() => ConfigSchema.parse({ publicOrigin })).toThrow();
		}
	});

	test("SDK 只保留错误集成且显式关闭敏感数据收集", () => {
		expect(
			initRouterSentry({
				dsn: "http://public@127.0.0.1:9999/1",
				upstreamBaseUrl: "https://aihub.top",
			}),
		).toBe(true);
		const client = Sentry.getClient();
		expect(client?.getOptions().tracesSampleRate).toBeUndefined();
		const names =
			client?.getOptions().integrations?.map(({ name }) => name) ?? [];
		expect(names).toEqual([
			"InboundFilters",
			"FunctionToString",
			"LinkedErrors",
			"Context",
			"Modules",
		]);
		expect(client?.getDataCollectionOptions()).toMatchObject({
			userInfo: false,
			cookies: false,
			httpHeaders: { request: false, response: false },
			httpBodies: [],
			urlQueryParams: false,
			graphQL: { document: false, variables: false },
			genAI: { inputs: false, outputs: false },
			databaseQueryData: false,
			stackFrameVariables: false,
			frameContextLines: 0,
		});
	});
});
