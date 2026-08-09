import { describe, expect, test } from "bun:test";
import { StateSchema, type Credentials } from "../src/config.ts";
import {
	alignAccountStateOwner,
	deriveAccountIdentity,
	profileEmail,
	resetAccountScopedState,
} from "../src/account-state.ts";

describe("AIHub account-owned state", () => {
	test("derives stable id, email, then token identities", () => {
		expect(deriveAccountIdentity({ id: 42, email: "A@Example.com" }, "token-a"))
			.toBe("id:42");
		expect(deriveAccountIdentity({ email: " A@Example.com " }, "token-a"))
			.toBe("email:a@example.com");
		expect(deriveAccountIdentity({}, "token-a")).toMatch(/^token:[a-f0-9]{64}$/);
		expect(profileEmail({ email: " A@Example.com " })).toBe("a@example.com");
	});

	test("clears only account-scoped runtime data", () => {
		const state = StateSchema.parse({
			accountIdentity: "email:old@example.com",
			currentGroupId: 1,
			manualLock: { groupId: 1, revision: 3 },
			lastSwitchAt: 1,
			pendingSwitch: { groupId: 2, since: 1 },
			pool: { "1": { keyId: 7, sk: "sk-old", lastUsedAt: 1 } },
			sessions: { session: { groupId: 1, lastUsedAt: 1 } },
			responseAliases: {
				response: { sessionKey: "session", groupId: 1, lastUsedAt: 1 },
			},
			modelBlocks: { model: { "1": 999 } },
			breaker: { retained: true },
			observations: { retained: true },
		});
		const credentials: Credentials = {
			accessToken: "old-token",
			accountIdentity: "email:old@example.com",
			singleKeySk: "sk-single-old",
		};

		resetAccountScopedState(state, credentials, "email:new@example.com");

		expect(state.accountIdentity).toBe("email:new@example.com");
		expect(state.currentGroupId).toBeUndefined();
		expect(state.manualLock).toEqual({ groupId: null, revision: 4 });
		expect(state.pool).toEqual({});
		expect(state.sessions).toEqual({});
		expect(state.responseAliases).toEqual({});
		expect(state.modelBlocks).toEqual({});
		expect(state.breaker).toEqual({ retained: true });
		expect(credentials.singleKeySk).toBeUndefined();
	});

	test("preserves legacy state on first owner adoption and clears known mismatch", () => {
		const legacy = StateSchema.parse({
			pool: { "1": { keyId: 1, sk: "sk-legacy", lastUsedAt: 1 } },
		});
		const credentials: Credentials = {
			accessToken: "token",
			email: "user@example.com",
		};

		expect(
			alignAccountStateOwner(legacy, credentials, { email: "user@example.com" }),
		).toEqual({ identity: "email:user@example.com", reset: false });
		expect(legacy.pool["1"]?.sk).toBe("sk-legacy");
		expect(
			alignAccountStateOwner(legacy, credentials, {
				id: 42,
				email: "user@example.com",
			}),
		).toEqual({ identity: "id:42", reset: false });
		expect(legacy.pool["1"]?.sk).toBe("sk-legacy");

		legacy.accountIdentity = "email:old@example.com";
		expect(
			alignAccountStateOwner(legacy, credentials, { email: "new@example.com" }).reset,
		).toBe(true);
		expect(legacy.pool).toEqual({});
	});
});
