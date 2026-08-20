import {
	AIHubClient,
	CircuitBreaker,
	LocalObservationStore,
} from "@aihub-auto/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountSwitchService } from "../src/account-switch.ts";
import {
	AccountsSchema,
	ensureActiveProfile,
	type Accounts,
} from "../src/accounts.ts";
import {
	ConfigSchema,
	FileStore,
	StateSchema,
	type AppConfig,
	type AppState,
	type Credentials,
} from "../src/config.ts";
import { RouteDaemon } from "../src/daemon.ts";
import { RouteExecutor } from "../src/executor.ts";
import { AuditLog, Logger } from "../src/logger.ts";
import type { ProxyDeps } from "../src/proxy.ts";
import { createServer, type ServerDeps } from "../src/server.ts";
import { SessionAffinity } from "../src/session.ts";
import { SingleKeyGate, TrafficTracker } from "../src/traffic.ts";
import { MockAIHub } from "./mock-upstream.ts";

export interface Harness {
	mock: MockAIHub;
	config: AppConfig;
	state: AppState;
	credentials: Credentials;
	accounts: Accounts;
	client: AIHubClient;
	executor: RouteExecutor;
	daemon: RouteDaemon;
	accountSwitcher: AccountSwitchService;
	breaker: CircuitBreaker;
	observations: LocalObservationStore;
	affinity: SessionAffinity;
	traffic: TrafficTracker;
	proxyDeps: ProxyDeps;
	logger: Logger;
	persistState: () => Promise<void>;
	persistCredentials: () => Promise<void>;
	persistAccounts: () => Promise<void>;
	restartState: { pending: boolean };
	restartRequested: { value: boolean };
	server?: ReturnType<typeof createServer>;
	serverUrl?: string;
	configDir: string;
	dispose: () => void;
}

export function createHarness(opts?: {
	configPatch?: Partial<AppConfig>;
	withServer?: boolean;
	loggedIn?: boolean;
	probeOutboundProxy?: ServerDeps["probeOutboundProxy"];
}): Harness {
	const mock = new MockAIHub();
	const dir = mkdtempSync(join(tmpdir(), "aihub-auto-test-"));
	const store = new FileStore(dir);

	const config = ConfigSchema.parse({
		baseUrl: mock.url,
		pollIntervalMs: 60_000,
		...opts?.configPatch,
	});
	const loggedIn = opts?.loggedIn !== false;
	const state = StateSchema.parse(
		loggedIn ? { accountIdentity: "id:account-1" } : {},
	);
	const credentials: Credentials =
		!loggedIn
			? {}
			: {
					accessToken: "mock-at",
					refreshToken: "mock-rt",
					accountIdentity: "id:account-1",
				};
	const accounts = AccountsSchema.parse(
		loggedIn
			? {
					activeIdentity: "id:account-1",
					profiles: [
						{
							identity: "id:account-1",
							email: "mock@test.local",
							accessToken: "mock-at",
							refreshToken: "mock-rt",
							createdAt: 1,
							lastUsedAt: 1,
						},
					],
				}
			: {},
	);

	const logger = new Logger("error", () => {});
	const audit = new AuditLog(undefined);
	const client = new AIHubClient({
		baseUrl: mock.url,
		token: () => credentials.accessToken,
	});
	const breaker = new CircuitBreaker();
	const observations = new LocalObservationStore();
	const traffic = new TrafficTracker();
	const singleKeyGate = new SingleKeyGate();
	const affinity = new SessionAffinity(
		state,
		config.sessionTtlMs,
		config.sessionMaxEntries,
	);

	const persistState = async () => store.write("state.json", state);
	const persistCredentials = async () =>
		store.write("credentials.json", credentials);
	const persistAccounts = async () => store.write("accounts.json", accounts);
	const restartState = { pending: false };
	const restartRequested = { value: false };
	const persistConfig = async () => store.write("config.json", config);

	const executor = new RouteExecutor({
		client,
		state,
		credentials,
		logger,
		keyMode: config.keyMode,
		singleKeyId: config.singleKeyId,
		poolMaxGroups: config.poolMaxGroups,
		evictionGraceMs: config.decision.cacheIdleMs,
		hardProtectedGroupIds: () => traffic.activeGroupIds(),
		softProtectedGroupIds: () => {
			const groups = affinity.protectedGroupIds(config.decision.cacheIdleMs);
			if (state.manualLock.groupId !== null) {
				groups.add(state.manualLock.groupId);
			}
			return groups;
		},
		onPoolKeyRemoved: (groupId, forced) => {
			if (forced) affinity.forgetGroup(groupId);
		},
		persistState,
		persistCredentials,
		reauth: async () => {
			if (!credentials.refreshToken) return false;
			try {
				const s = await client.refreshSession(credentials.refreshToken);
				credentials.accessToken = s.accessToken;
				credentials.refreshToken = s.refreshToken;
				credentials.expiresAt = s.expiresAt;
				await persistCredentials();
				if (ensureActiveProfile(accounts, credentials)) {
					await persistAccounts();
				}
				return true;
			} catch {
				return false;
			}
		},
	});

	const daemon = new RouteDaemon({
		config,
		state,
		credentials,
		client,
		executor,
		breaker,
		observations,
		affinity,
		traffic,
		singleKeyGate,
		logger,
		audit,
		persistState,
		persistStateSoon: () => {},
		persistCredentials,
	});
	const accountSwitcher = new AccountSwitchService({
		client,
		createClient: (accessToken) =>
			new AIHubClient({ baseUrl: mock.url, token: () => accessToken }),
		state,
		credentials,
		executor,
		daemon,
		logger,
		accounts,
		persistState,
		persistCredentials,
		persistAccounts,
		syncSentryUser: () => {},
	});

	const proxyDeps: ProxyDeps = {
		baseUrl: mock.url,
		keyMode: config.keyMode,
		route: (request) => daemon.route(request),
		reportFailure: (groupId) => daemon.reportFailure(groupId),
		reportSuccess: (groupId) => daemon.reportSuccess(groupId),
		reportNeutral: (groupId) => daemon.reportNeutral(groupId),
		reportModelIncompatible: (groupId, model) =>
			daemon.reportModelIncompatible(groupId, model),
		reportModelSupported: (groupId, model) =>
			daemon.reportModelSupported(groupId, model),
		affinity,
		observations,
		traffic,
		singleKeyGate,
		logger,
		ttfbTimeoutMs: config.ttfbTimeoutMs,
		proxyToken: config.proxyToken,
		upstreamUserAgent: () => config.upstreamUserAgent,
	};

	let server: ReturnType<typeof createServer> | undefined;
	let serverUrl: string | undefined;
	if (opts?.withServer) {
		const serverDeps: ServerDeps = {
			config,
			state,
			credentials,
			client,
			accountSwitcher,
			daemon,
			executor,
			proxyDeps,
			store,
			logger,
			persistConfig,
			persistState,
			persistCredentials,
			accounts,
			persistAccounts,
			requestRestart: () => {
				restartRequested.value = true;
			},
			restartState,
			sentryDsn: config.sentryDsn,
			desktopMode: false,
			syncSentryUser: () => {},
			probeOutboundProxy:
				opts?.probeOutboundProxy ?? (async () => ({ latencyMs: 1 })),
		};
		config.listen.port = 0;
		server = createServer(serverDeps);
		serverUrl = `http://127.0.0.1:${server.port}`;
	}

	return {
		mock,
		config,
		state,
		credentials,
		accounts,
		client,
		executor,
		daemon,
		accountSwitcher,
		breaker,
		observations,
		affinity,
		traffic,
		proxyDeps,
		logger,
		persistState,
		persistCredentials,
		persistAccounts,
		restartState,
		restartRequested,
		server,
		serverUrl,
		configDir: dir,
		dispose: () => {
			daemon.stop();
			server?.stop(true);
			mock.stop();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
