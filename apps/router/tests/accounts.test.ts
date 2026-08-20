import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AccountsSchema,
	ensureActiveProfile,
	loadAccounts,
	redactedAccountProfiles,
	upsertAccountProfile,
	type Accounts,
} from "../src/accounts.ts";
import { FileStore, type Credentials } from "../src/config.ts";

describe("AIHub account profile store", () => {
	test("parses a version-one profile and redacts secrets", () => {
		const accounts = AccountsSchema.parse({
			activeIdentity: "id:one",
			profiles: [
				{
					identity: "id:one",
					email: "one@example.com",
					accessToken: "access-one",
					refreshToken: "refresh-one",
					expiresAt: 123,
					createdAt: 100,
					lastUsedAt: 123,
				},
			],
		});
		const redacted = redactedAccountProfiles(accounts);
		expect(redacted).toEqual([
			{
				identity: "id:one",
				email: "one@example.com",
				active: true,
				createdAt: 100,
				lastUsedAt: 123,
			},
		]);
		const text = JSON.stringify(redacted);
		expect(text).not.toContain("access-one");
		expect(text).not.toContain("refresh-one");
	});

	test("rejects duplicate identities and unknown fields", () => {
		expect(() =>
			AccountsSchema.parse({
				profiles: [
					{ identity: "same", accessToken: "a", createdAt: 1, lastUsedAt: 1 },
					{ identity: "same", accessToken: "b", createdAt: 2, lastUsedAt: 2 },
				],
			}),
		).toThrow();
		expect(() =>
			AccountsSchema.parse({
				profiles: [
					{
						identity: "id:one",
						accessToken: "a",
						createdAt: 1,
						lastUsedAt: 1,
						secret: "unexpected",
					},
				],
			}),
		).toThrow();
	});

	test("loads malformed files as an empty profile store", async () => {
		const dir = mkdtempSync(join(tmpdir(), "aihub-auto-accounts-"));
		try {
			const store = new FileStore(dir);
			await Bun.write(join(dir, "accounts.json"), "not-json");
			expect(await loadAccounts(store)).toEqual({
			version: 1,
			profiles: [],
			activeIdentity: undefined,
		});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("upserts an identity without duplicating it", () => {
		const accounts: Accounts = AccountsSchema.parse({});
		upsertAccountProfile(accounts, {
			identity: "id:one",
			accessToken: "a",
			createdAt: 1,
			lastUsedAt: 1,
		});
		upsertAccountProfile(accounts, {
			identity: "id:one",
			email: "one@example.com",
			accessToken: "b",
			createdAt: 99,
			lastUsedAt: 2,
		});
		expect(accounts.profiles).toHaveLength(1);
		expect(accounts.profiles[0]).toMatchObject({
			identity: "id:one",
			email: "one@example.com",
			accessToken: "b",
			createdAt: 1,
			lastUsedAt: 2,
		});
	});

	test("imports the active runtime credential once", () => {
		const accounts = AccountsSchema.parse({});
		const credentials: Credentials = {
			accessToken: "access-one",
			refreshToken: "refresh-one",
			accountIdentity: "id:one",
			email: "one@example.com",
			expiresAt: 456,
		};
		expect(ensureActiveProfile(accounts, credentials, 500)).toBe(true);
		expect(ensureActiveProfile(accounts, credentials, 600)).toBe(false);
		expect(accounts.activeIdentity).toBe("id:one");
		expect(accounts.profiles).toHaveLength(1);
		expect(accounts.profiles[0]).toMatchObject({
			accessToken: "access-one",
			refreshToken: "refresh-one",
			expiresAt: 456,
			lastUsedAt: 500,
		});
	});
});
