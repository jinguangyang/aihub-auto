import { afterEach, describe, expect, test } from "bun:test";
import { AIHubClient } from "@aihub-auto/core";
import { AccountSwitchBusyError } from "../src/account-errors.ts";
import { AccountSwitchService } from "../src/account-switch.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("AIHub account switch service", () => {
	let h: Harness;
	afterEach(() => h?.dispose());

	function service(): AccountSwitchService {
		return new AccountSwitchService({
			client: h.client,
			createClient: (token) =>
				new AIHubClient({ baseUrl: h.mock.url, token: () => token }),
			state: h.state,
			credentials: h.credentials,
			executor: h.executor,
			daemon: h.daemon,
			logger: h.logger,
			persistState: h.persistState,
			persistCredentials: h.persistCredentials,
			syncSentryUser: () => {},
		});
	}

	test("same identity refreshes credentials without clearing continuity", async () => {
		h = createHarness();
		await h.executor.ensureKey(1);
		h.affinity.bind("session", 1);

		const result = await service().login({ token: "mock-at-2" });

		expect(result.switched).toBe(false);
		expect(h.state.pool["1"]).toBeDefined();
		expect(h.affinity.resolve("session")).toBe(1);
	});

	test("different identity clears old account state and keeps the new credential", async () => {
		h = createHarness();
		h.credentials.singleKeySk = "sk-old-single";
		await h.executor.ensureKey(1);
		h.affinity.bind("session", 1);
		h.state.modelBlocks["model"] = { "1": Date.now() + 60_000 };

		const result = await service().login({ token: "account-two-token" });

		expect(result).toMatchObject({
			switched: true,
			email: "second@test.local",
		});
		expect(h.credentials.accessToken).toBe("account-two-token");
		expect(h.credentials.singleKeySk).toBeUndefined();
		expect(h.state.sessions).toEqual({});
		expect(h.state.modelBlocks).toEqual({});
		expect(
			Object.values(h.state.pool).every(
				(entry) => entry.sk !== "sk-old-single",
			),
		).toBe(true);
	});

	test("active traffic rejects switching before credentials or pool mutate", async () => {
		h = createHarness();
		await h.executor.ensureKey(1);
		const oldToken = h.credentials.accessToken;
		const oldPool = structuredClone(h.state.pool);
		h.traffic.begin(1);

		try {
			await expect(service().login({ token: "account-two-token" })).rejects
				.toBeInstanceOf(AccountSwitchBusyError);
			expect(h.credentials.accessToken).toBe(oldToken);
			expect(h.state.pool).toEqual(oldPool);
		} finally {
			h.traffic.end(1);
		}
	});

	test("invalid candidate credentials leave the current account unchanged", async () => {
		h = createHarness();
		await h.executor.ensureKey(1);
		const oldCredentials = { ...h.credentials };
		const oldPool = structuredClone(h.state.pool);

		await expect(service().login({ token: "unknown-token" })).rejects.toThrow(
			/unauthorized/,
		);
		expect(h.credentials).toEqual(oldCredentials);
		expect(h.state.pool).toEqual(oldPool);
	});

	test("same-account persistence failure preserves continuity", async () => {
		h = createHarness();
		await h.executor.ensureKey(1);
		h.affinity.bind("session", 1);
		const oldPool = structuredClone(h.state.pool);
		const failing = new AccountSwitchService({
			client: h.client,
			createClient: (token) =>
				new AIHubClient({ baseUrl: h.mock.url, token: () => token }),
			state: h.state,
			credentials: h.credentials,
			executor: h.executor,
			daemon: h.daemon,
			logger: h.logger,
			persistState: h.persistState,
			persistCredentials: async () => {
				throw new Error("disk full");
			},
			syncSentryUser: () => {},
		});

		await expect(failing.login({ token: "mock-at-2" })).rejects.toThrow(
			"disk full",
		);
		expect(h.state.pool).toEqual(oldPool);
		expect(h.affinity.resolve("session")).toBe(1);
	});

	test("persistence failure restores the previous in-memory credential", async () => {
		h = createHarness();
		const oldToken = h.credentials.accessToken;
		const failing = new AccountSwitchService({
			client: h.client,
			createClient: (token) =>
				new AIHubClient({ baseUrl: h.mock.url, token: () => token }),
			state: h.state,
			credentials: h.credentials,
			executor: h.executor,
			daemon: h.daemon,
			logger: h.logger,
			persistState: h.persistState,
			persistCredentials: async () => {
				throw new Error("disk full");
			},
			syncSentryUser: () => {},
		});

		await expect(failing.login({ token: "account-two-token" })).rejects.toThrow(
			"disk full",
		);
		expect(h.credentials.accessToken).toBe(oldToken);
		expect(h.credentials.accountIdentity).toBe("id:account-1");
	});
});
