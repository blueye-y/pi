// DeepSeek provider extension for pi.
//
// Implements the official DeepSeek API (https://api-docs.deepseek.com/zh-cn/)
// as a pi provider, following the extension standards in
// @earendil-works/pi-coding-agent/docs/extensions.md and custom-provider.md:
//
//   • Three API modes, switchable via /deepseek → "API Format":
//       - openai-completions : POST https://api.deepseek.com/chat/completions
//       - anthropic-messages : POST https://api.deepseek.com/anthropic/v1/messages
//       - openai-responses   : POST https://api.deepseek.com/responses
//   • Dynamic model list   : GET /models (live, with offline cache fallback)
//   • Balance query        : GET /user/balance (command + LLM tool)
//   • Image understanding  : deepseek-v4-flash-vision-exp (JPEG/PNG/GIF/WebP)
//   • Thinking mode        : thinking: {type: enabled/disabled} +
//                            reasoning_effort / output_config.effort /
//                            reasoning.effort per format (docs: effort defaults high)
//
// Doc reference (all values below come from the official docs):
//   - Base URLs:   OpenAI `https://api.deepseek.com`, Anthropic `https://api.deepseek.com/anthropic`
//   - Models:      deepseek-v4-flash, deepseek-v4-pro, deepseek-v4-flash-vision-exp
//   - Context:     1M tokens, max output 384K tokens
//   - Effort map:  low→low, medium→high, high→high, xhigh→high, max→max

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type Api,
	type AssistantMessage,
	type Context,
	calculateCost,
	createAssistantMessageEventStream,
	type ImageContent,
	type Model,
	type SimpleStreamOptions,
	type TextContent,
	type ThinkingContent,
	type ToolCall,
	type ToolResultMessage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── Paths ─────────────────────────────────────────────────────────────
const HOME_DIR = path.join(os.homedir(), ".pi", "agent");
const CONFIG_PATH = path.join(HOME_DIR, "deepseek-config.json");
const AUTH_PATH = path.join(HOME_DIR, "auth.json");
const MODELS_CACHE_PATH = path.join(HOME_DIR, "deepseek-models.cache.json");
const PRICES_CACHE_PATH = path.join(HOME_DIR, "deepseek-prices.cache.json");

// ── Price sync source (official pricing page, USD per 1M tokens) ─────
// DeepSeek's official /models does not return pricing, so costs are parsed
// from the official pricing docs (English page — USD, matching pi's $ cost
// display). Off-peak rates are used: pi's cost model has no time-of-day
// dimension, and off-peak covers most request hours (peak is Mon-Fri
// 01:00-04:00 + 06:00-10:00 UTC only).
const PRICING_URL = "https://api-docs.deepseek.com/quick_start/pricing";

// ── Official endpoints (api-docs.deepseek.com/zh-cn) ──────────────────
const BASE_URL = "https://api.deepseek.com"; // OpenAI-compatible (chat/completions + /responses)
const ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic"; // Anthropic-compatible

// ── Model constants from the official docs ────────────────────────────
// 上下文长度 1M，输出长度最大 384K（deepseek-v4 系列三个模型一致）。
const CONTEXT_WINDOW = 1_000_000;
const MAX_OUTPUT_TOKENS = 384_000;

type ApiFormat = "anthropic-messages" | "openai-completions" | "openai-responses";

interface DeepSeekConfig {
	/** Which API shape to use for every model. Default: "openai-completions". */
	apiFormat?: ApiFormat;
	/** OpenAI-compatible base URL override (proxies/gateways). Default: https://api.deepseek.com */
	baseUrl?: string;
	/** Anthropic-compatible base URL override. Default: https://api.deepseek.com/anthropic */
	anthropicBaseUrl?: string;
	/** Include the experimental vision model (deepseek-v4-flash-vision-exp) in the list. Default: true. */
	showVisionModel?: boolean;
	/** Show the account balance in the footer status line. Default: true. */
	showBalanceInStatus?: boolean;
	/** Override the context-window shown on a model's card, keyed by model id; "*" = all. */
	contextWindowOverrides?: Record<string, number>;
}

// ── Official model catalog ────────────────────────────────────────────
// ── Official model catalog (offline fallback) ────────────────────────
// USD per 1M tokens from the official docs, both periods (peak = 2× off-peak
// on weekdays UTC 01:00-04:00 + 06:00-10:00). Only used when the pricing
// page sync above fails and no cached prices exist.
type ModelRates = { input: number; output: number; cacheRead: number; cacheWrite: number };

interface PeriodCosts {
	offPeak: ModelRates;
	peak: ModelRates;
}

interface KnownModelDef {
	id: string;
	name: string;
	vision?: boolean;
	cost: PeriodCosts;
}

const KNOWN_MODELS: KnownModelDef[] = [
	{
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		cost: {
			offPeak: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 },
			peak: { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0 },
		},
	},
	{
		id: "deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		cost: {
			offPeak: { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 },
			peak: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
		},
	},
	{
		id: "deepseek-v4-flash-vision-exp",
		name: "DeepSeek V4 Flash Vision (exp)",
		vision: true,
		cost: {
			offPeak: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 },
			peak: { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0 },
		},
	},
];

const DEFAULT_COST = KNOWN_MODELS[0].cost;

// ── Peak/off-peak period (official docs: peak = weekdays 01:00-04:00 +
// 06:00-10:00 UTC; all other hours off-peak) ─────────────────────────
function currentDeepSeekPeriod(): "peak" | "offPeak" {
	const now = new Date();
	const day = now.getUTCDay(); // 0=Sun..6=Sat
	if (day === 0 || day === 6) return "offPeak";
	const h = now.getUTCHours();
	return (h >= 1 && h < 4) || (h >= 6 && h < 10) ? "peak" : "offPeak";
}

// ── Thinking level maps ───────────────────────────────────────────────
// Official effort mapping table (deepseek-v4-flash 与 deepseek-v4-pro 一致):
//   low → low, medium → high, high → high, xhigh → high, max → max
// "minimal" is not a documented DeepSeek effort → hidden (null).
const EFFORT_MAP: Record<string, string | null> = {
	minimal: null,
	low: "low",
	medium: "high",
	high: "high",
	xhigh: "high",
	max: "max",
};

// Per-format thinking controls (docs "思考模式" table):
//   OpenAI 格式:   {"thinking":{"type":"enabled/disabled"}} + {"reasoning_effort":"low/high/max"}
//   Anthropic 格式: {"thinking":{"type":"enabled/disabled"}} + {"output_config":{"effort":"low/high/max"}}
//   Responses API:  {"reasoning":{"effort":"none/low/high/max"}}  (none 关闭思考)
function thinkingMapFor(format: ApiFormat): Record<string, string | null> {
	if (format === "openai-responses") return { off: "none", ...EFFORT_MAP };
	return { off: "disabled", ...EFFORT_MAP };
}

// ── Config / auth helpers (same conventions as extensions/alibaba.ts) ──
const readJSON = <T>(p: string, fallback: T): T => {
	try {
		return JSON.parse(fs.readFileSync(p, "utf8")) as T;
	} catch {
		return fallback;
	}
};
const writeJSON = (p: string, data: unknown) => {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 });
};
const loadConfig = (): DeepSeekConfig => readJSON<DeepSeekConfig>(CONFIG_PATH, {});
const saveConfig = (c: DeepSeekConfig) => writeJSON(CONFIG_PATH, c);
// auth.json stores pi credentials as { type: "api_key", key } under the provider id.
interface AuthEntry {
	type?: string;
	key?: string;
	access?: string;
}
const readAuth = (): Record<string, AuthEntry> => readJSON<Record<string, AuthEntry>>(AUTH_PATH, {});
const writeAuth = (a: Record<string, AuthEntry>) => writeJSON(AUTH_PATH, a);
// Key resolution: auth.json["deepseek"] (saved by /login → "Use an API key")
// or the $DEEPSEEK_API_KEY env var (also the provider-level apiKey reference).
function readKey(): string | null {
	try {
		const cred = readAuth().deepseek;
		const k = cred?.key || cred?.access;
		if (k) return k;
	} catch {}
	return process.env.DEEPSEEK_API_KEY || null;
}

// ── Model list (GET /models) ──────────────────────────────────────────
interface ModelsCache {
	fetchedAt: number;
	ids: string[];
}

// Live fetch — returns null on any failure so callers can fall back.
async function fetchModelIds(apiKey: string, baseUrl: string): Promise<string[] | null> {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), 8000);
	try {
		const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: ctrl.signal,
		});
		if (!res.ok) return null;
		const json = (await res.json()) as { data?: { id?: string }[] };
		const ids = (json.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
		return ids.length ? ids : null;
	} catch {
		return null;
	} finally {
		clearTimeout(t);
	}
}

const cacheAgeMin = (fetchedAt: number) => Math.round((Date.now() - fetchedAt) / 60000);

// Merge strategy: known catalog (always present so the provider never
// vanishes) ∪ live /models ids. The vision model is documented in the
// official docs but not always returned by /models, so it is merged in
// when showVisionModel is enabled.
async function loadModelIds(
	_force: boolean,
	apiKey: string | null,
	baseUrl: string,
	showVision: boolean,
): Promise<string[]> {
	let live: string[] | null = null;
	if (apiKey) live = await fetchModelIds(apiKey, baseUrl);
	const cache = readJSON<ModelsCache | null>(MODELS_CACHE_PATH, null);
	if (live) {
		writeJSON(MODELS_CACHE_PATH, { fetchedAt: Date.now(), ids: live });
	} else if (!cache?.ids?.length) {
		console.warn(`[deepseek] /models fetch failed${apiKey ? "" : " (no API key)"}; using the built-in catalog.`);
	} else {
		console.warn(
			`[deepseek] /models fetch failed; using cached models (${cache.ids.length}, ${cacheAgeMin(cache.fetchedAt)}m old).`,
		);
	}

	const ids = new Set<string>(cache?.ids?.length ? cache.ids : []);
	for (const m of KNOWN_MODELS) {
		if (m.vision && !showVision) continue;
		ids.add(m.id);
	}
	return [...ids];
}

// ── Balance (GET /user/balance) ───────────────────────────────────────
interface BalanceInfo {
	currency: string;
	total_balance: string;
	granted_balance: string;
	topped_up_balance: string;
}
interface BalanceResponse {
	is_available: boolean;
	balance_infos: BalanceInfo[];
}

async function fetchBalance(apiKey: string, baseUrl: string): Promise<BalanceResponse | null> {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), 8000);
	try {
		const res = await fetch(`${baseUrl.replace(/\/$/, "")}/user/balance`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: ctrl.signal,
		});
		if (!res.ok) return null;
		return (await res.json()) as BalanceResponse;
	} catch {
		return null;
	} finally {
		clearTimeout(t);
	}
}

function formatBalance(b: BalanceResponse): string {
	const lines = [`DeepSeek balance — available: ${b.is_available ? "yes" : "NO"}`];
	for (const info of b.balance_infos ?? []) {
		lines.push(
			`  ${info.currency}: total ${info.total_balance} (granted ${info.granted_balance} + topped-up ${info.topped_up_balance})`,
		);
	}
	if (!b.balance_infos?.length) lines.push("  (no balance info returned)");
	return lines.join("\n");
}

// ── Price sync (official pricing page, USD per 1M tokens) ────────────
// Runs once per extension load (pi startup and /reload). Official /models
// does not return pricing, so costs are parsed from the official pricing
// docs (English page). Both peak and off-peak rate sets are kept; the
// active set follows the UTC clock (see currentDeepSeekPeriod). Failures
// fall back to the last synced cache, then to the hardcoded KNOWN_MODELS
// below.
interface PriceCache {
	fetchedAt: number;
	prices: Record<string, KnownModelDef["cost"]>;
}

// Parse the pricing table from the official docs page (Docusaurus SSR HTML).
// Row order is fixed: CACHE HIT (off-peak, peak), CACHE MISS (off-peak, peak),
// OUTPUT (off-peak, peak), each with one $ value per model. Both periods are
// kept so the extension can switch rates at the peak/off-peak boundary.
// Returns null when the page no longer matches the expected shape, so callers
// fall back to cache/hardcoded.
function parseOfficialPricingHtml(page: string): Record<string, PeriodCosts> | null {
	const modelMatch = page.match(
		/>MODEL<\/td><td>(deepseek-[a-z0-9-]+)<\/td><td>(deepseek-[a-z0-9-]+)<\/td><td>(deepseek-[a-z0-9-]+)<\/td>/,
	);
	if (!modelMatch) return null;
	const ids = modelMatch.slice(1);
	const start = page.indexOf("PRICING");
	const end = page.indexOf("Concurrency Limit");
	if (start === -1 || end === -1 || end <= start) return null;
	const dollars = page.slice(start, end).match(/\$([0-9.]+)/g);
	if (!dollars || dollars.length !== 18) return null;
	const nums = dollars.map((d) => parseFloat(d.slice(1)));
	// Layout: [cacheHit offPeak×3, cacheHit peak×3, cacheMiss offPeak×3, cacheMiss peak×3, output offPeak×3, output peak×3]
	const prices: Record<string, PeriodCosts> = {};
	for (let i = 0; i < ids.length; i++) {
		prices[ids[i]] = {
			offPeak: {
				input: nums[i + 6], // cache-miss off-peak
				output: nums[i + 12], // output off-peak
				cacheRead: nums[i], // cache-hit off-peak
				cacheWrite: 0,
			},
			peak: {
				input: nums[i + 9], // cache-miss peak
				output: nums[i + 15], // output peak
				cacheRead: nums[i + 3], // cache-hit peak
				cacheWrite: 0,
			},
		};
	}
	return prices;
}

async function fetchOfficialPrices(): Promise<Record<string, PeriodCosts> | null> {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), 10000);
	try {
		const res = await fetch(PRICING_URL, { signal: ctrl.signal });
		if (!res.ok) return null;
		return parseOfficialPricingHtml(await res.text());
	} catch {
		return null;
	} finally {
		clearTimeout(t);
	}
}

async function loadSyncedPrices(): Promise<Record<string, PeriodCosts>> {
	const live = await fetchOfficialPrices();
	const cache = readJSON<PriceCache | null>(PRICES_CACHE_PATH, null);
	if (live) {
		writeJSON(PRICES_CACHE_PATH, { fetchedAt: Date.now(), prices: live });
		return live;
	}
	if (cache?.prices && Object.keys(cache.prices).length) {
		console.warn(`[deepseek] official pricing page fetch failed; using cached prices (${cacheAgeMin(cache.fetchedAt)}m old).`);
		return cache.prices;
	}
	console.warn("[deepseek] official pricing page fetch failed; using built-in documented prices.");
	return {};
}

let syncedPrices: Record<string, PeriodCosts> = {};
let activePricePeriod: "peak" | "offPeak" = "offPeak";

// Cost lookup order: live/cached synced price → hardcoded catalog → DEFAULT_COST,
// always picking the rate set for the current period.
function modelCost(id: string, period: "peak" | "offPeak"): ModelRates {
	return syncedPrices[id]?.[period] ?? KNOWN_MODELS.find((m) => m.id === id)?.cost[period] ?? DEFAULT_COST[period];
}

// ── Balance status line (footer, via ctx.ui.setStatus) ────────────────
const BALANCE_STATUS_KEY = "deepseek-balance";
const BALANCE_STATUS_REFRESH_MS = 15 * 60_000;
let balanceStatusTimer: ReturnType<typeof setInterval> | null = null;
let statusUI: ExtensionUIContext | null = null;

const CURRENCY_SYMBOLS: Record<string, string> = { CNY: "¥", USD: "$" };

// Compact single-line rendering for the footer, e.g. "DS ¥12.34" or "DS $2.05".
function formatBalanceStatus(b: BalanceResponse): string {
	const parts = (b.balance_infos ?? []).map((info) => {
		const sym = CURRENCY_SYMBOLS[info.currency];
		return sym ? `${sym}${info.total_balance}` : `${info.total_balance} ${info.currency}`;
	});
	if (!parts.length) return "DS balance n/a";
	return `DS ${parts.join("/")}`;
}

// Refresh the footer status line. Clears it when there is no key, the feature
// is disabled, or the fetch fails (stale numbers are worse than none).
async function updateBalanceStatus(): Promise<void> {
	if (!statusUI) return;
	const key = readKey();
	if (loadConfig().showBalanceInStatus === false || !key) {
		statusUI.setStatus(BALANCE_STATUS_KEY, undefined);
		return;
	}
	const balance = await fetchBalance(key, (loadConfig().baseUrl || BASE_URL).replace(/\/$/, ""));
	if (!balance || !balance.is_available) {
		statusUI.setStatus(BALANCE_STATUS_KEY, undefined);
		return;
	}
	statusUI.setStatus(BALANCE_STATUS_KEY, formatBalanceStatus(balance));
}

function startBalanceStatusTimer(tick: () => void): void {
	if (balanceStatusTimer) return;
	balanceStatusTimer = setInterval(tick, BALANCE_STATUS_REFRESH_MS);
}

function stopBalanceStatusTimer(): void {
	if (balanceStatusTimer) {
		clearInterval(balanceStatusTimer);
		balanceStatusTimer = null;
	}
}

// ── Peak/off-peak boundary scheduler ─────────────────────────────────
// Fires exactly at each transition (weekdays 01:00/04:00/06:00/10:00 UTC),
// re-registering the provider when the period actually changed. Re-arms from
// `now` after firing, so sleep/drift self-corrects; the longest gap between
// boundaries is Fri 10:00 UTC → Mon 01:00 UTC (63h), well under setTimeout's
// 24.8-day overflow cap.
let priceBoundaryTimer: ReturnType<typeof setTimeout> | null = null;

function nextBoundaryTime(from: Date): Date {
	const boundaryHours = [1, 4, 6, 10]; // UTC, weekdays only
	for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
		const d = new Date(from.getTime() + dayOffset * 86400_000);
		const day = d.getUTCDay();
		if (day === 0 || day === 6) continue; // weekend has no boundaries
		for (const h of boundaryHours) {
			const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, 0, 0, 0);
			if (t > from.getTime()) return new Date(t);
		}
	}
	// Unreachable (a weekday boundary always exists within 8 days); defensive.
	return new Date(from.getTime() + 7 * 86400_000);
}

function startPriceBoundaryScheduler(onBoundary: () => void): void {
	if (priceBoundaryTimer) return;
	const arm = (): void => {
		const now = new Date();
		const delay = Math.max(0, nextBoundaryTime(now).getTime() - now.getTime());
		priceBoundaryTimer = setTimeout(() => {
			priceBoundaryTimer = null;
			onBoundary(); // the period check inside avoids redundant re-registration
			arm();
		}, delay);
	};
	arm();
}

function stopPriceBoundaryScheduler(): void {
	if (priceBoundaryTimer) {
		clearTimeout(priceBoundaryTimer);
		priceBoundaryTimer = null;
	}
}

// ── Model definition builder ──────────────────────────────────────────
function prettyName(id: string): string {
	return id
		.replace(/^deepseek-/i, "DeepSeek ")
		.replace(/-/g, " ")
		.replace(/\b([a-z])/g, (s) => s.toUpperCase());
}

function buildModels(ids: string[], format: ApiFormat, cfg: DeepSeekConfig, period: "peak" | "offPeak"): ProviderModelConfig[] {
	const overrides = cfg.contextWindowOverrides ?? {};
	const openaiBase = (cfg.baseUrl || BASE_URL).replace(/\/$/, "");
	const anthropicBase = (cfg.anthropicBaseUrl || ANTHROPIC_BASE_URL).replace(/\/$/, "");
	return ids.map((id) => {
		const known = KNOWN_MODELS.find((m) => m.id === id);
		const ctx = overrides[id] ?? overrides["*"];
		const compat =
			format === "openai-completions"
				? {
						thinkingFormat: "deepseek" as const,
						supportsReasoningEffort: true,
						requiresReasoningContentOnAssistantMessages: true,
					}
				: format === "openai-responses"
					? { supportsDeveloperRole: false } // DeepSeek 将 developer 视同 user（官方文档）
					: {};
		return {
			id,
			name: known?.name ?? prettyName(id),
			reasoning: true, // 官方文档：思考模式默认打开，三个模型均支持
			input: known?.vision ? (["text", "image"] as ("text" | "image")[]) : (["text"] as ("text" | "image")[]),
			cost: modelCost(id, period),
			contextWindow: typeof ctx === "number" && ctx > 0 ? ctx : CONTEXT_WINDOW,
			maxTokens: MAX_OUTPUT_TOKENS,
			api: format,
			baseUrl: format === "anthropic-messages" ? anthropicBase : openaiBase,
			compat,
			thinkingLevelMap: thinkingMapFor(format),
		};
	});
}

// ── Custom Anthropic-format streaming (doc-faithful) ──────────────────
// DeepSeek 的 Anthropic 兼容 API 与官方 Anthropic 的差异（官方文档 "Anthropic
// API 兼容性细节"）：thinking.type 只接受 enabled/disabled（budget_tokens 被忽略），
// 思考强度通过 output_config.effort 控制，因此这里用自定义 streamSimple 精确发送
// {"thinking":{"type":"enabled"}} + {"output_config":{"effort":"..."}}。

// Local helpers (kept private so the extension only depends on public pi exports).
function headersToRecord(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	headers.forEach((v, k) => {
		out[k] = v;
	});
	return out;
}

function sanitizeSurrogates(text: string): string {
	// Replace lone surrogates (Anthropic/DeepSeek reject unpaired UTF-16 units).
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

interface AnthropicUsage {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
	output_tokens_details?: { thinking_tokens?: number };
}

interface AnthropicSSEEvent {
	type: string;
}
interface AnthropicMessageStartEvent extends AnthropicSSEEvent {
	type: "message_start";
	message?: { id?: string; model?: string; usage?: AnthropicUsage };
}
interface AnthropicContentBlockStartEvent extends AnthropicSSEEvent {
	type: "content_block_start";
	index: number;
	content_block?: {
		type?: string;
		text?: string;
		thinking?: string;
		signature?: string;
		id?: string;
		name?: string;
		input?: Record<string, unknown>;
	};
}
interface AnthropicContentBlockDeltaEvent extends AnthropicSSEEvent {
	type: "content_block_delta";
	index: number;
	delta?: {
		type?: string;
		text?: string;
		thinking?: string;
		partial_json?: string;
		signature?: string;
	};
}
interface AnthropicContentBlockStopEvent extends AnthropicSSEEvent {
	type: "content_block_stop";
	index: number;
}
interface AnthropicMessageDeltaEvent extends AnthropicSSEEvent {
	type: "message_delta";
	delta?: { stop_reason?: string };
	usage?: AnthropicUsage;
}
interface AnthropicErrorEvent extends AnthropicSSEEvent {
	type: "error";
	error?: { message?: string };
}

type AnthropicStreamEvent =
	| AnthropicMessageStartEvent
	| AnthropicContentBlockStartEvent
	| AnthropicContentBlockDeltaEvent
	| AnthropicContentBlockStopEvent
	| AnthropicMessageDeltaEvent
	| AnthropicErrorEvent;

async function* iterateSSE(
	body: ReadableStream<Uint8Array> | null,
	signal?: AbortSignal,
): AsyncGenerator<AnthropicStreamEvent> {
	if (!body) return;
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			// SSE frames are separated by blank lines.
			let idx = buffer.indexOf("\n\n");
			while (idx !== -1) {
				const frame = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);
				let eventType = "message";
				const dataLines: string[] = [];
				for (const line of frame.split("\n")) {
					if (line.startsWith("event:")) eventType = line.slice(6).trim();
					else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
				}
				const data = dataLines.join("\n");
				if (data) {
					try {
						const parsed = JSON.parse(data) as Record<string, unknown>;
						yield { type: eventType, ...parsed } as AnthropicStreamEvent;
					} catch {}
				}
				idx = buffer.indexOf("\n\n");
			}
		}
		if (buffer.trim()) {
			// Final frame without trailing blank line.
			let _eventType = "message";
			const dataLines: string[] = [];
			for (const line of buffer.split("\n")) {
				if (line.startsWith("event:")) _eventType = line.slice(6).trim();
				else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
			}
			const data = dataLines.join("\n");
			if (data) {
				try {
					yield JSON.parse(data) as AnthropicStreamEvent;
				} catch {}
			}
		}
	} finally {
		reader.releaseLock();
		void signal;
	}
}

// Anthropic stop_reason → pi StopReason
function mapStopReason(reason: string): "stop" | "length" | "toolUse" | "deferred" | "error" {
	switch (reason) {
		case "end_turn":
		case "stop_sequence":
			return "stop";
		case "max_tokens":
			return "length";
		case "tool_use":
			return "toolUse";
		case "pause_turn":
			return "deferred";
		default:
			return "error";
	}
}

function parseAnthropicError(body: string, status: number): string {
	try {
		const json = JSON.parse(body) as {
			error?: { message?: string; type?: string };
		};
		const msg = json.error?.message;
		if (msg) return `DeepSeek API error ${status}: ${msg}`;
	} catch {}
	return `DeepSeek API error ${status}: ${body.slice(0, 300)}`;
}

type AnthropicBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string; signature?: string }
	| {
			type: "tool_use";
			id: string;
			name: string;
			input: Record<string, unknown>;
	  }
	| {
			type: "tool_result";
			tool_use_id: string;
			content: string;
			is_error?: boolean;
	  };

function convertToAnthropicMessages(
	messages: Context["messages"],
): Array<{ role: string; content: string | AnthropicBlock[] }> {
	const out: Array<{ role: string; content: string | AnthropicBlock[] }> = [];
	for (const msg of messages) {
		if (msg.role === "user") {
			const blocks = toAnthropicBlocks(msg);
			if (blocks.length === 0) continue;
			out.push({ role: "user", content: blocks });
		} else if (msg.role === "assistant") {
			const blocks: AnthropicBlock[] = [];
			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length === 0) continue;
					blocks.push({ type: "text", text: sanitizeSurrogates(block.text) });
				} else if (block.type === "thinking") {
					// 官方文档：thinking 内容块支持。签名（signature）非必须，仅在已有时回传。
					if (block.thinking.trim().length === 0 && !block.thinkingSignature) continue;
					const tb: AnthropicBlock & { signature?: string } = {
						type: "thinking",
						thinking: sanitizeSurrogates(block.thinking),
					};
					if (block.thinkingSignature) tb.signature = block.thinkingSignature;
					blocks.push(tb);
				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: block.name,
						input: block.arguments ?? {},
					});
				}
			}
			if (blocks.length === 0) continue;
			out.push({ role: "assistant", content: blocks });
		} else if (msg.role === "toolResult") {
			const tr = msg as ToolResultMessage;
			out.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: tr.toolCallId,
						content: toolResultText(tr),
						is_error: tr.isError,
					},
				],
			});
		}
	}
	return out;
}

function toAnthropicBlocks(msg: UserMessage): AnthropicBlock[] {
	if (typeof msg.content === "string") {
		return msg.content.trim() ? [{ type: "text", text: sanitizeSurrogates(msg.content) }] : [];
	}
	const blocks: AnthropicBlock[] = [];
	for (const item of msg.content) {
		if (item.type === "text") {
			if (item.text.trim().length === 0) continue;
			blocks.push({ type: "text", text: sanitizeSurrogates(item.text) });
		} else {
			// 图像理解：base64 source（官方文档：jpeg/png/gif/webp 由实际内容判断）。
			const img = item as ImageContent;
			// SAFETY: AnthropicBlock 只列出消息 content 中出现的块类型；image 块（type:
			// "image" + source.base64）在此按已知字段构造，shape 与 Anthropic/DeepSeek
			// 文档一致，其余字段未被消费，因此这里把未收窄为联合成员的 object 字面量
			// 断言为 AnthropicBlock 是安全的。
			blocks.push({
				type: "image",
				source: { type: "base64", media_type: img.mimeType, data: img.data },
			} as unknown as AnthropicBlock);
		}
	}
	return blocks;
}

function toolResultText(tr: ToolResultMessage): string {
	const parts: string[] = [];
	for (const block of tr.content) {
		if (block.type === "text") parts.push(block.text);
		// Images in tool results are not supported by the Anthropic format here;
		// note their presence so the model knows an image was attached.
		else parts.push(`[image: ${(block as ImageContent).mimeType}]`);
	}
	const text = parts.join("\n");
	return tr.isError && text.trim().length === 0 ? "Error: tool execution failed" : text;
}

function streamDeepSeekAnthropic(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): ReturnType<typeof createAssistantMessageEventStream> {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new Error("DeepSeek API key is missing — run /login → DeepSeek or set $DEEPSEEK_API_KEY");
			}

			const baseUrl = (model.baseUrl || ANTHROPIC_BASE_URL).replace(/\/$/, "");
			const maxTokens = Math.min(
				Math.max(1, options?.maxTokens ?? model.maxTokens),
				model.contextWindow > 0 ? model.contextWindow : MAX_OUTPUT_TOKENS,
			);

			// ── Request body (Anthropic format, DeepSeek-compatible) ──
			const body: Record<string, unknown> = {
				model: model.id,
				max_tokens: maxTokens,
				stream: true,
			};
			if (context.systemPrompt?.trim()) body.system = context.systemPrompt;
			if (options?.temperature !== undefined) body.temperature = options.temperature;
			if (options?.metadata?.user_id !== undefined) body.metadata = { user_id: options.metadata.user_id };

			// 思考模式开关与强度（官方文档）：
			//   thinking: {"type": "enabled"/"disabled"}（默认打开，budget_tokens 被忽略）
			//   output_config: {"effort": "low/high/max"}
			// 思考模式开关与强度（官方文档）：
			//   thinking: {"type": "enabled"/"disabled"}（默认打开，budget_tokens 被忽略）
			//   output_config: {"effort": "low/high/max"}
			// options.reasoning 为 undefined 时表示关闭思考（pi 的 agent 在 thinkingLevel
			// 为 off 时传 undefined）；有级别时开启并映射到 DeepSeek effort。
			const level = options?.reasoning;
			if (model.reasoning) {
				if (level) {
					body.thinking = { type: "enabled" };
					const mapped = model.thinkingLevelMap?.[level];
					if (typeof mapped === "string") body.output_config = { effort: mapped };
				} else {
					body.thinking = { type: "disabled" };
				}
			}

			body.messages = convertToAnthropicMessages(context.messages);

			if (context.tools?.length) {
				body.tools = context.tools.map((t) => ({
					name: t.name,
					description: t.description ?? "",
					input_schema: t.parameters as Record<string, unknown>,
				}));
				// tool_choice: streamSimple 不接收 toolChoice（pi-ai 0.84.x），保持 auto。
			}

			const res = await fetch(`${baseUrl}/v1/messages`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-api-key": apiKey, // 官方文档：x-api-key 完全支持
					"anthropic-version": "2023-06-01", // 官方文档：被忽略，保留以兼容 Anthropic 客户端
				},
				body: JSON.stringify(body),
				signal: options?.signal,
			});

			await options?.onResponse?.({ status: res.status, headers: headersToRecord(res.headers) }, model);
			stream.push({ type: "start", partial: output });

			if (!res.ok) {
				const errText = await res.text();
				throw new Error(parseAnthropicError(errText, res.status));
			}

			type Block = (TextContent | ThinkingContent | (ToolCall & { partialJson: string })) & { index: number };
			const blocks = output.content as Block[];

			for await (const event of iterateSSE(res.body, options?.signal)) {
				if (event.type === "message_start") {
					output.responseId = event.message?.id;
					if (event.message?.model) output.model = event.message.model;
					const u = event.message?.usage;
					if (u) {
						output.usage.input = u.input_tokens ?? 0;
						output.usage.cacheRead = u.cache_read_input_tokens ?? 0;
						output.usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
					}
				} else if (event.type === "content_block_start") {
					const cb = event.content_block;
					if (cb?.type === "text") {
						const block: Block = {
							type: "text",
							text: cb.text ?? "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({
							type: "text_start",
							contentIndex: output.content.length - 1,
							partial: output,
						});
					} else if (cb?.type === "thinking") {
						const block: Block = {
							type: "thinking",
							thinking: cb.thinking ?? "",
							thinkingSignature: cb.signature ?? "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({
							type: "thinking_start",
							contentIndex: output.content.length - 1,
							partial: output,
						});
					} else if (cb?.type === "tool_use") {
						const block: Block = {
							type: "toolCall",
							id: cb.id ?? "",
							name: cb.name ?? "",
							arguments: cb.input ?? {},
							partialJson: "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({
							type: "toolcall_start",
							contentIndex: output.content.length - 1,
							partial: output,
						});
					}
				} else if (event.type === "content_block_delta") {
					const d = event.delta;
					if (!d) continue;
					const index = blocks.findIndex((b) => b.index === event.index);
					if (index === -1) continue;
					const block = blocks[index];
					if (d.type === "text_delta" && block.type === "text") {
						block.text += d.text ?? "";
						stream.push({
							type: "text_delta",
							contentIndex: index,
							delta: d.text ?? "",
							partial: output,
						});
					} else if (d.type === "thinking_delta" && block.type === "thinking") {
						block.thinking += d.thinking ?? "";
						stream.push({
							type: "thinking_delta",
							contentIndex: index,
							delta: d.thinking ?? "",
							partial: output,
						});
					} else if (d.type === "input_json_delta" && block.type === "toolCall") {
						block.partialJson += d.partial_json ?? "";
						block.arguments = parseStreamingJson(block.partialJson);
						stream.push({
							type: "toolcall_delta",
							contentIndex: index,
							delta: d.partial_json ?? "",
							partial: output,
						});
					} else if (d.type === "signature_delta" && block.type === "thinking") {
						block.thinkingSignature = (block.thinkingSignature || "") + (d.signature ?? "");
					}
				} else if (event.type === "content_block_stop") {
					const index = blocks.findIndex((b) => b.index === event.index);
					const block = blocks[index];
					if (!block) continue;
					delete (block as any).index;
					if (block.type === "text") {
						stream.push({
							type: "text_end",
							contentIndex: index,
							content: block.text,
							partial: output,
						});
					} else if (block.type === "thinking") {
						stream.push({
							type: "thinking_end",
							contentIndex: index,
							content: block.thinking,
							partial: output,
						});
					} else if (block.type === "toolCall") {
						block.arguments = parseStreamingJson(block.partialJson);
						delete (block as { partialJson?: string }).partialJson;
						stream.push({
							type: "toolcall_end",
							contentIndex: index,
							toolCall: block,
							partial: output,
						});
					}
				} else if (event.type === "message_delta") {
					if (event.delta?.stop_reason) {
						output.rawStopReason = event.delta.stop_reason;
						output.stopReason = mapStopReason(event.delta.stop_reason);
					}
					const u = event.usage;
					if (u) {
						if (u.output_tokens != null) output.usage.output = u.output_tokens;
						if (u.cache_read_input_tokens != null) output.usage.cacheRead = u.cache_read_input_tokens;
						if (u.cache_creation_input_tokens != null) output.usage.cacheWrite = u.cache_creation_input_tokens;
						const details = u.output_tokens_details;
						if (details?.thinking_tokens != null) output.usage.reasoning = details.thinking_tokens;
					}
				} else if (event.type === "error") {
					const msg = event.error?.message ?? "DeepSeek Anthropic stream error";
					throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
				}
				// "ping" and unknown events are ignored.
			}

			if (options?.signal?.aborted) throw new Error("Request was aborted");

			if (output.stopReason === "pending") {
				throw new Error("DeepSeek stream ended without a stop reason");
			}

			output.usage.totalTokens =
				output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
			calculateCost(model, output.usage);

			if (output.stopReason === "error" || output.stopReason === "aborted") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

function parseStreamingJson(input: string): Record<string, unknown> {
	if (!input.trim()) return {};
	try {
		const parsed = JSON.parse(input);
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}

// ── Module state ──────────────────────────────────────────────────────
let modelIds: string[] = [];

export default async function (pi: ExtensionAPI) {
	// Always re-read the config so registerProvider reflects the latest settings
	// (format changes land via /deepseek → saveConfig → ctx.reload()).
	const registerProvider = () => {
		const cfg = loadConfig();
		const format: ApiFormat = cfg.apiFormat ?? "openai-completions";
		const openaiBase = (cfg.baseUrl || BASE_URL).replace(/\/$/, "");
		const anthropicBase = (cfg.anthropicBaseUrl || ANTHROPIC_BASE_URL).replace(/\/$/, "");
		// Pick the rate set for the current period; re-registering mid-session on a
		// period change swaps the active model's cost (agent-session refreshes the
		// current model from the registry after registerProvider).
		activePricePeriod = currentDeepSeekPeriod();
		pi.registerProvider("deepseek", {
			name: "DeepSeek",
			baseUrl: format === "anthropic-messages" ? anthropicBase : openaiBase,
			apiKey: "$DEEPSEEK_API_KEY",
			api: format,
			authHeader: true,
			models: buildModels(modelIds, format, cfg, activePricePeriod),
			streamSimple: format === "anthropic-messages" ? streamDeepSeekAnthropic : undefined,
		});
	};

	// Re-register when the peak/off-peak boundary crossed. Scheduled to fire
	// exactly at each boundary (see startPriceBoundaryScheduler); the period
	// check here also covers sleep/drift — a late fire still converges.
	const refreshPricePeriod = (): void => {
		if (currentDeepSeekPeriod() === activePricePeriod) return;
		registerProvider();
	};

	// ── Live catalog fetch (before provider registration) ──────────────
	const cfg0 = loadConfig();
	modelIds = await loadModelIds(
		true,
		readKey(),
		(cfg0.baseUrl || BASE_URL).replace(/\/$/, ""),
		cfg0.showVisionModel !== false,
	);
	// ── Price sync: once per extension load (startup and /reload) ──────
	syncedPrices = await loadSyncedPrices();
	registerProvider();
	// Fire exactly at each peak/off-peak boundary (weekdays 01:00/04:00/06:00/10:00 UTC).
	startPriceBoundaryScheduler(() => refreshPricePeriod());
	// ── Lazy refresh on session start + balance status line ─────────────
	pi.on("session_start", async (_event, ctx) => {
		try {
			const currentKey = readKey();
			const c = loadConfig();
			modelIds = await loadModelIds(
				false,
				currentKey,
				(c.baseUrl || BASE_URL).replace(/\/$/, ""),
				c.showVisionModel !== false,
			);
			registerProvider();
			startPriceBoundaryScheduler(() => refreshPricePeriod()); // no-op when already running
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			console.warn(`[deepseek] session_start catalog refresh failed (${msg}); keeping previously loaded models.`);
		}
		// Footer status line: show the account balance, refreshed on a timer.
		statusUI = ctx.ui;
		void updateBalanceStatus();
		startBalanceStatusTimer(() => { void updateBalanceStatus(); });
	});

	// ── Refresh the footer balance after each completed conversation round ─
	// agent_settled fires once per agent run — after the last turn and once no
	// retry/compaction is pending — so this is one balance GET per user message,
	// not one per internal tool-loop turn. The 15-minute timer stays as a fallback
	// for idle time (e.g. top-ups while the session is just sitting there).
	pi.on("agent_settled", () => {
		void updateBalanceStatus();
	});

	// ── Stop the timers when the session shuts down ─────────────────────
	pi.on("session_shutdown", () => {
		stopBalanceStatusTimer();
		stopPriceBoundaryScheduler();
		statusUI?.setStatus(BALANCE_STATUS_KEY, undefined);
		statusUI = null;
	});

	// ── Tool: balance query (GET /user/balance) ────────────────────────
	pi.registerTool({
		name: "deepseek_balance",
		label: "DeepSeek Balance",
		description:
			"Query the DeepSeek account balance via GET /user/balance: is_available plus per-currency " +
			"(CNY/USD) total, granted and topped-up balances. Use when the user asks about DeepSeek " +
			"account balance, credits, or quota.",
		promptSnippet: "Check the DeepSeek account balance (GET /user/balance)",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate) {
			const k = readKey();
			if (!k) {
				return {
					content: [
						{
							type: "text",
							text: "No DeepSeek API key found — run /login → DeepSeek or set $DEEPSEEK_API_KEY.",
						},
					],
					details: { ok: false },
				};
			}
			const balance = await fetchBalance(k, (loadConfig().baseUrl || BASE_URL).replace(/\/$/, ""));
			if (!balance) {
				return {
					content: [
						{
							type: "text",
							text: "Failed to fetch DeepSeek balance (GET /user/balance). Check the API key and network.",
						},
					],
					details: { ok: false },
				};
			}
			return {
				content: [{ type: "text", text: formatBalance(balance) }],
				details: { ok: true, balance },
			};
		},
	});

	// ── Command: /deepseek ─────────────────────────────────────────────
	pi.registerCommand("deepseek", {
		description: "Manage DeepSeek configuration (API format, models, balance)",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			const choice = await ctx.ui.select("DeepSeek:", [
				"Status",
				"Refresh model list",
				"API Format",
				"Balance",
				"Balance in status bar — toggle",
				"Re-login",
				"Base URL — override",
				"Vision model — toggle",
				"Context Window — override",
				"Reset all",
			]);
			if (!choice) return;

			const c = loadConfig();
			const auth = readAuth();
			const cred = auth.deepseek;

			if (choice === "Status") {
				const cache = readJSON<ModelsCache | null>(MODELS_CACHE_PATH, null);
				const age = cache ? cacheAgeMin(cache.fetchedAt) : null;
				const state = cache?.ids?.length ? `live/cached, ${age}m old` : "built-in catalog";
				ctx.ui.notify(
					[
						`Auth:   ${cred ? "logged in" : process.env.DEEPSEEK_API_KEY ? "via $DEEPSEEK_API_KEY" : "not logged in"}`,
						`Format: ${c.apiFormat ?? "openai-completions (default)"}`,
						`Base:   ${(c.baseUrl || BASE_URL).replace(/\/$/, "")}`,
						`Anthro: ${(c.anthropicBaseUrl || ANTHROPIC_BASE_URL).replace(/\/$/, "")}`,
						`Models: ${modelIds.length} (${state})`,
						`Vision: ${c.showVisionModel === false ? "hidden" : "on (deepseek-v4-flash-vision-exp)"}`,
						`Price:  ${Object.keys(syncedPrices).length} models synced from official pricing page (${activePricePeriod === "offPeak" ? "off-peak" : "peak"} now) / built-in fallback`,
						`Status: ${c.showBalanceInStatus === false ? "balance line off" : "balance line on (refresh 15m + after each run)"}`,
					].join("\n"),
					"info",
				);
				return;
			}

			if (choice === "Refresh model list") {
				const k = readKey();
				if (!k) {
					ctx.ui.notify("No DeepSeek API key — run /login → DeepSeek first.", "error");
					return;
				}
				const base = (c.baseUrl || BASE_URL).replace(/\/$/, "");
				const ids = await fetchModelIds(k, base);
				if (ids) {
					writeJSON(MODELS_CACHE_PATH, { fetchedAt: Date.now(), ids });
					modelIds = [...new Set([...ids, ...KNOWN_MODELS.map((m) => m.id)])];
					ctx.ui.notify(`Fetched ${ids.length} models from GET /models.`, "info");
					await ctx.reload();
				} else {
					ctx.ui.notify("GET /models failed — check the API key and network.", "error");
				}
				return;
			}

			if (choice === "API Format") {
				const sel = await ctx.ui.select("DeepSeek API format:", [
					"OpenAI Chat Completions (recommended)",
					"Anthropic Messages",
					"OpenAI Responses (latest)",
				]);
				if (!sel) return;
				c.apiFormat = sel.startsWith("Anthropic")
					? "anthropic-messages"
					: sel.startsWith("OpenAI Responses")
						? "openai-responses"
						: "openai-completions";
				saveConfig(c);
				ctx.ui.notify(`DeepSeek API format: ${c.apiFormat}`, "info");
				await ctx.reload();
				return;
			}

			if (choice === "Balance") {
				const k = readKey();
				if (!k) {
					ctx.ui.notify("No DeepSeek API key — run /login → DeepSeek or set $DEEPSEEK_API_KEY.", "error");
					return;
				}
				const balance = await fetchBalance(k, (c.baseUrl || BASE_URL).replace(/\/$/, ""));
				ctx.ui.notify(
					balance ? formatBalance(balance) : "GET /user/balance failed — check the API key and network.",
					balance ? "info" : "error",
				);
				// Also refresh the footer status line right away.
				statusUI = ctx.ui;
				void updateBalanceStatus();
				return;
			}

			if (choice === "Balance in status bar — toggle") {
				const next = c.showBalanceInStatus === false;
				c.showBalanceInStatus = next;
				saveConfig(c);
				statusUI = ctx.ui;
				if (next) void updateBalanceStatus();
				else ctx.ui.setStatus(BALANCE_STATUS_KEY, undefined);
				ctx.ui.notify(`Balance in status bar: ${next ? "on" : "off"}`, "info");
				return;
			}

			if (choice === "Re-login") {
				if (!(await ctx.ui.confirm("Wipe DeepSeek credentials and re-login?", "Removes deepseek from auth.json")))
					return;
				const a = readAuth();
				delete a.deepseek;
				writeAuth(a);
				ctx.ui.notify("DeepSeek credentials wiped. Run /login → Use an API key → DeepSeek.", "info");
				await ctx.reload();
				return;
			}

			if (choice === "Base URL — override") {
				const o = (await ctx.ui.input(`OpenAI-compatible base URL (current: ${c.baseUrl || BASE_URL}):`))?.trim();
				if (o === undefined) return;
				if (o === "") delete c.baseUrl;
				else c.baseUrl = o;
				const a = (
					await ctx.ui.input(
						`Anthropic-compatible base URL (current: ${c.anthropicBaseUrl || ANTHROPIC_BASE_URL}):`,
					)
				)?.trim();
				if (a === undefined) return;
				if (a === "") delete c.anthropicBaseUrl;
				else c.anthropicBaseUrl = a;
				saveConfig(c);
				ctx.ui.notify("DeepSeek base URLs updated.", "info");
				await ctx.reload();
				return;
			}

			if (choice === "Vision model — toggle") {
				const next = c.showVisionModel === false;
				c.showVisionModel = next;
				saveConfig(c);
				ctx.ui.notify(`Vision model (deepseek-v4-flash-vision-exp): ${next ? "shown" : "hidden"}`, "info");
				await ctx.reload();
				return;
			}

			if (choice === "Context Window — override") {
				const ov = c.contextWindowOverrides || {};
				const fmt = (n: number) => n.toLocaleString();
				const labelToId = new Map<string, string>();
				const opts: string[] = [];
				for (const id of [...new Set([...modelIds, ...KNOWN_MODELS.map((m) => m.id)])].sort()) {
					const label = ov[id] ? `${id}  (override: ${fmt(ov[id])})` : id;
					labelToId.set(label, id);
					opts.push(label);
				}
				const allLabel = ov["*"] ? `* every other model  (override: ${fmt(ov["*"])})` : "* every other model";
				labelToId.set(allLabel, "*");
				opts.push(allLabel);
				const CLEAR = "Clear all overrides";
				opts.push(CLEAR);

				const sel = await ctx.ui.select("Override context window for:", opts);
				if (!sel) return;
				if (sel === CLEAR) {
					delete c.contextWindowOverrides;
					saveConfig(c);
					ctx.ui.notify("Cleared all context-window overrides.", "info");
					await ctx.reload();
					return;
				}
				const id = labelToId.get(sel) ?? sel;
				const val = (
					await ctx.ui.input(`Context window for ${id} in tokens (default 1,000,000; 0 removes the override):`)
				)?.trim();
				if (!val) return;
				const n = Number(val.replace(/[_,\s]/g, ""));
				if (!Number.isFinite(n) || n < 0) {
					ctx.ui.notify("Enter a non-negative number of tokens (0 removes the override).", "error");
					return;
				}
				c.contextWindowOverrides = c.contextWindowOverrides || {};
				if (n === 0) delete c.contextWindowOverrides[id];
				else c.contextWindowOverrides[id] = Math.floor(n);
				if (Object.keys(c.contextWindowOverrides).length === 0) delete c.contextWindowOverrides;
				saveConfig(c);
				ctx.ui.notify(`Context window for ${id} set to ${fmt(Math.floor(n))} tokens.`, "info");
				await ctx.reload();
				return;
			}

			if (choice === "Reset all") {
				if (
					!(await ctx.ui.confirm(
						"Reset all DeepSeek settings?",
						"Wipes deepseek-config.json, the models/prices caches, and the deepseek entry in auth.json.",
					))
				)
					return;
				for (const p of [CONFIG_PATH, MODELS_CACHE_PATH, PRICES_CACHE_PATH]) {
					try {
						fs.unlinkSync(p);
					} catch {}
				}
				syncedPrices = {};
				statusUI?.setStatus(BALANCE_STATUS_KEY, undefined);
				const a = readAuth();
				delete a.deepseek;
				writeAuth(a);
				ctx.ui.notify("All DeepSeek settings wiped.", "info");
				await ctx.reload();
				return;
			}
		},
	});
}
