import { createHash } from "node:crypto";
import type { AppState, Credentials } from "./config.ts";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function profileEmail(
	profile: Record<string, unknown>,
	fallback = "",
): string | undefined {
	for (const value of [profile["email"], fallback]) {
		if (typeof value !== "string") continue;
		const normalized = value.trim().toLowerCase();
		if (EMAIL.test(normalized)) return normalized;
	}
	return undefined;
}

export function deriveAccountIdentity(
	profile: Record<string, unknown>,
	accessToken: string,
): string {
	const id = profile["id"];
	if (
		(typeof id === "string" && id.trim()) ||
		(typeof id === "number" && Number.isSafeInteger(id))
	) {
		return `id:${String(id).trim()}`;
	}
	const email = profileEmail(profile);
	if (email) return `email:${email}`;
	return `token:${createHash("sha256").update(accessToken).digest("hex")}`;
}

export function legacyCredentialIdentity(
	credentials: Credentials,
): string | undefined {
	return (
		credentials.accountIdentity ??
		(credentials.email
			? `email:${credentials.email.trim().toLowerCase()}`
			: undefined)
	);
}

export function resetAccountScopedState(
	state: AppState,
	credentials: Credentials,
	nextIdentity: string,
): void {
	delete state.currentGroupId;
	delete state.lastSwitchAt;
	delete state.pendingSwitch;
	state.manualLock = {
		groupId: null,
		revision: state.manualLock.revision + 1,
	};
	state.pool = {};
	state.sessions = {};
	state.responseAliases = {};
	state.modelBlocks = {};
	state.accountIdentity = nextIdentity;
	delete credentials.singleKeySk;
}

function ownerMatches(
	owner: string | undefined,
	identity: string,
	email: string | undefined,
): boolean {
	return !owner || owner === identity || Boolean(email && owner === `email:${email}`);
}

export function alignAccountStateOwner(
	state: AppState,
	credentials: Credentials,
	profile: Record<string, unknown>,
): { identity: string; reset: boolean } {
	const accessToken = credentials.accessToken ?? "";
	const identity = deriveAccountIdentity(profile, accessToken);
	const email = profileEmail(profile, credentials.email);
	const credentialOwner = legacyCredentialIdentity(credentials);
	const mismatch =
		!ownerMatches(credentialOwner, identity, email) ||
		!ownerMatches(state.accountIdentity, identity, email);

	if (mismatch) resetAccountScopedState(state, credentials, identity);
	state.accountIdentity = identity;
	credentials.accountIdentity = identity;
	credentials.email = email;
	return { identity, reset: mismatch };
}
