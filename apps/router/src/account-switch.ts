import type { AIHubClient, AuthSession } from "@aihub-auto/core";
import {
	deriveAccountIdentity,
	legacyCredentialIdentity,
	profileEmail,
	resetAccountScopedState,
} from "./account-state.ts";
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

export interface AccountSwitchDeps {
	client: AIHubClient;
	createClient: (accessToken: string) => AIHubClient;
	state: AppState;
	credentials: Credentials;
	executor: RouteExecutor;
	daemon: RouteDaemon;
	logger: Logger;
	persistState: () => Promise<void>;
	persistCredentials: () => Promise<void>;
	syncSentryUser: (email?: string) => void;
}

export class AccountSwitchService {
	private mutation: Promise<unknown> = Promise.resolve();

	constructor(private readonly deps: AccountSwitchDeps) {}

	login(input: AccountLoginInput): Promise<AccountSwitchResult> {
		const run = this.mutation.then(
			() => this.loginLocked(input),
			() => this.loginLocked(input),
		);
		this.mutation = run.then(
			() => undefined,
			() => undefined,
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

		const previousCredentials = { ...this.deps.credentials };
		const previousState = structuredClone(this.deps.state);
		let managedKeysCleared = false;
		try {
			if (switched) {
				await this.deps.daemon.runAccountSwitchMutation(async () => {
					await this.deps.executor.clearManagedKeysForAccountSwitch();
					managedKeysCleared = true;
					resetAccountScopedState(
						this.deps.state,
						this.deps.credentials,
						identity,
					);
					this.applySession(session, identity, email);
					this.deps.daemon.resetAccountCaches();
					await this.deps.persistState();
					await this.deps.persistCredentials();
				});
			} else {
				this.applySession(session, identity, email);
				this.deps.state.accountIdentity ??= identity;
				await this.deps.persistCredentials();
				await this.deps.persistState();
				this.deps.daemon.resetAccountCaches();
			}
		} catch (error) {
			this.restore(this.deps.credentials, previousCredentials);
			this.restore(this.deps.state, previousState);
			if (managedKeysCleared) {
				// Some old managed keys may already be gone remotely. Recreate them
				// lazily instead of restoring stale local sk values.
				this.deps.state.pool = {};
			}
			this.deps.daemon.resetAccountCaches();
			throw error;
		}

		this.deps.daemon.needsReauth = false;
		this.deps.syncSentryUser(email);
		await this.deps.daemon.runOnce().catch((error) =>
			this.deps.logger.warn(
				`账号已保存，立即刷新失败，将由守护轮重试:${error instanceof Error ? error.message : String(error)}`,
			),
		);
		return { ok: true, switched, ...(email ? { email } : {}) };
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
}
