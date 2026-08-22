import type { AIHubClient, AuthSession } from "@aihub-auto/core";
import {
	deriveAccountIdentity,
	legacyCredentialIdentity,
	profileEmail,
	resetAccountScopedState,
} from "./account-state.ts";
import {
	redactedAccountProfiles,
	removeAccountProfile,
	upsertAccountProfile,
	type AccountProfileSummary,
	type Accounts,
} from "./accounts.ts";
import type { AppState, Credentials } from "./config.ts";
import type { RouteDaemon } from "./daemon.ts";
import type { RouteExecutor } from "./executor.ts";
import type { Logger } from "./logger.ts";

export type AccountLoginInput =
	| { token: string }
	| { email: string; password: string };

export interface AccountSwitchResult {
	ok: true;
	switched: boolean;
	email?: string;
}

export interface AccountLogoutResult {
	ok: true;
	clearedKeys: number;
	orphanedKeyIds: number[];
}

export interface AccountSwitchDeps {
	client: AIHubClient;
	createClient: (accessToken: string) => AIHubClient;
	state: AppState;
	credentials: Credentials;
	accounts: Accounts;
	executor: RouteExecutor;
	daemon: RouteDaemon;
	logger: Logger;
	persistState: () => Promise<void>;
	persistCredentials: () => Promise<void>;
	persistAccounts: () => Promise<void>;
	syncSentryUser: (email?: string) => void;
}

export class AccountSwitchService {
	private mutation: Promise<unknown> = Promise.resolve();
	private mutationCount = 0;

	constructor(private readonly deps: AccountSwitchDeps) {}

	listProfiles(): AccountProfileSummary[] {
		return redactedAccountProfiles(this.deps.accounts);
	}

	login(input: AccountLoginInput): Promise<AccountSwitchResult> {
		return this.enqueue(() => this.loginLocked(input));
	}

	logout(): Promise<AccountLogoutResult> {
		return this.enqueue(() => this.logoutLocked());
	}

	switchTo(identity: string): Promise<AccountSwitchResult> {
		return this.enqueue(() => this.switchToLocked(identity));
	}

	remove(identity: string): Promise<{ ok: true; removed: boolean }> {
		return this.enqueue(() => this.removeLocked(identity));
	}

	isMutating(): boolean {
		return this.mutationCount > 0;
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		this.mutationCount++;
		const run = this.mutation.then(fn, fn);
		this.mutation = run.then(
			() => {
				this.mutationCount--;
			},
			() => {
				this.mutationCount--;
			},
		);
		return run;
	}

	private async candidate(input: AccountLoginInput): Promise<AuthSession> {
		if ("token" in input) {
			const accessToken = input.token.trim();
			if (!accessToken) throw new Error("Access Token 不能为空");
			return { accessToken };
		}
		if (!input.email.trim() || !input.password) {
			throw new Error("需要 email+password 或 token");
		}
		return this.deps.client.login(input.email, input.password);
	}

	private async loginLocked(
		input: AccountLoginInput,
	): Promise<AccountSwitchResult> {
		const session = await this.candidate(input);
		const profile = await this.deps.createClient(session.accessToken).me();
		const identity = deriveAccountIdentity(profile, session.accessToken);
		const email = profileEmail(
			profile,
			"email" in input ? input.email : "",
		);
		const previousIdentity = legacyCredentialIdentity(this.deps.credentials);
		const switched = Boolean(
			this.deps.credentials.accessToken && previousIdentity !== identity,
		);
		await this.activateSession(session, identity, email, switched);
		return { ok: true, switched, ...(email ? { email } : {}) };
	}

	private async switchToLocked(identity: string): Promise<AccountSwitchResult> {
		const normalized = identity.trim();
		const saved = this.deps.accounts.profiles.find(
			(profile) => profile.identity === normalized,
		);
		if (!saved) throw new Error("保存的 AIHub 账号不存在");
		const session: AuthSession = {
			accessToken: saved.accessToken,
			...(saved.refreshToken ? { refreshToken: saved.refreshToken } : {}),
			...(saved.expiresAt !== undefined ? { expiresAt: saved.expiresAt } : {}),
		};
		const profile = await this.deps.createClient(session.accessToken).me();
		const verifiedIdentity = deriveAccountIdentity(profile, session.accessToken);
		if (verifiedIdentity !== saved.identity) {
			throw new Error("保存的 AIHub 账号凭据与账号身份不匹配");
		}
		const email = profileEmail(profile, saved.email ?? "");
		const previousIdentity = legacyCredentialIdentity(this.deps.credentials);
		const switched = Boolean(
			this.deps.credentials.accessToken && previousIdentity !== verifiedIdentity,
		);
		await this.activateSession(session, verifiedIdentity, email, switched);
		return {
			ok: true,
			switched,
			...(email ? { email } : {}),
		};
	}

	private async removeLocked(
		identity: string,
	): Promise<{ ok: true; removed: boolean }> {
		const normalized = identity.trim();
		const profile = this.deps.accounts.profiles.find(
			(item) => item.identity === normalized,
		);
		if (!profile) return { ok: true, removed: false };
		const activeIdentity =
			this.deps.accounts.activeIdentity ??
			legacyCredentialIdentity(this.deps.credentials) ??
			this.deps.state.accountIdentity;
		if (activeIdentity === normalized) {
			await this.logoutLocked();
		}
		const removed = removeAccountProfile(this.deps.accounts, normalized);
		if (removed) await this.deps.persistAccounts();
		return { ok: true, removed };
	}

	private async activateSession(
		session: AuthSession,
		identity: string,
		email: string | undefined,
		switched: boolean,
	): Promise<void> {
		const previousCredentials = { ...this.deps.credentials };
		const previousState = structuredClone(this.deps.state);
		const previousAccounts = structuredClone(this.deps.accounts);
		const wasLoggedIn = Boolean(previousCredentials.accessToken);
		let managedKeysCleared = false;
		try {
			const commit = async () => {
				if (switched) {
					await this.deps.executor.clearManagedKeysForAccountSwitch();
					managedKeysCleared = true;
					resetAccountScopedState(
						this.deps.state,
						this.deps.credentials,
						identity,
					);
				} else {
					this.deps.state.accountIdentity ??= identity;
				}
				this.applySession(session, identity, email);
				const now = Date.now();
				upsertAccountProfile(this.deps.accounts, {
					identity,
					...(email ? { email } : {}),
					accessToken: session.accessToken,
					...(session.refreshToken
						? { refreshToken: session.refreshToken }
						: {}),
					...(session.expiresAt !== undefined
						? { expiresAt: session.expiresAt }
						: {}),
					createdAt: now,
					lastUsedAt: now,
				});
				this.deps.accounts.activeIdentity = identity;
				this.deps.daemon.resetAccountCaches();
				await this.deps.persistState();
				await this.deps.persistCredentials();
				await this.deps.persistAccounts();
			};
			if (switched) await this.deps.daemon.runAccountSwitchMutation(commit);
			else await commit();
		} catch (error) {
			const pendingPoolDeletes = managedKeysCleared
				? structuredClone(this.deps.state.pendingPoolDeletes)
				: undefined;
			this.restore(this.deps.credentials, previousCredentials);
			this.restore(this.deps.state, previousState);
			this.restore(this.deps.accounts, previousAccounts);
			if (managedKeysCleared) {
				this.deps.state.pool = {};
				this.deps.state.pendingPoolDeletes = pendingPoolDeletes!;
				await this.deps.persistState().catch(() => undefined);
			}
			this.deps.daemon.resetAccountCaches();
			throw error;
		}

		this.deps.daemon.needsReauth = false;
		if (!wasLoggedIn) this.deps.daemon.start();
		this.deps.syncSentryUser(email);
		await this.deps.daemon.runOnce().catch((error) =>
			this.deps.logger.warn(
				`账号已保存，立即刷新失败，将由守护轮询重试:${error instanceof Error ? error.message : String(error)}`,
			),
		);
	}

	private applySession(
		session: AuthSession,
		identity: string,
		email?: string,
	): void {
		const credentials = this.deps.credentials;
		credentials.accessToken = session.accessToken;
		credentials.accountIdentity = identity;
		if (email) credentials.email = email;
		else delete credentials.email;
		if (session.refreshToken) credentials.refreshToken = session.refreshToken;
		else delete credentials.refreshToken;
		if (session.expiresAt !== undefined) credentials.expiresAt = session.expiresAt;
		else delete credentials.expiresAt;
	}

	private restore<T extends object>(target: T, snapshot: T): void {
		for (const key of Object.keys(target)) {
			delete (target as Record<string, unknown>)[key];
		}
		Object.assign(target, snapshot);
	}

	private async logoutLocked(): Promise<AccountLogoutResult> {
		const poolSize = Object.keys(this.deps.state.pool).length;
		let orphanedKeyIds: number[] = [];
		await this.deps.daemon.runAccountSwitchMutation(async () => {
			const result =
				await this.deps.executor.clearManagedKeysForAccountSwitch();
			orphanedKeyIds = result.orphanedKeyIds;
			this.deps.state.pool = {};
			resetAccountScopedState(
				this.deps.state,
				this.deps.credentials,
				"",
			);
			delete this.deps.state.accountIdentity;
			delete this.deps.accounts.activeIdentity;
			this.deps.credentials.accessToken = undefined;
			this.deps.credentials.refreshToken = undefined;
			this.deps.credentials.expiresAt = undefined;
			this.deps.credentials.singleKeySk = undefined;
			this.deps.credentials.accountIdentity = undefined;
			this.deps.credentials.email = undefined;
			this.deps.daemon.needsReauth = false;
			this.deps.daemon.resetAccountCaches();
			this.deps.daemon.stop();
			await this.deps.persistState();
			await this.deps.persistCredentials();
			await this.deps.persistAccounts();
		});
		this.deps.syncSentryUser(undefined);
		return { ok: true, clearedKeys: poolSize, orphanedKeyIds };
	}
}
