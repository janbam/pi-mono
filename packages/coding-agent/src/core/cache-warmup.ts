import type { AgentSession, PromptCacheSystemPromptSnapshot, PromptCacheWarmResult } from "./agent-session.ts";
import type { CustomEntry, SessionEntry } from "./session-manager.ts";

/** Reserved custom-entry type for invisible prompt-cache maintenance records. */
export const CACHE_WARM_MARKER_TYPE = "pi.cache-warm";

/** Persisted cache-maintenance result for the active session-tree branch. */
export interface CacheWarmMarker {
	version: 1;
	api: "anthropic-messages";
	provider: string;
	model: string;
	cacheIdentity: string;
	/** Replayable effective-prompt delta, kept private with the maintenance marker. */
	systemPrompt: PromptCacheSystemPromptSnapshot;
	/** Whether this request reported cache activity and therefore proved a renewable lease. */
	cacheActive: boolean;
	retention: PromptCacheWarmResult["retention"];
	warmedAt: number;
	expiresAt: number;
	warmSince: number;
	refreshCount: number;
	totalCost: number;
}

/** Successful foreground cache proof bound to the prompt identity and session-tree leaf that produced it. */
export interface ForegroundCacheRefresh {
	provider: string;
	model: string;
	cacheIdentity: string;
	leafId: string | null;
	generation: number;
	warmedAt: number;
}

/** Current scheduler state rendered by interactive mode. */
export interface CacheWarmState {
	enabled: boolean;
	eligible: boolean;
	/** Whether maintenance is in a user-visible idle or pause-drain window. */
	idle: boolean;
	warming: boolean;
	active: boolean;
	/** Whether a previously proven lease expired and now requires foreground traffic to recreate the cache. */
	cold: boolean;
	cacheUnavailable: boolean;
	retrying: boolean;
	warmSince?: number;
	expiresAt?: number;
	refreshCount: number;
	totalCost: number;
	error?: string;
}

interface CacheWarmLease {
	cacheIdentity: string;
	systemPrompt: string;
	systemPromptSnapshot: PromptCacheSystemPromptSnapshot;
	cacheActive: boolean;
	retention: PromptCacheWarmResult["retention"];
	warmedAt: number;
	expiresAt: number;
	warmSince: number;
	refreshCount: number;
	totalCost: number;
	needsPersistence: boolean;
}

interface CacheWarmControllerOptions {
	enabled?: boolean;
	onStateChange?: (state: CacheWarmState) => void;
	onError?: (message: string) => void;
}

const SHORT_CACHE_TTL_MS = 5 * 60 * 1000;
const LONG_CACHE_TTL_MS = 60 * 60 * 1000;
const WARM_LEAD_MS = 10 * 1000;
const FAILED_WARM_RETRY_MS = 5 * 1000;
const STATUS_TICK_MS = 1000;

/** Convert the provider retention mode into the lease lifetime Pi schedules against. */
function getCacheTtl(retention: PromptCacheWarmResult["retention"]): number {
	return retention === "long" ? LONG_CACHE_TTL_MS : SHORT_CACHE_TTL_MS;
}

/** Whether provider usage proves that a prompt cache was created or read. */
export function hasPromptCacheActivity(usage: { cacheRead: number; cacheWrite: number }): boolean {
	return usage.cacheRead > 0 || usage.cacheWrite > 0;
}

/** Whether an entry is private cache-maintenance metadata rather than conversation content. */
export function isCacheWarmEntry(entry: SessionEntry): entry is CustomEntry<CacheWarmMarker> {
	return entry.type === "custom" && entry.customType === CACHE_WARM_MARKER_TYPE;
}

/** Validate the untrusted prompt-delta payload loaded from a session file. */
function isPromptSnapshot(value: unknown): value is PromptCacheSystemPromptSnapshot {
	if (typeof value !== "object" || value === null) return false;
	return (
		"version" in value &&
		value.version === 1 &&
		"baseHash" in value &&
		typeof value.baseHash === "string" &&
		"prefixLength" in value &&
		typeof value.prefixLength === "number" &&
		Number.isInteger(value.prefixLength) &&
		value.prefixLength >= 0 &&
		"suffix" in value &&
		typeof value.suffix === "string"
	);
}

/** Validate a private session entry before using it as provider-request replay state. */
function isCacheWarmMarker(entry: SessionEntry): entry is CustomEntry<CacheWarmMarker> {
	if (!isCacheWarmEntry(entry)) return false;
	const data = entry.data;
	return (
		typeof data === "object" &&
		data !== null &&
		"version" in data &&
		data.version === 1 &&
		"api" in data &&
		data.api === "anthropic-messages" &&
		"provider" in data &&
		typeof data.provider === "string" &&
		"model" in data &&
		typeof data.model === "string" &&
		"cacheIdentity" in data &&
		typeof data.cacheIdentity === "string" &&
		"systemPrompt" in data &&
		isPromptSnapshot(data.systemPrompt) &&
		"cacheActive" in data &&
		typeof data.cacheActive === "boolean" &&
		"retention" in data &&
		(data.retention === "short" || data.retention === "long") &&
		"warmedAt" in data &&
		typeof data.warmedAt === "number" &&
		"expiresAt" in data &&
		typeof data.expiresAt === "number" &&
		"warmSince" in data &&
		typeof data.warmSince === "number" &&
		"refreshCount" in data &&
		typeof data.refreshCount === "number" &&
		"totalCost" in data &&
		typeof data.totalCost === "number"
	);
}

/**
 * Remove cache markers from a human-facing session projection while preserving tree ancestry.
 * The durable source entries remain untouched.
 */
export function omitCacheWarmEntries(
	entries: SessionEntry[],
	leafId: string | null,
): { entries: SessionEntry[]; leafId: string | null } {
	const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
	const nearestVisibleId = (entryId: string | null): string | null => {
		let currentId = entryId;
		while (currentId) {
			const entry = entriesById.get(currentId);
			if (!entry || !isCacheWarmEntry(entry)) return currentId;
			currentId = entry.parentId;
		}
		return null;
	};

	// Reconnect visible descendants across any chain of transparent maintenance nodes.
	const visibleEntries: SessionEntry[] = [];
	for (const entry of entries) {
		if (isCacheWarmEntry(entry)) continue;
		const parentId = nearestVisibleId(entry.parentId);
		visibleEntries.push(parentId === entry.parentId ? entry : { ...entry, parentId });
	}
	return { entries: visibleEntries, leafId: nearestVisibleId(leafId) };
}

/**
 * Keeps an Anthropic Messages prompt cache alive while a session is idle or executing tools.
 * Durable markers are interpreted only along the SessionManager's active branch.
 */
export class CacheWarmController {
	private session: AgentSession;
	private readonly options: CacheWarmControllerOptions;
	private enabled: boolean;
	private paused = false;
	private lease: CacheWarmLease | undefined;
	private warmTimer: ReturnType<typeof setTimeout> | undefined;
	private statusTimer: ReturnType<typeof setInterval> | undefined;
	private warmAbortController: AbortController | undefined;
	private warmPromise: Promise<void> | undefined;
	private error: string | undefined;
	private replayInvalidated = false;
	private foregroundRefreshGeneration = 0;
	/** Latest branch-bound foreground proof retained while warming is disabled for a later interactive opt-in. */
	private retainedForegroundRefresh: ForegroundCacheRefresh | undefined;

	constructor(session: AgentSession, options: CacheWarmControllerOptions = {}) {
		this.session = session;
		this.options = options;
		this.enabled = options.enabled ?? false;
	}

	/** Begin replaying durable lease state and scheduling maintenance requests. */
	async start(): Promise<void> {
		this.ensureStatusTimer();
		await this.sync();
	}

	/** Replace the session lifecycle boundary without allowing an old request to write into the new tree. */
	async rebind(session: AgentSession, options: { resume?: boolean } = {}): Promise<void> {
		this.foregroundRefreshGeneration++;
		await this.pause();
		this.session = session;
		this.lease = undefined;
		this.error = undefined;
		this.replayInvalidated = false;
		this.retainedForegroundRefresh = undefined;
		this.ensureStatusTimer();
		if (options.resume !== false) await this.resume();
	}

	/** Discard a lease after prompt configuration changes and wait for the next foreground refresh. */
	async invalidate(): Promise<void> {
		// Reject foreground listeners captured before this prompt/context boundary, even if they finish later.
		this.foregroundRefreshGeneration++;
		this.retainedForegroundRefresh = undefined;
		await this.pauseRequest();
		this.lease = undefined;
		this.error = undefined;
		this.replayInvalidated = true;
		if (!this.paused) {
			await this.syncWithoutReplay();
		}
	}

	/** Enable or disable warming for this interactive process. */
	async setEnabled(enabled: boolean): Promise<void> {
		if (this.enabled === enabled) {
			this.emitState();
			return;
		}
		this.enabled = enabled;
		this.error = undefined;
		if (!enabled) {
			await this.pauseRequest();
			this.lease = undefined;
			this.emitState();
			return;
		}
		this.paused = false;
		this.ensureStatusTimer();
		const retained = this.getRetainedForegroundRefresh();
		if (this.replayInvalidated && !retained) {
			await this.syncWithoutReplay();
		} else {
			this.replayInvalidated = false;
			await this.sync(retained);
		}
	}

	/** Stop timers and drain an in-flight hidden request before a real agent or summary request starts. */
	async pause(): Promise<void> {
		this.paused = true;
		await this.pauseRequest();
		this.emitState();
	}

	/** Reconstruct the latest lease and resume scheduling after the session becomes idle. */
	async resume(): Promise<void> {
		await this.resumeWithForegroundRequest();
	}

	/** Resume after a foreground request and durably record its refreshed lease. */
	async resumeAfterForegroundRequest(refresh: ForegroundCacheRefresh | undefined): Promise<void> {
		await this.resumeWithForegroundRequest(refresh);
	}

	/** Current prompt/context generation used to reject delayed foreground proofs after invalidation. */
	getForegroundRefreshGeneration(): number {
		return this.foregroundRefreshGeneration;
	}

	private async resumeWithForegroundRequest(refresh?: ForegroundCacheRefresh): Promise<void> {
		// Keep the newest complete proof even when delayed settle listeners finish out of order.
		const currentRefresh = refresh?.generation === this.foregroundRefreshGeneration ? refresh : undefined;
		if (
			currentRefresh &&
			(!this.retainedForegroundRefresh || currentRefresh.warmedAt >= this.retainedForegroundRefresh.warmedAt)
		) {
			this.retainedForegroundRefresh = currentRefresh;
		}
		this.paused = false;
		const retained = currentRefresh ? this.getRetainedForegroundRefresh() : undefined;
		if (this.replayInvalidated && !retained) {
			await this.syncWithoutReplay();
		} else {
			this.replayInvalidated = false;
			await this.sync(retained);
		}
	}

	private getRetainedForegroundRefresh(): ForegroundCacheRefresh | undefined {
		const retained = this.retainedForegroundRefresh;
		if (!retained) return undefined;

		// A retained proof may follow descendants, but not a branch, model, or prompt-identity change.
		const model = this.session.model;
		const cacheIdentity = this.session.getPromptCacheIdentity(this.session.systemPrompt);
		const remainsOnActiveBranch =
			retained.leafId === null
				? this.session.sessionManager.getLeafId() === null
				: this.session.sessionManager.getBranch().some((entry) => entry.id === retained.leafId);
		if (
			remainsOnActiveBranch &&
			retained.generation === this.foregroundRefreshGeneration &&
			model?.provider === retained.provider &&
			model.id === retained.model &&
			cacheIdentity === retained.cacheIdentity
		) {
			return retained;
		}

		this.retainedForegroundRefresh = undefined;
		return undefined;
	}

	/** Re-evaluate the active branch, current model, and retention, then schedule the next refresh. */
	async sync(foregroundRefresh?: ForegroundCacheRefresh): Promise<void> {
		this.clearWarmTimer();
		if (!this.enabled || this.paused) {
			this.emitState();
			return;
		}

		const model = this.session.model;
		const systemPrompt = this.session.systemPrompt;
		const cacheIdentity = this.session.getPromptCacheIdentity(systemPrompt);
		if (!model || model.api !== "anthropic-messages" || !cacheIdentity) {
			this.lease = undefined;
			this.error = undefined;
			this.emitState();
			return;
		}
		if (!this.session.canWarmPromptCache) {
			this.emitState();
			return;
		}

		try {
			const retention = await this.session.getPromptCacheRetention();
			if (!retention) return;
			const systemPromptSnapshot = this.session.createPromptCacheSystemPromptSnapshot(systemPrompt);
			const foregroundWarmedAt =
				foregroundRefresh?.provider === model.provider &&
				foregroundRefresh.model === model.id &&
				foregroundRefresh.cacheIdentity === cacheIdentity
					? foregroundRefresh.warmedAt
					: undefined;
			this.lease = this.deriveLease(
				cacheIdentity,
				systemPrompt,
				systemPromptSnapshot,
				retention,
				foregroundWarmedAt,
			);
			if (this.lease?.needsPersistence) {
				this.persistLease(this.lease);
				this.lease.needsPersistence = false;
			}
			this.error = undefined;
			if (this.lease?.cacheActive && this.lease.expiresAt > Date.now()) {
				this.scheduleWarm(this.lease.expiresAt - WARM_LEAD_MS);
			}
		} catch (error) {
			this.reportError(error);
		}
		this.emitState();
	}

	/** Abort timers and hidden provider work permanently. */
	async dispose(): Promise<void> {
		this.enabled = false;
		this.paused = true;
		this.clearWarmTimer();
		if (this.statusTimer) clearInterval(this.statusTimer);
		this.statusTimer = undefined;
		await this.pauseRequest();
	}

	/** Snapshot state for commands and presentation. */
	getState(): CacheWarmState {
		const eligible = this.session.model?.api === "anthropic-messages";
		const available = this.session.canWarmPromptCache && !this.paused;
		// Show maintenance once a requested pause reaches safe tool work, but never over an active provider request.
		const idle = available && (this.session.isIdle || this.session.isPauseRequested);
		const leaseActive = this.lease?.cacheActive === true && this.lease.expiresAt > Date.now();
		const cold = this.lease?.cacheActive === true && this.lease.expiresAt <= Date.now();
		return {
			enabled: this.enabled,
			eligible,
			idle,
			warming: this.warmPromise !== undefined,
			active: this.enabled && eligible && available && leaseActive,
			cold,
			cacheUnavailable: this.lease?.cacheActive === false,
			retrying: !cold && this.error !== undefined && this.warmTimer !== undefined,
			warmSince: leaseActive ? this.lease?.warmSince : undefined,
			expiresAt: leaseActive ? this.lease?.expiresAt : undefined,
			refreshCount: this.lease?.refreshCount ?? 0,
			totalCost: this.lease?.totalCost ?? 0,
			error: this.error,
		};
	}

	private deriveLease(
		cacheIdentity: string,
		systemPrompt: string,
		systemPromptSnapshot: PromptCacheSystemPromptSnapshot,
		retention: PromptCacheWarmResult["retention"],
		foregroundWarmedAt?: number,
	): CacheWarmLease | undefined {
		const model = this.session.model;
		if (!model) return undefined;
		const branch = this.session.sessionManager.getBranch();
		let resetIndex = -1;
		for (let i = branch.length - 1; i >= 0; i--) {
			if (branch[i].type === "compaction" || branch[i].type === "branch_summary") {
				resetIndex = i;
				break;
			}
		}

		// Reconstruct only identity-bound markers after the latest context rewrite; hashes alone cannot replay extension prompts.
		let markerLease: CacheWarmLease | undefined;
		for (let i = branch.length - 1; i > resetIndex; i--) {
			const entry = branch[i];
			if (!isCacheWarmMarker(entry) || !entry.data) continue;
			const marker = entry.data;
			const restoredSystemPrompt = this.session.restorePromptCacheSystemPrompt(marker.systemPrompt);
			if (!restoredSystemPrompt) continue;
			const restoredIdentity = this.session.getPromptCacheIdentity(restoredSystemPrompt);
			if (
				marker.provider !== model.provider ||
				marker.model !== model.id ||
				marker.cacheIdentity !== restoredIdentity ||
				(foregroundWarmedAt !== undefined && marker.cacheIdentity !== cacheIdentity) ||
				marker.retention !== retention
			) {
				continue;
			}

			markerLease = {
				cacheIdentity: marker.cacheIdentity,
				systemPrompt: restoredSystemPrompt,
				systemPromptSnapshot: marker.systemPrompt,
				cacheActive: marker.cacheActive,
				retention: marker.retention,
				warmedAt: marker.warmedAt,
				expiresAt: marker.expiresAt,
				warmSince: marker.warmSince,
				refreshCount: marker.refreshCount,
				totalCost: marker.totalCost,
				needsPersistence: false,
			};
			break;
		}

		if (
			foregroundWarmedAt === undefined ||
			(markerLease !== undefined && markerLease.warmedAt >= foregroundWarmedAt)
		) {
			return markerLease;
		}

		// A foreground request refreshes the lease while preserving hidden-maintenance accounting only across a warm span.
		const ttl = getCacheTtl(retention);
		const continuous = markerLease !== undefined && markerLease.expiresAt >= foregroundWarmedAt;
		return {
			cacheIdentity,
			systemPrompt,
			systemPromptSnapshot,
			cacheActive: true,
			retention,
			warmedAt: foregroundWarmedAt,
			expiresAt: foregroundWarmedAt + ttl,
			warmSince: continuous && markerLease ? markerLease.warmSince : foregroundWarmedAt,
			refreshCount: continuous && markerLease ? markerLease.refreshCount : 0,
			totalCost: continuous && markerLease ? markerLease.totalCost : 0,
			needsPersistence: true,
		};
	}

	private scheduleWarm(at: number): void {
		this.clearWarmTimer();
		const lease = this.lease;
		// Maintenance may renew only a proven live lease; foreground traffic must recreate a cold cache.
		if (!lease?.cacheActive || Date.now() >= lease.expiresAt || at >= lease.expiresAt) return;
		const delay = Math.max(0, at - Date.now());
		this.warmTimer = setTimeout(() => {
			this.warmTimer = undefined;
			void this.syncAndWarm();
		}, delay);
	}

	private async syncAndWarm(): Promise<void> {
		if (!this.enabled || this.paused || !this.session.canWarmPromptCache) return;
		try {
			const lease = this.lease;
			if (!lease) return;
			if (!lease.cacheActive || lease.expiresAt <= Date.now()) {
				this.emitState();
				return;
			}
			if (this.session.getPromptCacheIdentity(lease.systemPrompt) !== lease.cacheIdentity) {
				this.lease = undefined;
				this.emitState();
				return;
			}
			await this.warmNow(lease);
		} catch (error) {
			this.reportError(error);
			this.scheduleWarm(Date.now() + FAILED_WARM_RETRY_MS);
		}
	}

	private async syncWithoutReplay(): Promise<void> {
		// Invalidation makes prior markers ineligible until a foreground request proves the new prompt was cached.
		this.clearWarmTimer();
		this.lease = undefined;
		this.error = undefined;
		this.emitState();
	}

	private async warmNow(lease: CacheWarmLease): Promise<void> {
		if (this.warmPromise || !this.enabled || this.paused) return;
		const abortController = new AbortController();
		// Keep cancellation live through asynchronous preparation so no provider attempt can begin after expiry.
		const expiryTimer = setTimeout(() => abortController.abort(), Math.max(0, lease.expiresAt - Date.now()));
		this.warmAbortController = abortController;
		this.warmPromise = this.executeWarm(lease, abortController.signal).finally(() => {
			clearTimeout(expiryTimer);
			this.warmAbortController = undefined;
			this.warmPromise = undefined;
			this.emitState();
		});
		this.emitState();
		await this.warmPromise;
	}

	private async executeWarm(activeLease: CacheWarmLease, signal: AbortSignal): Promise<void> {
		try {
			const result = await this.session.warmPromptCache(signal, activeLease.systemPrompt, activeLease.expiresAt);
			if (signal.aborted || !this.enabled || this.paused) return;
			if (!hasPromptCacheActivity(result.usage)) {
				// Preserve billed maintenance accounting while recording that this branch no longer has a proven cache lease.
				const inactiveLease: CacheWarmLease = {
					...activeLease,
					cacheActive: false,
					warmedAt: result.warmedAt,
					expiresAt: result.warmedAt,
					totalCost: activeLease.totalCost + result.usage.cost.total,
					needsPersistence: false,
				};
				this.persistLease(inactiveLease);
				this.lease = inactiveLease;
				this.reportError(new Error("Cache warming reported no cache read or cache write"));
				return;
			}
			if (this.session.getPromptCacheIdentity(activeLease.systemPrompt) !== activeLease.cacheIdentity) {
				this.lease = undefined;
				return;
			}
			const ttl = getCacheTtl(result.retention);
			const previousLease = this.lease;
			const continuous =
				previousLease?.cacheIdentity === activeLease.cacheIdentity &&
				previousLease.retention === result.retention &&
				previousLease.expiresAt >= result.warmedAt;
			const lease: CacheWarmLease = {
				cacheIdentity: activeLease.cacheIdentity,
				systemPrompt: activeLease.systemPrompt,
				systemPromptSnapshot: activeLease.systemPromptSnapshot,
				cacheActive: true,
				retention: result.retention,
				warmedAt: result.warmedAt,
				expiresAt: result.warmedAt + ttl,
				warmSince: continuous && previousLease ? previousLease.warmSince : result.warmedAt,
				refreshCount: (continuous && previousLease ? previousLease.refreshCount : 0) + 1,
				totalCost: (continuous && previousLease ? previousLease.totalCost : 0) + result.usage.cost.total,
				needsPersistence: false,
			};

			// Persist the verified lease and compact prompt delta; synthetic messages never enter conversation history.
			this.persistLease(lease);
			this.lease = lease;
			this.error = undefined;
			this.scheduleWarm(lease.expiresAt - WARM_LEAD_MS);
		} catch (error) {
			if (signal.aborted || activeLease.expiresAt <= Date.now()) return;
			this.reportError(error);
			this.scheduleWarm(Date.now() + FAILED_WARM_RETRY_MS);
		}
	}

	private persistLease(lease: CacheWarmLease): void {
		const model = this.session.model;
		if (!model) throw new Error("Cannot persist a prompt-cache lease without an active model");
		const marker: CacheWarmMarker = {
			version: 1,
			api: "anthropic-messages",
			provider: model.provider,
			model: model.id,
			cacheIdentity: lease.cacheIdentity,
			systemPrompt: lease.systemPromptSnapshot,
			cacheActive: lease.cacheActive,
			retention: lease.retention,
			warmedAt: lease.warmedAt,
			expiresAt: lease.expiresAt,
			warmSince: lease.warmSince,
			refreshCount: lease.refreshCount,
			totalCost: lease.totalCost,
		};
		this.session.sessionManager.appendCustomEntry(CACHE_WARM_MARKER_TYPE, marker);
	}

	private async pauseRequest(): Promise<void> {
		this.clearWarmTimer();
		this.warmAbortController?.abort();
		await this.warmPromise;
	}

	private clearWarmTimer(): void {
		if (this.warmTimer) clearTimeout(this.warmTimer);
		this.warmTimer = undefined;
	}

	private ensureStatusTimer(): void {
		if (this.statusTimer) return;
		this.statusTimer = setInterval(() => this.emitState(), STATUS_TICK_MS);
	}

	private reportError(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		if (message !== this.error) this.options.onError?.(message);
		this.error = message;
	}

	private emitState(): void {
		this.options.onStateChange?.(this.getState());
	}
}
