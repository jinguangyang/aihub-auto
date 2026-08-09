import type { AIHubClient } from "@aihub-auto/core";
import { AIHubApiError } from "@aihub-auto/core";
import { AccountSwitchBusyError } from "./account-errors.ts";
import type { AppState, Credentials } from "./config.ts";
import type { Logger } from "./logger.ts";

export const POOL_KEY_PREFIX = "aihub-auto-g";

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

	private async withAuth<T>(fn: () => Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch (err) {
			if (err instanceof AIHubApiError && err.status === 401) {
				const ok = await this.deps.reauth();
				if (ok) return await fn();
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

	clearManagedKeysForAccountSwitch(): Promise<{ orphanedKeyIds: number[] }> {
		return this.serializePool(async () => {
			if (this.hasAccountActivity()) throw new AccountSwitchBusyError();
			const orphanedKeyIds: number[] = [];
			for (const [groupId, entry] of Object.entries(this.deps.state.pool)) {
				try {
					await this.deps.client.deleteKey(entry.keyId);
				} catch (error) {
					orphanedKeyIds.push(entry.keyId);
					this.deps.logger.warn(
						`账号切换清理失败，已丢弃本地池记录:keyId=${entry.keyId} ${error instanceof Error ? error.message : ""}`,
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
			const removed = await this.evictLru(undefined, forceReclaimGroupIds);
			if (removed > 0) await this.deps.persistState();
			return removed;
		});
	}

	/** 超容量立即按 LRU 收缩无保护 Key;强无效组过宽限期后可越过软保护。 */
	private async evictLru(
		protectGroupId?: number,
		forceReclaimGroupIds: ReadonlySet<number> = new Set(),
	): Promise<number> {
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
				await this.withAuth(() => this.deps.client.deleteKey(entry.keyId));
				delete state.pool[groupId];
				this.deps.onPoolKeyRemoved?.(id, forced);
				removed++;
				logger.info(
					`${forced ? "池强制回收" : "池 LRU 删除"}:group=${groupId} keyId=${entry.keyId}`,
				);
			} catch (err) {
				logger.warn(
					`池删除失败(保留记录,下轮重试):keyId=${entry.keyId} ${err instanceof Error ? err.message : ""}`,
				);
				break;
			}
		}
		return removed;
	}

	/**
	 * 启动对账只清理本 state 的失效引用。未知远端前缀 Key 可能属于
	 * 同账号的另一个运行实例,绝不能作为“孤儿”自动删除。
	 */
	async reconcile(): Promise<void> {
		if (this.deps.keyMode !== "pool") return;
		await this.serializePool(async () => {
			const { state, logger } = this.deps;
			const keys = await this.withAuth(() => this.deps.client.listAllKeys());
			const remoteIds = new Set(keys.map((key) => key.id));

			for (const [groupId, entry] of Object.entries(state.pool)) {
				if (!remoteIds.has(entry.keyId)) {
					delete state.pool[groupId];
					logger.warn(`池记录失效(远端已删):group=${groupId}`);
				}
			}
			await this.evictLru();
			await this.deps.persistState();
		});
	}

	/** 退出清理(可选):删除全部自建 Key。 */
	async cleanup(): Promise<void> {
		await this.serializePool(async () => {
			const { state, logger } = this.deps;
			for (const [groupId, entry] of Object.entries(state.pool)) {
				try {
					await this.withAuth(() => this.deps.client.deleteKey(entry.keyId));
					delete state.pool[groupId];
				} catch (err) {
					logger.warn(
						`退出清理失败:keyId=${entry.keyId} ${err instanceof Error ? err.message : ""}`,
					);
				}
			}
			await this.deps.persistState();
		});
	}
}
