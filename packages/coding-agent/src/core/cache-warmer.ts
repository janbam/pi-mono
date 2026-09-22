import {
	type Api,
	type AssistantMessage,
	type CacheRetention,
	type Context,
	calculateCost,
	clampThinkingLevel,
	type Model,
	type ModelsSimpleStreamOptions,
	type Usage,
} from "@earendil-works/pi-ai";
import { getProviderEnvValue } from "@earendil-works/pi-ai/utils/provider-env";
import type { ModelRuntime } from "./model-runtime.ts";
import type { SessionEntry, SessionManager, UsageEntry } from "./session-manager.ts";
import type { CacheWarmingMode } from "./settings-manager.ts";

/** JBMOD: refresh this long before the cache entry expires (upstream: at 90% of the TTL). */
const REFRESH_MARGIN_MS = 10_000;
/** A refresh is sent only when it is expected to save at least this many dollars. */
const CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS = 0.05;
/**
 * Chance that a real request arrives before the cache entry expires while the
 * agent sits idle. Measured from our own usage; per-session estimates were not
 * better than this constant.
 */
const IDLE_CONTINUATION_PROBABILITY = 0.15;

/**
 * JBMOD: warming mode after the process override is applied. "on" comes from `-kw` or
 * `/warm on`: warm while running and idle like "idle", but without the savings floor.
 */
export type CacheWarmingEffectiveMode = CacheWarmingMode | "on";

/**
 * JBMOD: process-only warming override from `-kw` or `/warm`. Never persisted; the holder is
 * created once per process and shared by every session so it survives `/resume` and `/new`.
 * `mode` undefined follows the `cacheWarming` setting.
 */
export interface CacheWarmingOverride {
	mode?: "on" | "off";
}

/** JBMOD: the settings the warmer reads live on every decision. */
export interface CacheWarmingPolicy {
	mode: CacheWarmingEffectiveMode;
	/** Warming stops once the next refresh would be this long after the last real request. */
	maxAgeMs: number;
}

/** Refresh `REFRESH_MARGIN_MS` before expiry; undefined when the TTL leaves no room for that. */
export function getCacheWarmingDelayMs(ttlMs: number): number | undefined {
	if (ttlMs <= REFRESH_MARGIN_MS) return undefined;
	return ttlMs - REFRESH_MARGIN_MS;
}

function getPromptCacheRetention(options: ModelsSimpleStreamOptions | undefined): CacheRetention {
	return (
		options?.cacheRetention ?? (getProviderEnvValue("PI_CACHE_RETENTION", options?.env) === "long" ? "long" : "short")
	);
}

/**
 * Lifetime of the prompt cache entry a request writes, from the model's
 * `promptCache` tier for the retention the request used. Undefined when the
 * model has no lifetime for that tier or caching is off.
 */
export function getPromptCacheTtlMs(
	model: Model<Api>,
	options: ModelsSimpleStreamOptions | undefined,
): number | undefined {
	const retention = getPromptCacheRetention(options);
	if (retention === "none") return undefined;
	const seconds = model.promptCache?.[retention];
	return seconds === undefined ? undefined : seconds * 1000;
}

/**
 * Whether replaying the request with a one-token output cap leaves its cache
 * entry untouched. Anthropic's budget-based thinking (Claude models without
 * adaptive thinking) derives `budget_tokens` from `max_tokens`; the replay
 * would get a different budget, which Anthropic keys the message cache on,
 * and the model could still think for thousands of tokens.
 */
export function isReplayable(model: Model<Api>, options: ModelsSimpleStreamOptions | undefined): boolean {
	// JBMOD: fork request options carry the unresolved Pi level; judge the level the model will actually receive,
	// since always-thinking models clamp "off" up to a budget level.
	if (model.api !== "anthropic-messages" || clampThinkingLevel(model, options?.reasoning ?? "off") === "off") {
		return true;
	}
	return (model as Model<"anthropic-messages">).compat?.forceAdaptiveThinking === true;
}

/**
 * JBMOD: output cap of a refresh. Anthropic documents `max_tokens: 0` as a cache pre-warm that
 * bills no output. Only models with a declared `promptCache` are warmed, so an Anthropic-API
 * proxy reaching this point was declared Anthropic-cache compatible; one that rejects the
 * pre-warm fails the refresh, which stops warming visibly.
 */
export function getCacheWarmingMaxTokens(model: Model<Api>): number {
	return model.api === "anthropic-messages" ? 0 : 1;
}

/** Prompt size of the most recent real request on the branch, as reported by the provider. */
function lastPromptTokens(entries: SessionEntry[]): number {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "message" && entry.message.role === "assistant") {
			const usage = entry.message.usage;
			return usage.input + usage.cacheRead + usage.cacheWrite;
		}
	}
	return 0;
}

/** JBMOD: the cache lease left by the transcript's last real request, as needed to resume warming it. */
interface RestorableLease {
	/** The last real response; its request is what gets rebuilt and replayed. */
	message: AssistantMessage;
	/** Dispatch time of that request (assistant timestamps are taken at request start). */
	requestAt: number;
	/** Latest time the entry's TTL was renewed, by that request or a later refresh. */
	leaseStartedAt: number;
	refreshCount: number;
	refreshCost: number;
}

/**
 * JBMOD: walk back from the branch tip to the last real request, collecting the refreshes that
 * renewed its entry since. Returns a stop reason when that request cannot be warmed anymore.
 * Refresh usage entries are written after their response, so their timestamps overstate the
 * lease by the refresh latency; the pre-expiry margin absorbs that.
 */
function findRestorableLease(entries: SessionEntry[]): RestorableLease | string {
	let refreshCount = 0;
	let refreshCost = 0;
	let lastRefreshAt: number | undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "usage" && entry.kind === "cache_warm") {
			refreshCount++;
			refreshCost += entry.usage.cost.total;
			lastRefreshAt ??= Date.parse(entry.timestamp);
			continue;
		}
		// These rewrite the prefix the next request sends, so the cached entry no longer matches it.
		if (entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "context_edit") {
			return "context rewritten since the last request";
		}
		if (entry.type === "message" && entry.message.role === "assistant") {
			const message = entry.message;
			if (message.usage.cacheRead + message.usage.cacheWrite === 0) {
				return "last request did not use the prompt cache";
			}
			return {
				message,
				requestAt: message.timestamp,
				leaseStartedAt: Math.max(message.timestamp, lastRefreshAt ?? 0),
				refreshCount,
				refreshCost,
			};
		}
	}
	return "waiting for first request";
}

function price(
	model: Model<Api>,
	tokens: Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite" | "cacheWrite1h">>,
): number {
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...tokens,
	};
	return calculateCost(model, usage).total;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export type CacheWarmingAction = "warm" | "stop";

/** Inputs and outcome of one warm-or-stop decision, as shown by `/session`. */
export interface CacheWarmingDecision {
	/** "streaming" while the agent run that sent the request is still active. */
	phase: "streaming" | "idle";
	/** Price of this refresh: a cache read of the prompt plus one output token. */
	warmCost: number;
	/** Extra price of the next real request if the cache entry is lost. */
	missCost: number;
	/** Estimated chance that a real request arrives before the entry expires. */
	continuationProbability: number;
	/** `continuationProbability * missCost - warmCost`. */
	expectedSavings: number;
	/** False when the prompt size or the model's prices are unknown. */
	economicsAvailable: boolean;
	/** JBMOD: warming was enabled explicitly (`-kw`, `/warm on`), so the savings floor does not apply. */
	explicit: boolean;
	/** Pi's decision: "warm" when `expectedSavings` is at least $0.05, or always when `explicit`. */
	action: CacheWarmingAction;
}

/**
 * Fired before each refresh with pi's decision filled in. Everything else an
 * extension might want (model, idle state, context size) is on the context.
 */
export interface CacheWarmingDecisionEvent
	extends Pick<CacheWarmingDecision, "warmCost" | "missCost" | "continuationProbability" | "action"> {
	type: "cache_warming_decision";
}

export interface CacheWarmingDecisionEventResult {
	/** Override whether this refresh is sent. "stop" ends warming until the next real request. */
	action?: CacheWarmingAction;
}

export interface CacheWarmingStatus {
	/** "scheduled": a refresh timer is armed; "refreshing": a warm request is in flight. */
	state: "inactive" | "scheduled" | "refreshing";
	/** Why nothing is scheduled. */
	reason?: string;
	/** JBMOD: warming stopped because a refresh failed or missed the cache, not by policy. */
	failed?: boolean;
	nextWarmAt?: number;
	/** The pending decision, or the decision that stopped warming. */
	decision?: CacheWarmingDecision;
	/** True when an extension changed `decision.action`. */
	extensionOverride?: boolean;
	/** JBMOD: time of the real request whose cache entry is being held warm. */
	warmSince?: number;
	/** JBMOD: refreshes sent for that request, and their summed cost. */
	refreshCount?: number;
	refreshCost?: number;
}

/** The request whose prompt cache entry should be kept warm, exactly as it was sent. */
export interface CacheWarmRequest {
	model: Model<Api>;
	context: Context;
	options: ModelsSimpleStreamOptions;
}

/** JBMOD: a request rebuilt from the transcript, with the staleness check for the live session. */
export interface RebuiltCacheWarmRequest {
	request: CacheWarmRequest;
	/** False once the session's model or messages no longer match the request. */
	isCurrent: () => boolean;
}

/** Where a new run starts: fresh from a real request, or resumed from a transcript lease. */
interface RunStart {
	startedAt: number;
	leaseStartedAt: number;
	phase: "streaming" | "idle";
	refreshCount: number;
	refreshCost: number;
}

interface ActiveRun extends CacheWarmRequest, RunStart {
	/** False once the session's model or messages no longer match the request. */
	isCurrent: () => boolean;
	ttlMs: number;
	delayMs: number;
	/** JBMOD: the request wrote a 1-hour entry, so a miss re-pays the 1-hour write rate. */
	longRetention: boolean;
	/** Latest safe time to send this refresh, leaving half the original expiry margin. */
	refreshDeadlineAt: number;
	controller: AbortController;
	nextWarmAt: number;
	/** Set while a refresh that an extension forced is in flight. */
	extensionOverride: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

/**
 * Keeps one prompt cache entry alive by re-sending its request with a
 * zero- or one-token output cap before the entry expires. `start` replaces any
 * previous run; warm requests never extend the age cap, which counts from the
 * last real request.
 */
export class CacheWarmer {
	private run?: ActiveRun;
	private inactive: CacheWarmingStatus;
	/** Bumped whenever a run begins, so an async `restore` can tell that a real request took over. */
	private generation = 0;
	private readonly models: Pick<ModelRuntime, "streamSimple">;
	private readonly sessionManager: Pick<SessionManager, "appendUsage" | "getBranch">;
	private readonly getPolicy: () => CacheWarmingPolicy;
	/** Lets extensions override `event.action`; failures fall back to pi's decision. */
	private readonly decide: (event: CacheWarmingDecisionEvent) => Promise<CacheWarmingAction>;
	/** JBMOD: rebuilds the transcript's last real request for `restore`; absent means no restore. */
	private readonly rebuildLastRequest?: () => Promise<RebuiltCacheWarmRequest | undefined>;
	/** Called with the persisted usage entry after each successful refresh. */
	onWarmed?: (entry: UsageEntry) => void;

	constructor(
		models: Pick<ModelRuntime, "streamSimple">,
		sessionManager: Pick<SessionManager, "appendUsage" | "getBranch">,
		getPolicy: () => CacheWarmingPolicy,
		decide: (event: CacheWarmingDecisionEvent) => Promise<CacheWarmingAction> = async (event) => event.action,
		rebuildLastRequest?: () => Promise<RebuiltCacheWarmRequest | undefined>,
	) {
		this.models = models;
		this.sessionManager = sessionManager;
		this.getPolicy = getPolicy;
		this.decide = decide;
		this.rebuildLastRequest = rebuildLastRequest;
		this.inactive = { state: "inactive", reason: "waiting for first request" };
	}

	get status(): CacheWarmingStatus {
		const mode = this.getPolicy().mode;
		if (mode === "off") return { state: "inactive", reason: "cache warming disabled" };
		const run = this.run;
		if (!run) return this.inactive;
		if (!run.isCurrent()) return { state: "inactive", reason: "conversation context changed" };
		const decision = this.evaluate(run);
		const refreshing = run.timer === undefined;
		if (!decision.economicsAvailable && !refreshing && mode !== "on") {
			return { state: "inactive", reason: "cache economics unavailable" };
		}
		return {
			state: refreshing ? "refreshing" : "scheduled",
			nextWarmAt: run.nextWarmAt,
			decision,
			extensionOverride: run.extensionOverride,
			warmSince: run.startedAt,
			refreshCount: run.refreshCount,
			refreshCost: run.refreshCost,
		};
	}

	/** Keep the prompt cache entry written by `request` warm while `isCurrent` holds. */
	start(request: CacheWarmRequest, isCurrent: () => boolean): void {
		const now = Date.now();
		this.begin(request, isCurrent, {
			startedAt: now,
			leaseStartedAt: now,
			phase: "streaming",
			refreshCount: 0,
			refreshCost: 0,
		});
	}

	/**
	 * JBMOD: resume warming the transcript's last real request after a session resume or an
	 * explicit enable while idle. Only while idle warming is enabled and nothing is warming yet.
	 * Reconstruction mismatches cost at most one refresh: its missing cache read stops warming.
	 */
	async restore(): Promise<void> {
		const mode = this.getPolicy().mode;
		if ((mode !== "idle" && mode !== "on") || this.run || !this.rebuildLastRequest) return;
		const lease = findRestorableLease(this.sessionManager.getBranch());
		if (typeof lease === "string") {
			this.stop(lease);
			return;
		}
		// Rebuilding awaits extension context hooks; a real request that starts meanwhile owns warming.
		const generation = this.generation;
		let rebuilt: RebuiltCacheWarmRequest | undefined;
		try {
			rebuilt = await this.rebuildLastRequest();
		} catch (error) {
			if (generation === this.generation && !this.run) {
				this.stop(`could not rebuild the last request: ${errorText(error)}`, { failed: true });
			}
			return;
		}
		if (generation !== this.generation || this.run) return;
		if (!rebuilt) {
			this.stop("waiting for first request");
			return;
		}
		// The rebuilt request uses the session's current model; a different one has a different cache.
		const { model } = rebuilt.request;
		if (model.provider !== lease.message.provider || model.id !== lease.message.model) {
			this.stop("model changed since the last request");
			return;
		}
		this.begin(rebuilt.request, rebuilt.isCurrent, {
			startedAt: lease.requestAt,
			leaseStartedAt: lease.leaseStartedAt,
			phase: "idle",
			refreshCount: lease.refreshCount,
			refreshCost: lease.refreshCost,
		});
	}

	onAgentSettled(): void {
		const run = this.run;
		if (!run) return;
		if (this.getPolicy().mode === "streaming") {
			this.stop("agent run settled");
			return;
		}
		// The scheduled refresh already respects the age cap, which is the same for both phases.
		run.phase = "idle";
	}

	/** Reconcile an active run after the effective warming mode changes. */
	onModeChanged(): void {
		const run = this.run;
		if (!run) return;
		const reason = this.getModeStopReason(run);
		if (reason) this.stop(reason);
	}

	cancel(): void {
		this.stop("inactive");
	}

	/** Validate `request` and arm its first refresh; shared by live capture and transcript restore. */
	private begin(request: CacheWarmRequest, isCurrent: () => boolean, runStart: RunStart): void {
		this.clearRun();
		this.generation++;
		if (this.getPolicy().mode === "off") {
			this.stop("cache warming disabled");
			return;
		}
		if (!isReplayable(request.model, request.options)) {
			this.stop("request cannot be replayed safely");
			return;
		}
		const ttlMs = getPromptCacheTtlMs(request.model, request.options);
		if (ttlMs === undefined) {
			this.stop(
				request.options.cacheRetention === "none"
					? "request disabled prompt caching"
					: "cache lifetime unavailable",
			);
			return;
		}
		const delayMs = getCacheWarmingDelayMs(ttlMs);
		if (delayMs === undefined) {
			this.stop("cache lifetime unavailable");
			return;
		}
		this.run = {
			...request,
			...runStart,
			isCurrent,
			ttlMs,
			delayMs,
			longRetention: getPromptCacheRetention(request.options) === "long",
			refreshDeadlineAt: 0,
			controller: new AbortController(),
			nextWarmAt: 0,
			extensionOverride: false,
		};
		this.schedule(this.run);
	}

	private clearRun(): void {
		const run = this.run;
		if (!run) return;
		this.run = undefined;
		if (run.timer) clearTimeout(run.timer);
		run.controller.abort();
	}

	private stop(reason: string, stopped?: Pick<CacheWarmingStatus, "decision" | "extensionOverride" | "failed">): void {
		this.clearRun();
		this.inactive = { state: "inactive", reason, ...stopped };
	}

	/** Arm the next refresh relative to the last renewal of the entry, within expiry and age limits. */
	private schedule(run: ActiveRun): void {
		run.extensionOverride = false;
		run.nextWarmAt = run.leaseStartedAt + run.delayMs;
		// A timer can run late after sleep or event-loop blockage. Keep half of
		// the planned pre-expiry margin for that delay and request dispatch; a
		// late refresh is likely a full-price cache write, not a cache warm.
		run.refreshDeadlineAt = run.nextWarmAt + Math.floor((run.ttlMs - run.delayMs) / 2);
		if (Date.now() > run.refreshDeadlineAt) {
			this.stop("prompt cache already expired");
			return;
		}
		const { maxAgeMs } = this.getPolicy();
		if (run.nextWarmAt > run.startedAt + maxAgeMs) {
			this.stop(`${Math.round(maxAgeMs / 60_000)}-minute warming limit reached`);
			return;
		}
		run.timer = setTimeout(() => void this.refresh(run), Math.max(0, run.nextWarmAt - Date.now()));
		run.timer.unref?.();
	}

	private async refresh(run: ActiveRun): Promise<void> {
		run.timer = undefined;
		if (!this.validateRun(run)) return;
		if (this.refreshDeadlineMissed(run)) return;
		const decision = this.evaluate(run);
		const { warmCost, missCost, continuationProbability } = decision;
		let action = decision.action;
		try {
			action = await this.decide({
				type: "cache_warming_decision",
				warmCost,
				missCost,
				continuationProbability,
				action,
			});
		} catch {
			// Extension failures fall back to pi's own decision.
		}
		if (!this.validateRun(run) || this.refreshDeadlineMissed(run)) return;
		const extensionOverride = action !== decision.action;
		if (action === "stop") {
			const reason = extensionOverride
				? "stopped by extension"
				: decision.economicsAvailable
					? "expected savings below threshold"
					: "cache economics unavailable";
			this.stop(reason, { decision, extensionOverride });
			return;
		}

		run.extensionOverride = extensionOverride;
		// The TTL renews from the moment the refresh is dispatched, not when its response arrives.
		const dispatchedAt = Date.now();
		try {
			const message = await this.models
				.streamSimple(run.model, run.context, {
					...run.options,
					maxTokens: getCacheWarmingMaxTokens(run.model),
					maxRetries: 0,
					signal: run.controller.signal,
				})
				.result();
			if (!this.validateRun(run)) return;
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				throw new Error(message.errorMessage ?? `refresh ${message.stopReason}`);
			}
			const entry = this.sessionManager.appendUsage(
				"cache_warm",
				message.provider,
				message.responseModel ?? message.model,
				message.usage,
				extensionOverride ? "extension override" : undefined,
			);
			run.refreshCount++;
			run.refreshCost += message.usage.cost.total;
			this.onWarmed?.(entry);
			// JBMOD: only a cache read proves the entry was alive and the replay matched it. A
			// write-only refresh paid for a new entry the next real request may never read.
			if (message.usage.cacheRead === 0) {
				this.stop("refresh missed the cache (entry expired or replay differs)", { failed: true });
				return;
			}
		} catch (error) {
			// JBMOD: stop loudly instead of retrying; a retry after the margin would be a full-price write.
			if (this.run === run) this.stop(`cache refresh failed: ${errorText(error)}`, { failed: true });
			return;
		}
		run.leaseStartedAt = dispatchedAt;
		this.schedule(run);
	}

	private refreshDeadlineMissed(run: ActiveRun): boolean {
		if (Date.now() <= run.refreshDeadlineAt) return false;
		this.stop("cache refresh deadline missed");
		return true;
	}

	private validateRun(run: ActiveRun): boolean {
		if (this.run !== run) return false;
		const reason = this.getModeStopReason(run) ?? (!run.isCurrent() ? "conversation context changed" : undefined);
		if (!reason) return true;
		this.stop(reason);
		return false;
	}

	private getModeStopReason(run: ActiveRun): string | undefined {
		const mode = this.getPolicy().mode;
		if (mode === "off") return "cache warming disabled";
		if (mode === "streaming" && run.phase === "idle") return "agent run settled";
		return undefined;
	}

	private evaluate(run: ActiveRun): CacheWarmingDecision {
		const model = run.model;
		const explicit = this.getPolicy().mode === "on";
		const promptTokens = lastPromptTokens(this.sessionManager.getBranch());
		const cacheHitCost = price(model, { cacheRead: promptTokens });
		// JBMOD: a lost 1-hour entry is rewritten at the 1-hour rate (2x input), not the 5-minute rate.
		const cacheMissCost = price(
			model,
			model.cost.cacheWrite > 0
				? { cacheWrite: promptTokens, ...(run.longRetention ? { cacheWrite1h: promptTokens } : {}) }
				: { input: promptTokens },
		);
		const warmCost = price(model, { cacheRead: promptTokens, output: 1 });
		const missCost = Math.max(0, cacheMissCost - cacheHitCost);
		const continuationProbability = run.phase === "idle" ? IDLE_CONTINUATION_PROBABILITY : 1;
		const economicsAvailable = promptTokens > 0 && (cacheHitCost > 0 || cacheMissCost > 0);
		const expectedSavings = continuationProbability * missCost - warmCost;
		return {
			phase: run.phase,
			warmCost,
			missCost,
			continuationProbability,
			expectedSavings,
			economicsAvailable,
			explicit,
			action: explicit || expectedSavings >= CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS ? "warm" : "stop",
		};
	}
}

function formatDollars(value: number): string {
	return value < 0 ? `-$${Math.abs(value).toFixed(3)}` : `$${value.toFixed(3)}`;
}

function formatCacheWarmingEconomics(decision: CacheWarmingDecision): string {
	if (!decision.economicsAvailable) return "cache economics unavailable";
	const probability = Math.round(decision.continuationProbability * 100);
	const probabilityText =
		decision.phase === "streaming"
			? `${probability}% continuation probability while agent is running`
			: `${probability}% continuation probability`;
	if (decision.explicit) {
		return `${probabilityText}, expected savings ${formatDollars(decision.expectedSavings)}, savings floor skipped (enabled explicitly)`;
	}
	const comparison = decision.action === "warm" ? ">=" : "<";
	return `${probabilityText}, expected savings ${formatDollars(decision.expectedSavings)} ${comparison} $${CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS.toFixed(3)}`;
}

function formatCacheWarmingDecisionTime(nextWarmAt: number | undefined, now: number): string {
	if (nextWarmAt === undefined || nextWarmAt <= now) return "Decision now";
	let remainingSeconds = Math.ceil((nextWarmAt - now) / 1000);
	const hours = Math.floor(remainingSeconds / 3600);
	remainingSeconds %= 3600;
	const minutes = Math.floor(remainingSeconds / 60);
	const seconds = remainingSeconds % 60;
	const parts: string[] = [];
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}m`);
	if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
	return `Decision in ${parts.join(" ")}`;
}

/** One-line status for `/session`. */
export function formatCacheWarmingStatus(status: CacheWarmingStatus, now = Date.now()): string {
	const decision = status.decision;
	// A decision is attached once pi (or an extension) acted on it; "inactive"
	// without one never got that far.
	if (!decision || (status.state === "inactive" && !decision.economicsAvailable && !status.extensionOverride)) {
		return `Inactive (${status.reason ?? "unknown reason"})`;
	}
	const details = status.extensionOverride
		? `extension override, ${formatCacheWarmingEconomics(decision)}`
		: `${formatCacheWarmingEconomics(decision)} -> ${decision.action}`;
	if (status.state === "inactive") return `Stopped (${details})`;
	if (status.state === "refreshing") return `Warming cache (${details})`;
	return `${formatCacheWarmingDecisionTime(status.nextWarmAt, now)} (${details})`;
}

/** One-line transcript text for persisted cache-warming usage. */
export function formatCacheWarmingUsage(entry: UsageEntry): string {
	const note = entry.note ? ` (${entry.note})` : "";
	const cost = entry.usage.cost.total.toFixed(6).replace(/(\.\d{3}\d*?)0+$/, "$1");
	return `Cache warmed${note}: $${cost}`;
}
