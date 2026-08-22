import { describe, expect, test } from "bun:test";
import {
	applyManagedSecretOverrides,
	ConfigSchema,
	StateSchema,
	type Credentials,
} from "../src/config.ts";
import { alignAccountStateOwner } from "../src/account-state.ts";
import { matchesAccountPool } from "../src/daemon.ts";
import {
	applyStartupOptions,
	parseStartupOptions,
	STARTUP_HELP,
} from "../src/startup.ts";
import { createHarness } from "./harness.ts";

describe("startup options", () => {
	test.each([
		[["--port", "9000"], {}, 9000],
		[["--port=9001"], {}, 9001],
		[[], { AIHUB_AUTO_PORT: "9002" }, 9002],
		[["--port", "9003"], { AIHUB_AUTO_PORT: "9004" }, 9003],
	] as const)("args=%j env=%j selects %i", (args, env, port) => {
		expect(parseStartupOptions([...args], env).port).toBe(port);
	});

	test.each(["0", "65536", "1.5", " 9000", "9000 ", "+9000", "09x"])(
		"rejects invalid environment port %s",
		(value) => {
			expect(() =>
				parseStartupOptions([], { AIHUB_AUTO_PORT: value }),
			).toThrow(/AIHUB_AUTO_PORT.*1.*65535/);
		},
	);

	test.each([
		["missing value", ["--port"]],
		["duplicate", ["--port=9000", "--port", "9001"]],
		["unknown", ["--listen", "9000"]],
	] as const)("rejects %s", (_name, args) => {
		expect(() => parseStartupOptions([...args], {})).toThrow();
	});

	test("help does not require a port and describes precedence", () => {
		expect(parseStartupOptions(["--help"], {}).help).toBe(true);
		expect(STARTUP_HELP).toContain("--port");
		expect(STARTUP_HELP).toContain("AIHUB_AUTO_PORT");
	});

	test("override changes memory but leaves the loaded object unchanged", () => {
		const loaded = ConfigSchema.parse({ listen: { port: 8123 } });
		const effective = applyStartupOptions(loaded, {
			help: false,
			port: 9123,
		});
		expect(effective.listen.port).toBe(9123);
		expect(loaded.listen.port).toBe(8123);
	});

	test("accepts the supported 9-character console password", () => {
		expect(ConfigSchema.parse({ uiPassword: "Qazwsx01@" }).uiPassword).toBe(
			"Qazwsx01@",
		);
	});

	test("rejects console passwords shorter than 9 characters", () => {
		expect(() => ConfigSchema.parse({ uiPassword: "12345678" })).toThrow();
	});

	test("managed secrets override runtime config without mutating the loaded object", () => {
		const persisted = ConfigSchema.parse({
			uiPassword: "persisted-console-password",
			proxyToken: "persisted-proxy-token",
		});
		const effective = applyManagedSecretOverrides(persisted, {
			AIHUB_AUTO_UI_PASSWORD: " managed-console-password ",
			AIHUB_AUTO_PROXY_TOKEN: " managed-proxy-token ",
		});
		expect(effective.uiPassword).toBe("managed-console-password");
		expect(effective.proxyToken).toBe("managed-proxy-token");
		expect(persisted.uiPassword).toBe("persisted-console-password");
		expect(persisted.proxyToken).toBe("persisted-proxy-token");
	});

	test("verified startup identity clears state owned by another account", () => {
		const state = StateSchema.parse({
			accountIdentity: "id:old-account",
			pool: { "1": { keyId: 1, sk: "sk-old", lastUsedAt: 1 } },
		});
		const credentials: Credentials = {
			accessToken: "new-token",
			accountIdentity: "id:old-account",
		};

		const result = alignAccountStateOwner(state, credentials, {
			id: "new-account",
			email: "new@example.com",
		});

		expect(result.reset).toBe(true);
		expect(state.pool).toEqual({});
		expect(state.accountIdentity).toBe("id:new-account");
	});

	test("legacy state defaults to an empty pending delete queue", () => {
		expect(StateSchema.parse({}).pendingPoolDeletes).toEqual({});
	});
});

describe("account pool configuration", () => {
	test.each([
		["A003-Plus", ["plus"], "pro", true],
		["A003-Pro", ["plus"], "pro", false],
		["A003-Pro", ["pro"], "all", true],
		["A001-Team/K12", ["team"], "all", true],
		["TEAM PLUS 混池", ["team"], "all", true],
		["TEAM PLUS pool", ["pro"], "all", false],
		["A008-BugTeam", ["team"], "all", false],
		["A003-Plus", [], "all", true],
		["A003-Plus", [], "mixed", true],
		["A001-Team/K12", [], "mixed", true],
	] as const)(
		"matches %s configured=%j legacy=%s as %s",
		(name, configured, legacy, expected) => {
			expect(matchesAccountPool(name, configured, legacy)).toBe(expected);
		},
	);

	test("defaults to no account-plan filtering with the existing price band", () => {
		const config = ConfigSchema.parse({});
		expect(config.accountPoolMode).toBe("all");
		expect(config.accountPoolPlans).toEqual([]);
		expect(config.priceBand).toEqual({ min: 0, max: 0.15 });
	});

	test("accepts a nullable price band", () => {
		const config = ConfigSchema.parse({
			accountPoolMode: "mixed",
			priceBand: null,
		});
		expect(config.accountPoolMode).toBe("mixed");
		expect(config.accountPoolPlans).toEqual([]);
		expect(config.priceBand).toBeNull();
		const harness = createHarness({ configPatch: { priceBand: null } });
		try {
			expect(harness.daemon.scoringOptions("openai", Date.now()).priceBand).toEqual({
				min: 0,
				max: Number.MAX_VALUE,
			});
		} finally {
			harness.dispose();
		}
	});

	test("rejects an inverted price band", () => {
		expect(() =>
			ConfigSchema.parse({ priceBand: { min: 0.3, max: 0.2 } }),
		).toThrow();
	});

	test("preserves valid duplicate selected plans but rejects invalid selections", () => {
		expect(
			ConfigSchema.parse({ accountPoolPlans: ["plus", "plus"] })
				.accountPoolPlans,
		).toEqual(["plus", "plus"]);
		expect(() =>
			ConfigSchema.parse({ accountPoolPlans: ["plus", "pro", "team", "plus"] }),
		).toThrow();
		expect(() => ConfigSchema.parse({ accountPoolPlans: ["enterprise"] })).toThrow();
	});
});
