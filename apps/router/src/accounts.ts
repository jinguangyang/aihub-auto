import { z } from "zod";
import type { Credentials, FileStore } from "./config.ts";

export const AccountProfileSchema = z
	.object({
		identity: z.string().min(1).max(128),
		email: z.string().email().optional(),
		accessToken: z.string().min(1),
		refreshToken: z.string().min(1).optional(),
		expiresAt: z.number().int().nonnegative().optional(),
		createdAt: z.number().int().nonnegative(),
		lastUsedAt: z.number().int().nonnegative(),
	})
	.strict();

export const AccountsSchema = z
	.object({
		version: z.literal(1).default(1),
		activeIdentity: z.string().min(1).max(128).optional(),
		profiles: z.array(AccountProfileSchema).default([]),
	})
	.strict()
	.superRefine((accounts, ctx) => {
		const identities = new Set<string>();
		for (let index = 0; index < accounts.profiles.length; index++) {
			const identity = accounts.profiles[index]!.identity;
			if (identities.has(identity)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["profiles", index, "identity"],
					message: "account identity must be unique",
				});
			}
			identities.add(identity);
		}
		if (accounts.activeIdentity && !identities.has(accounts.activeIdentity)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["activeIdentity"],
				message: "active account must reference a saved profile",
			});
		}
	});

export type AccountProfile = z.infer<typeof AccountProfileSchema>;
export type Accounts = z.infer<typeof AccountsSchema>;

export interface AccountProfileSummary {
	identity: string;
	email?: string;
	active: boolean;
	createdAt: number;
	lastUsedAt: number;
}

export async function loadAccounts(store: FileStore): Promise<Accounts> {
	return store.read(
		"accounts.json",
		AccountsSchema,
		AccountsSchema.parse({}),
	);
}

export function upsertAccountProfile(
	accounts: Accounts,
	profile: AccountProfile,
): void {
	const index = accounts.profiles.findIndex(
		(item) => item.identity === profile.identity,
	);
	if (index < 0) {
		accounts.profiles.push(AccountProfileSchema.parse(profile));
		return;
	}
	const existing = accounts.profiles[index]!;
	accounts.profiles[index] = AccountProfileSchema.parse({
		...profile,
		createdAt: existing.createdAt,
	});
}

export function removeAccountProfile(
	accounts: Accounts,
	identity: string,
): boolean {
	const index = accounts.profiles.findIndex(
		(profile) => profile.identity === identity,
	);
	if (index < 0) return false;
	accounts.profiles.splice(index, 1);
	if (accounts.activeIdentity === identity) {
		delete accounts.activeIdentity;
	}
	return true;
}

export function redactedAccountProfiles(
	accounts: Accounts,
): AccountProfileSummary[] {
	return accounts.profiles
		.map((profile) => ({
			identity: profile.identity,
			...(profile.email ? { email: profile.email } : {}),
			active: profile.identity === accounts.activeIdentity,
			createdAt: profile.createdAt,
			lastUsedAt: profile.lastUsedAt,
		}))
		.sort(
			(a, b) =>
				b.lastUsedAt - a.lastUsedAt || a.identity.localeCompare(b.identity),
		);
}

function sameCredentialProfile(
	profile: AccountProfile,
	credentials: Credentials,
): boolean {
	return (
		profile.accessToken === credentials.accessToken &&
		profile.refreshToken === credentials.refreshToken &&
		profile.expiresAt === credentials.expiresAt &&
		profile.email === credentials.email
	);
}

export function ensureActiveProfile(
	accounts: Accounts,
	credentials: Credentials,
	now = Date.now(),
): boolean {
	const identity = credentials.accountIdentity;
	const accessToken = credentials.accessToken;
	if (!identity || !accessToken) return false;
	const existing = accounts.profiles.find(
		(profile) => profile.identity === identity,
	);
	const activeChanged = accounts.activeIdentity !== identity;
	if (existing && sameCredentialProfile(existing, credentials) && !activeChanged) {
		return false;
	}
	upsertAccountProfile(accounts, {
		identity,
		...(credentials.email ? { email: credentials.email } : {}),
		accessToken,
		...(credentials.refreshToken
			? { refreshToken: credentials.refreshToken }
			: {}),
		...(credentials.expiresAt !== undefined
			? { expiresAt: credentials.expiresAt }
			: {}),
		createdAt: existing?.createdAt ?? now,
		lastUsedAt: now,
	});
	accounts.activeIdentity = identity;
	return true;
}
