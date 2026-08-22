import type { AIHubClient } from "@aihub-auto/core";
import { AIHubApiError } from "@aihub-auto/core";
import {
	deriveAccountIdentity,
	legacyCredentialIdentity,
} from "./account-state.ts";
import { AccountSwitchBusyError } from "./account-errors.ts";
import type { AppState, Credentials, PendingPoolDelete } from "./config.ts";
import type { Logger } from "./logger.ts";

export const POOL_KEY_PREFIX = "aihub-auto-g";

const MAX_PENDING_DELETE_RETRIES_PER_PASS = 8;
const MAX_DELETE_ATTEMPTS = 31;
const DELETE_RETRY_BASE_MS = 5_000;
const DELETE_RETRY_MAX_MS = 60 * 60_000;

export type PoolDeleteErrorCode =
	| "network"
	| "timeout"
	| "rate_limited"
	| "unauthorized"
	| "upstream"
	| "unknown";

interface PoolEvictionResult {
	removed: number;
	changed: boolean;
}

function deleteErrorCode(error: unknown): PoolDeleteErrorCode {
	if (error instanceof AIHubApiError) {
		if (error.status === 401 || error.status === 403) return "unauthorized";
		if (error.status === 408 || error.status === 504) return "timeout";
		if (error.status === 429) return "rate_limited";
		if (error.status >= 500) return "upstream";
		if (error.status === 0)
			return /timeout/i.test(error.message) ? "timeout" : "network";
		return "upstream";
	}
	if (error instanceof DOMException && error.name === "TimeoutError")
		return "timeout";
	if (error instanceof TypeError) return "network";
	return "unknown";
}

function deleteIsIdempotentlyGone(error: unknown): boolean {
	if (!(error instanceof AIHubApiError)) return false;
	if (error.status === 404 || error.status === 410) return true;
	const code = (error.code ?? "")
		.toLowerCase()
		.replaceAll("-", "_")
		.replaceAll(" ", "_");
	return new Set([
		"404",
		"410",
		"not_found",
		"notfound",
		"key_not_found",
		"key_notfound",
	]).has(code);
}

function deleteRetryDelay(attempts: number): number {
	return Math.min(
		DELETE_RETRY_MAX_MS,
		DELETE_RETRY_BASE_MS * 2 ** Math.max(0, Math.min(attempts - 1, 17)),
	);
}

export interface ActiveKey {
	sk: string;
	groupId: number;
	/** 请求开始计入 TrafficTracker 后释放 Key 逐出保护。 */
	release?: () => void;
	/** pool 模式上游拒绝当前 sk 时,仅在记录仍匹配时将其作废。 */
	invalidateCredential?: () => Promise<boolean>;
	/** 本次候选在首字节前失败时恢复原会话绑定。 */
	rollback?: () => void;
	/** 已提交响应随后断流时,仅清除仍属于本请求版本的绑定。 */
	invalidate?: () => void;
	/** 当前请求是否仍拥有会话主绑定。 */
	isCurrentBinding?: () => boolean;
}

export interface ExecutorDeps {
	client: AIHubClient;
	state: AppState;
	credentials: Credentials;
	logger: Logger;
	keyMode: "single" | "pool";
	singleKeyId?: number;
	poolMaxGroups: number;
	evictionGraceMs?: number;
	/** 当前请求、预留与正在创建之外的硬保护组。 */
	hardProtectedGroupIds?: () => ReadonlySet<number>;
	/** 会话/Responses 亲和软保护;硬无效组可越过它回收。 */
	softProtectedGroupIds?: () => ReadonlySet<number>;
	/** 远端托管 Key 删除成功后的通知;仅强制回收需要清掉亲和。 */
	onPoolKeyRemoved?: (groupId: number, forced: boolean) => void;
	persistState: () => Promise<void>;
	persistCredentials: () => Promise<void>;
	/** 401 时由 daemon 注入的续期回调;成功返回 true */
	reauth: () => Promise<boolean>;
}

/** AIHub 账号上的 Key 执行层。pool 请求只确保目标组 Key,不改变全局路由。 */
export class RouteExecutor {
	private readonly creating = new Map<number, Promise<ActiveKey>>();
	private readonly reservations = new Map<number, number>();
	private poolMutation: Promise<unknown> = Promise.resolve();

	constructor(private readonly deps: ExecutorDeps) {}

	/** 控制面当前默认组对应的 Key。请求面应使用 ensureKey(groupId)。 */
	currentKey(): ActiveKey | undefined {
		const { state, credentials, keyMode } = this.deps;
		if (state.currentGroupId === undefined) return undefined;
		if (keyMode === "single") {
			if (!credentials.singleKeySk) return undefined;
			return { sk: credentials.singleKeySk, groupId: state.currentGroupId };
		}
		const entry = state.pool[String(state.currentGroupId)];
		if (!entry) return undefined;
		entry.lastUsedAt = Date.now();
		return { sk: entry.sk, groupId: state.currentGroupId };
	}

	private async withAuth<T>(
		fn: () => Promise<T>,
		expectedAccountIdentity?: string,
	): Promise<T> {
		try {
			return await fn();
		} catch (err) {
			if (err instanceof AIHubApiError && err.status === 401) {
				const ok = await this.deps.reauth();
				if (
					ok &&
					(!expectedAccountIdentity ||
						this.currentAccountIdentity() === expectedAccountIdentity)
				)
					return await fn();
			}
			throw err;
		}
	}

	private serializePool<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.poolMutation.then(fn, fn);
		this.poolMutation = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	hasAccountActivity(): boolean {
		return (
			this.creating.size > 0 ||
			this.reservations.size > 0 ||
			(this.deps.hardProtectedGroupIds?.().size ?? 0) > 0
		);
	}

	pendingPoolDeleteStats(now = Date.now()): {
		pending: number;
		due: number;
		currentAccountPending: number;
	} {
		const entries = Object.values(this.deps.state.pendingPoolDeletes);
		const identity = this.currentAccountIdentity();
		return {
			pending: entries.length,
			due: entries.filter((entry) => entry.nextRetryAt <= now).length,
			currentAccountPending: identity
				? entries.filter((entry) => entry.accountIdentity === identity).length
				: 0,
		};
	}

	retryPendingPoolDeletes(now = Date.now()): Promise<number> {
		return this.serializePool(async () => {
			const result = await this.retryPendingPoolDeletesLocked(now);
			if (result.changed) await this.deps.persistState();
			return result.removed;
		});
	}

	private currentAccountIdentity(): string | undefined {
		const token = this.deps.credentials.accessToken;
		if (!token) return undefined;
		return (
			legacyCredentialIdentity(this.deps.credentials) ??
			this.deps.state.accountIdentity ??
			deriveAccountIdentity({}, token)
		);
	}

	private pendingDeleteOwner(): string {
		const token = this.deps.credentials.accessToken;
		return (
			legacyCredentialIdentity(this.deps.credentials) ??
			this.deps.state.accountIdentity ??
			(token ? deriveAccountIdentity({}, token) : undefined) ??
			"unidentified-account"
		);
	}

	private queuePendingDelete(
		keyId: number,
		groupId: number,
		accountIdentity: string,
		error: unknown,
		now = Date.now(),
	): PendingPoolDelete {
		const key = String(keyId);
		const previous = this.deps.state.pendingPoolDeletes[key];
		const attempts = Math.min(
			MAX_DELETE_ATTEMPTS,
			(previous?.attempts ?? 0) + 1,
		);
		const entry: PendingPoolDelete = {
			keyId,
			groupId,
			accountIdentity,
			attempts,
			nextRetryAt: now + deleteRetryDelay(attempts),
			queuedAt: previous?.queuedAt ?? now,
			lastErrorCode: deleteErrorCode(error),
		};
		this.deps.state.pendingPoolDeletes[key] = entry;
		return entry;
	}

	private async deleteRemoteKey(
		keyId: number,
		expectedAccountIdentity = this.pendingDeleteOwner(),
	): Promise<void> {
		try {
			if (this.currentAccountIdentity() !== expectedAccountIdentity) {
				throw new AIHubApiError(
					"account identity changed before managed Key deletion",
					401,
					"account_identity_changed",
				);
			}
			await this.withAuth(
				() => this.deps.client.deleteKey(keyId),
				expectedAccountIdentity,
			);
		} catch (error) {
			if (deleteIsIdempotentlyGone(error)) return;
			throw error;
		}
	}

	private async retryPendingPoolDeletesLocked(
		now = Date.now(),
	): Promise<{ removed: number; changed: boolean }> {
		const identity = this.currentAccountIdentity();
		if (!identity) return { removed: 0, changed: false };
		const due = Object.values(this.deps.state.pendingPoolDeletes)
			.filter(
				(entry) =>
					entry.accountIdentity === identity && entry.nextRetryAt <= now,
			)
			.sort(
				(left, right) =>
					left.nextRetryAt - right.nextRetryAt ||
					left.queuedAt - right.queuedAt ||
					left.keyId - right.keyId,
			)
			.slice(0, MAX_PENDING_DELETE_RETRIES_PER_PASS);
		let removed = 0;
		let changed = false;
		for (const entry of due) {
			try {
				await this.deleteRemoteKey(entry.keyId, entry.accountIdentity);
				delete this.deps.state.pendingPoolDeletes[String(entry.keyId)];
				removed++;
				changed = true;
				this.deps.logger.info(
					`pool delete retry succeeded: group=${entry.groupId} keyId=${entry.keyId}`,
				);
			} catch (error) {
				const updated = this.queuePendingDelete(
					entry.keyId,
					entry.groupId,
					entry.accountIdentity,
					error,
					now,
				);
				changed = true;
				this.deps.logger.warn(
					`pool delete retry failed: group=${entry.groupId} keyId=${entry.keyId} category=${updated.lastErrorCode}`,
				);
			}
		}
		return { removed, changed };
	}

	clearManagedKeysForAccountSwitch(): Promise<{ orphanedKeyIds: number[] }> {
		return this.serializePool(async () => {
			if (this.hasAccountActivity()) throw new AccountSwitchBusyError();
			const orphanedKeyIds: number[] = [];
			const accountIdentity = this.pendingDeleteOwner();
			for (const [groupId, entry] of Object.entries(this.deps.state.pool)) {
				try {
				await this.deleteRemoteKey(entry.keyId, accountIdentity);
				} catch (error) {
					orphanedKeyIds.push(entry.keyId);
					const queued = this.queuePendingDelete(
						entry.keyId,
						Number(groupId),
						accountIdentity,
						error,
					);
					this.deps.logger.warn(
						`account switch cleanup failed: group=${groupId} keyId=${entry.keyId} category=${queued.lastErrorCode}`,
					);
				}
				delete this.deps.state.pool[groupId];
			}
			return { orphanedKeyIds };
		});
	}

	/** 请求面取得指定组 Key。single 模式因上游限制仍会全局切组。 */
	async ensureKey(groupId: number): Promise<ActiveKey> {
		if (this.deps.keyMode === "single") {
			const current = this.currentKey();
			return current?.groupId === groupId
				? current
				: this.switchSingle(groupId);
		}

		const existing = this.creating.get(groupId);
		if (existing) return existing;

		// 逐出期间不得读取即将删除的缓存 Key;acquireKey 的 reservation 已经
		// 先可见,逐出会在远端删除前重新检查它。
		await this.poolMutation.catch(() => undefined);
		const cached = this.deps.state.pool[String(groupId)];
		if (cached) {
			cached.lastUsedAt = Date.now();
			return { sk: cached.sk, groupId };
		}
		const afterWaitCreating = this.creating.get(groupId);
		if (afterWaitCreating) return afterWaitCreating;

		const pending = this.serializePool(async () => {
			const afterWait = this.deps.state.pool[String(groupId)];
			if (afterWait) {
				afterWait.lastUsedAt = Date.now();
				return { sk: afterWait.sk, groupId };
			}

			const created = await this.withAuth(() =>
				this.deps.client.createKey({
					name: `${POOL_KEY_PREFIX}${groupId}`,
					groupId,
				}),
			);
			if (!created.key)
				throw new Error("创建 Key 未返回 sk 明文,无法用于池模式");

			this.deps.state.pool[String(groupId)] = {
				keyId: created.id,
				sk: created.key,
				lastUsedAt: Date.now(),
			};
			this.deps.logger.info(`池新建 Key:group=${groupId} keyId=${created.id}`);
			await this.evictLru(groupId);
			await this.deps.persistState();
			return { sk: created.key, groupId };
		});
		this.creating.set(groupId, pending);
		const clear = () => {
			if (this.creating.get(groupId) === pending) this.creating.delete(groupId);
		};
		void pending.then(clear, clear);
		return pending;
	}

	/** 请求面租约:TrafficTracker 接管保护前,Lru 不得删除这把 Key。 */
	async acquireKey(groupId: number): Promise<ActiveKey> {
		this.reservations.set(groupId, (this.reservations.get(groupId) ?? 0) + 1);
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			const next = (this.reservations.get(groupId) ?? 1) - 1;
			if (next > 0) this.reservations.set(groupId, next);
			else this.reservations.delete(groupId);
		};
		try {
			const key = await this.ensureKey(groupId);
			return {
				...key,
				release,
				invalidateCredential:
					this.deps.keyMode === "pool"
						? () => this.invalidatePoolKey(groupId, key.sk)
						: undefined,
			};
		} catch (err) {
			release();
			throw err;
		}
	}

	/**
	 * 上游 401 说明请求用的 managed sk 已失效。expectedSk 是 CAS 保护,
	 * 防止旧请求删掉另一并发请求刚创建的新 Key。
	 */
	async invalidatePoolKey(
		groupId: number,
		expectedSk: string,
	): Promise<boolean> {
		if (this.deps.keyMode !== "pool") return false;
		return this.serializePool(async () => {
			const entry = this.deps.state.pool[String(groupId)];
			if (!entry || entry.sk !== expectedSk) return false;
			delete this.deps.state.pool[String(groupId)];
			this.deps.logger.warn(
				`池 Key 被上游拒绝,本地作废并重建:group=${groupId} keyId=${entry.keyId}`,
			);
			await this.deps.persistState();
			return true;
		});
	}

	/** 控制面切换默认组。pool 中只更新默认值,不会改动其他会话绑定。 */
	async switchTo(groupId: number): Promise<ActiveKey> {
		if (this.deps.keyMode === "single") return this.switchSingle(groupId);
		const key = await this.ensureKey(groupId);
		this.deps.state.currentGroupId = groupId;
		await this.deps.persistState();
		return key;
	}

	private async switchSingle(groupId: number): Promise<ActiveKey> {
		const { state, credentials, logger } = this.deps;
		let keyId = this.deps.singleKeyId;
		if (keyId === undefined || !credentials.singleKeySk) {
			const keys = await this.withAuth(() => this.deps.client.listAllKeys());
			const chosen =
				(keyId !== undefined
					? keys.find((key) => key.id === keyId)
					: undefined) ?? keys.find((key) => key.status !== "inactive");
			if (!chosen)
				throw new Error("账号下没有可用 API Key;请先在 AIHub 创建一个 Key");
			keyId = chosen.id;
			if (chosen.key) {
				credentials.singleKeySk = chosen.key;
				await this.deps.persistCredentials();
			} else if (!credentials.singleKeySk) {
				throw new Error(
					`Key 列表不返回 sk 明文;请在控制台把 Key(id=${keyId})的 sk 粘贴进配置(singleKeySk)`,
				);
			}
		}
		try {
			await this.withAuth(() =>
				this.deps.client.updateKeyGroup(keyId!, groupId),
			);
		} catch (err) {
			logger.warn(
				`切组 PUT 失败,重试一次: ${err instanceof Error ? err.message : String(err)}`,
			);
			await this.withAuth(() =>
				this.deps.client.updateKeyGroup(keyId!, groupId),
			);
		}
		state.currentGroupId = groupId;
		await this.deps.persistState();
		logger.info(`已切换(single):key=${keyId} -> group=${groupId}`);
		return { sk: credentials.singleKeySk!, groupId };
	}

	/** 定期收缩池;强无效组可越过会话软保护,删除成功后立即持久化。 */
	async trimPool(
		forceReclaimGroupIds: ReadonlySet<number> = new Set(),
	): Promise<number> {
		if (this.deps.keyMode !== "pool") return 0;
		return this.serializePool(async () => {
			const retried = await this.retryPendingPoolDeletesLocked();
			const evicted = await this.evictLru(undefined, forceReclaimGroupIds);
			if (retried.changed || evicted.changed) await this.deps.persistState();
			return evicted.removed;
		});
	}

	/** 超容量立即按 LRU 收缩无保护 Key;强无效组过宽限期后可越过软保护。 */
	private async evictLru(
		protectGroupId?: number,
		forceReclaimGroupIds: ReadonlySet<number> = new Set(),
	): Promise<PoolEvictionResult> {
		const { state, logger } = this.deps;
		const isHardProtected = (groupId: number): boolean =>
			(protectGroupId !== undefined && groupId === protectGroupId) ||
			groupId === state.currentGroupId ||
			this.creating.has(groupId) ||
			this.reservations.has(groupId) ||
			(this.deps.hardProtectedGroupIds?.().has(groupId) ?? false);
		const isSoftProtected = (groupId: number): boolean =>
			this.deps.softProtectedGroupIds?.().has(groupId) ?? false;
		const grace = this.deps.evictionGraceMs ?? 0;
		const now = Date.now();
		let removed = 0;
		let changed = false;
		const accountIdentity = this.pendingDeleteOwner();
		const overCapacity =
			Object.keys(state.pool).length > this.deps.poolMaxGroups;
		const victims = Object.entries(state.pool)
			.filter(([groupId, entry]) => {
				const id = Number(groupId);
				const forced = forceReclaimGroupIds.has(id);
				return (
					!isHardProtected(id) &&
					((forced && now - entry.lastUsedAt >= grace) ||
						(overCapacity && !isSoftProtected(id)))
				);
			})
			.sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt);

		while (victims.length > 0) {
			const [groupId, entry] = victims.shift()!;
			const id = Number(groupId);
			const forced = forceReclaimGroupIds.has(id);
			if (!forced && Object.keys(state.pool).length <= this.deps.poolMaxGroups)
				break;
			// 快照之后可能出现创建/预留/在飞请求;删除前必须重新确认。
			if (isHardProtected(id) || (!forced && isSoftProtected(id))) continue;
			try {
				await this.deleteRemoteKey(entry.keyId, accountIdentity);
				delete state.pool[groupId];
				this.deps.onPoolKeyRemoved?.(id, forced);
				removed++;
				changed = true;
				logger.info(
					`${forced ? "池强制回收" : "池 LRU 删除"}:group=${groupId} keyId=${entry.keyId}`,
				);
			} catch (error) {
				delete state.pool[groupId];
				this.deps.onPoolKeyRemoved?.(id, forced);
				const queued = this.queuePendingDelete(
					entry.keyId,
					id,
					accountIdentity,
					error,
					now,
				);
				removed++;
				changed = true;
				logger.warn(
					`pool delete queued: group=${groupId} keyId=${entry.keyId} category=${queued.lastErrorCode}`,
				);
			}
		}
		return { removed, changed };
	}

	/**
	 * 启动对账只清理本 state 的失效引用。未知远端前缀 Key 可能属于
	 * 同账号的另一个运行实例,绝不能作为“孤儿”自动删除。
	 */
	async reconcile(): Promise<void> {
		if (this.deps.keyMode !== "pool") return;
		await this.serializePool(async () => {
			const { state, logger } = this.deps;
			const retried = await this.retryPendingPoolDeletesLocked();
			let changed = retried.changed;
			try {
				const keys = await this.withAuth(() => this.deps.client.listAllKeys());
				const remoteIds = new Set(keys.map((key) => key.id));
				const accountIdentity = this.currentAccountIdentity();

				for (const [groupId, entry] of Object.entries(state.pool)) {
					if (!remoteIds.has(entry.keyId)) {
						delete state.pool[groupId];
						changed = true;
						logger.warn(`池记录失效(远端已删):group=${groupId}`);
					}
				}
				if (accountIdentity) {
					for (const [keyId, entry] of Object.entries(
						state.pendingPoolDeletes,
					)) {
						if (
							entry.accountIdentity === accountIdentity &&
							!remoteIds.has(entry.keyId)
						) {
							delete state.pendingPoolDeletes[keyId];
							changed = true;
							logger.info(
								`pending pool delete already absent: group=${entry.groupId} keyId=${entry.keyId}`,
							);
						}
					}
				}
			} catch (error) {
				logger.warn(
					`启动对账列表失败，将继续重试待清理 Key:${
						error instanceof Error ? error.name : "unknown"
					}`,
				);
			}
			const evicted = await this.evictLru();
			changed ||= evicted.changed;
			if (changed) await this.deps.persistState();
		});
	}

	/** 退出清理(可选):删除全部自建 Key。 */
	async cleanup(): Promise<void> {
		await this.serializePool(async () => {
			const { state, logger } = this.deps;
			const accountIdentity = this.pendingDeleteOwner();
			await this.retryPendingPoolDeletesLocked();
			for (const [groupId, entry] of Object.entries(state.pool)) {
				try {
					await this.deleteRemoteKey(entry.keyId, accountIdentity);
				} catch (error) {
					const queued = this.queuePendingDelete(
						entry.keyId,
						Number(groupId),
						accountIdentity,
						error,
					);
					logger.warn(
						`exit cleanup queued: group=${groupId} keyId=${entry.keyId} category=${queued.lastErrorCode}`,
					);
				}
				delete state.pool[groupId];
			}
			await this.deps.persistState();
		});
	}
}
