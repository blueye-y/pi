// Zhipu (智谱 GLM) provider extension for pi.
//
// Overrides pi's built-in "zai-coding-cn" (智谱开放平台, open.bigmodel.cn) and
// "zai" (Z.AI international, api.z.ai) providers so the built-in /login flow
// keeps working unchanged — the api-key login and its auth.json entries
// (`zai-coding-cn` / `zai`, or the $ZAI_CODING_CN_API_KEY / $ZAI_API_KEY env
// vars) are inherited from the built-in providers, exactly like the deepseek
// extension reuses pi's default DeepSeek login.
//
// What this extension adds over the built-ins:
//   • Dynamic model list : GET /models (live, with offline cache fallback)
//   • Live model specs   : context window / max output / vision / thinking
//                          parsed from the official docs .md pages (7-day
//                          cache); prices stay on the documented catalog
//                          below (智谱's pricing page has no static source)
//   • Documented prices  : CNY (CN) / USD (intl) per 1M tokens for the known
//                          catalog; unknown ids fall back to default rates
//   • Capability defaults: context window / max output / vision / thinking
//                          filled per id (known catalog + pattern matching)
//   • Two billing modes, switchable via /zhipu → "Mode":
//       - coding-plan : https://open.bigmodel.cn/api/coding/paas/v4
//                       (subscription quota; intl: https://api.z.ai/api/coding/paas/v4)
//       - api         : https://open.bigmodel.cn/api/paas/v4
//                       (pay-per-token; intl: https://api.z.ai/api/paas/v4)
//
// Only the OpenAI Chat Completions shape is used — the same shape as pi's
// built-in zai providers (thinking format "zai", zaiToolStream, max_tokens),
// so no custom streaming is needed.
//
// Doc reference (docs.bigmodel.cn, 2026-08):
//   - GLM-5.3: 1M context / 128K max output; thinking ALWAYS enabled and
//     cannot be disabled; reasoning_effort low|high|max (default max).
//   - GLM-5.3-Flash: 1M context, multimodal (vision), cheaper.
//   - GLM-5.2: 1M context; GLM-5.1 / GLM-5 / GLM-5-Turbo / GLM-4.7: 200K.
//   - API prices (CNY per 1M tokens): GLM-5.3/5.2 ¥8 in / ¥28 out / ¥2 cache
//     hit; GLM-5 ¥4 / ¥18 / ¥1; GLM-5.3-Flash ¥0.8 / ¥2.8 / ¥0.23.
//   - Note: 智谱's pricing page (bigmodel.cn/pricing) is a JS-rendered console
//     page with no public static source, so prices come from the documented
//     table below rather than a live page parse.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

// ── Paths ─────────────────────────────────────────────────────────────
const HOME_DIR = path.join(os.homedir(), ".pi", "agent");
const CONFIG_PATH = path.join(HOME_DIR, "zhipu-config.json");
const AUTH_PATH = path.join(HOME_DIR, "auth.json");
const MODELS_CACHE_PATH = path.join(HOME_DIR, "zhipu-models.cache.json");

type ZhipuMode = "coding-plan" | "api";

interface ZhipuConfig {
	/** Billing mode for both regions. Default: "coding-plan" (subscription quota). */
	mode?: ZhipuMode;
	/** Include fast/free models (glm-*-flash, glm-*-free). Default: true. */
	showFlash?: boolean;
	/** OpenAI-compatible base URL override per provider id ("zai-coding-cn"/"zai"). */
	baseUrlOverrides?: Record<string, string>;
	/** Override the context-window shown on a model's card, keyed by model id; "*" = all. */
	contextWindowOverrides?: Record<string, number>;
}

// ── Regions ───────────────────────────────────────────────────────────
interface RegionDef {
	providerId: "zai-coding-cn" | "zai";
	name: string;
	envKey: string;
	codingPlanBase: string;
	apiBase: string;
	currency: "CNY" | "USD";
}

const REGIONS: RegionDef[] = [
	{
		providerId: "zai-coding-cn",
		name: "智谱 GLM (CN)",
		envKey: "ZAI_CODING_CN_API_KEY",
		codingPlanBase: "https://open.bigmodel.cn/api/coding/paas/v4",
		apiBase: "https://open.bigmodel.cn/api/paas/v4",
		currency: "CNY",
	},
	{
		providerId: "zai",
		name: "Z.AI GLM (intl)",
		envKey: "ZAI_API_KEY",
		codingPlanBase: "https://api.z.ai/api/coding/paas/v4",
		apiBase: "https://api.z.ai/api/paas/v4",
		currency: "USD",
	},
];

const regionById = (id: string): RegionDef => REGIONS.find((r) => r.providerId === id) ?? REGIONS[0];

function openaiBase(region: RegionDef, mode: ZhipuMode): string {
	return mode === "api" ? region.apiBase : region.codingPlanBase;
}

// ── Config / auth helpers (same conventions as extensions/deepseek.ts) ──
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
const loadConfig = (): ZhipuConfig => readJSON<ZhipuConfig>(CONFIG_PATH, {});
const saveConfig = (c: ZhipuConfig) => writeJSON(CONFIG_PATH, c);

// auth.json stores pi credentials as { type: "api_key", key } under the
// provider id — the entries pi's own /login writes for Z.AI / Z.AI Coding CN.
interface AuthEntry {
	type?: string;
	key?: string;
	access?: string;
}
const readAuth = (): Record<string, AuthEntry> => readJSON<Record<string, AuthEntry>>(AUTH_PATH, {});
const writeAuth = (a: Record<string, AuthEntry>) => writeJSON(AUTH_PATH, a);

// Key resolution: auth.json[providerId] (saved by /login → "Use an API key")
// or the provider's env var.
function readKey(providerId: string): string | null {
	// readAuth never throws (readJSON falls back to {}), so no try/catch needed.
	const cred = readAuth()[providerId];
	const k = cred?.key || cred?.access;
	if (k) return k;
	return process.env[regionById(providerId).envKey] || null;
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

type ModelsCacheMap = Record<string, ModelsCache>;
const readModelsCache = (): ModelsCacheMap => readJSON<ModelsCacheMap>(MODELS_CACHE_PATH, {});
const writeModelsCache = (regionId: string, ids: string[]) => {
	const all = readModelsCache();
	all[regionId] = { fetchedAt: Date.now(), ids };
	writeJSON(MODELS_CACHE_PATH, all);
};

// ── Spec sync (official docs .md pages, 7-day TTL) ───────────────────
// 智谱's pricing page is a JS console with no static source, so prices stay
// hardcoded (KNOWN_MODELS below), but model SPECS (context window, max
// output, vision, thinking) are parsed live from the official docs pages
// (docs.bigmodel.cn serves every model page as markdown). Discovery goes
// through the model-overview page which links all model pages.
const SPECS_INDEX_URL = "https://docs.bigmodel.cn/cn/guide/start/model-overview.md";
const SPECS_CACHE_PATH = path.join(HOME_DIR, "zhipu-specs.cache.json");
const SPECS_REFRESH_MS = 7 * 86400_000;

/** Model ids that share another model's docs page (no page of their own). */
const SPEC_PAGE_ALIASES: Record<string, string> = {
	"glm-4.7-flashx": "glm-4.7",
	"glm-4.5-air": "glm-4.5",
	"glm-4.1v-thinking-flashx": "glm-4.1v-thinking",
};

/** Partial spec parsed from a docs page; missing fields fall back to the catalog. */
interface SyncedSpec {
	ctx?: number;
	maxOut?: number;
	vision?: boolean;
	alwaysThinking?: boolean;
	effort?: boolean;
}
interface SpecsCache {
	fetchedAt: number;
	specs: Record<string, SyncedSpec>;
}

async function fetchText(url: string, timeoutMs: number): Promise<string | null> {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, { signal: ctrl.signal });
		if (!res.ok) return null;
		return await res.text();
	} catch {
		return null;
	} finally {
		clearTimeout(t);
	}
}

// Card value helper: the value sits on the first content line after the
// <Card title="…"> line (the icon SVG stays on the title line).
function cardValue(md: string, title: string): string | null {
	const m = md.match(new RegExp(`Card title="${title}"[^\n]*\ns*([^\n<]+?)s*\n`));
	return m ? m[1].trim() : null;
}

function parseSpecFromMarkdown(md: string): SyncedSpec | null {
	const toTokens = (s: string | null): number | null => {
		if (!s) return null;
		const m = s.match(/(\d+(?:\.\d+)?)\s*([KkMm])/);
		if (!m) return null;
		return Math.round(parseFloat(m[1]) * (m[2].toLowerCase() === "m" ? 1_000_000 : 1_000));
	};

	const spec: SyncedSpec = {};

	// Context window: 上下文窗口 Card → "1M 上下文窗口" → "上下文…提升到 128K"
	const ctx =
		toTokens(cardValue(md, "上下文窗口")) ??
		toTokens((md.match(/(\d+(?:\.\d+)?)\s*([KkMm])\s*上下文/) ?? [null, null])[0]) ??
		toTokens((md.match(/上下文(?:长度|窗口)[^\d\n]{0,12}?(\d+(?:\.\d+)?)\s*([KkMm])/) ?? [null, null, null])[0]);
	if (ctx) spec.ctx = ctx;

	// Max output: 最大输出 Tokens / 最大输出 Card → "最大输出 Tokens 为 128K"
	const outCard = toTokens(cardValue(md, "最大输出 Tokens")) ?? toTokens(cardValue(md, "最大输出"));
	const outProse = md.match(/最大输出(?:的)?\s*(?:Tokens?)?\s*(?:为|：|:)?\s*(\d+(?:\.\d+)?)\s*([KkMm])/);
	if (outCard) spec.maxOut = outCard;
	else if (outProse)
		spec.maxOut = Math.round(parseFloat(outProse[1]) * (outProse[2].toLowerCase() === "m" ? 1_000_000 : 1_000));

	// Vision: 输入模态 Card value (视频、图像、文本、文件 …) or prose
	const inputModal = cardValue(md, "输入模态");
	if (inputModal) spec.vision = /图像|视频|视觉|多模态|图片/.test(inputModal);
	else spec.vision = /输入模态[^\n]*[图像视频视觉多模态]/.test(md);

	// Thinking
	spec.alwaysThinking = /始终启用思考|不支持禁用思考|仅支持开启思考/.test(md);
	spec.effort = /reasoning_effort/.test(md);

	if (!spec.ctx && !spec.maxOut && spec.vision === undefined && !spec.alwaysThinking && !spec.effort) return null;
	return spec;
}

// Fetch every known model's docs page (bounded concurrency) and parse specs.
async function syncSpecs(): Promise<Record<string, SyncedSpec>> {
	const index = await fetchText(SPECS_INDEX_URL, 10_000);
	const pageUrls = new Map<string, string>();
	if (index) {
		for (const m of index.matchAll(/\/cn\/guide\/models\/[a-z-]+\/([a-z0-9.-]+)(?:\.md)?/g)) {
			const pageId = m[1].toLowerCase();
			if (!pageUrls.has(pageId))
				pageUrls.set(pageId, `https://docs.bigmodel.cn${m[0]}${m[0].endsWith(".md") ? "" : ".md"}`);
		}
	}

	const targets = new Map<string, string>();
	for (const id of KNOWN_MODELS.map((m) => m.id)) {
		const url = pageUrls.get(id) ?? pageUrls.get(SPEC_PAGE_ALIASES[id]);
		if (url) targets.set(id, url);
	}
	if (!targets.size) return {};

	const specs: Record<string, SyncedSpec> = {};
	const entries = [...targets.entries()];
	let next = 0;
	const CONCURRENCY = 4;
	const worker = async (): Promise<void> => {
		for (;;) {
			const i = next++;
			if (i >= entries.length) return;
			const [id, url] = entries[i];
			const md = await fetchText(url, 10_000);
			if (!md) continue;
			const spec = parseSpecFromMarkdown(md);
			if (spec) specs[id] = spec;
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, () => worker()));
	return specs;
}

// Spec load: fresh cache (7d TTL) → live sync → stale cache → built-in catalog.
async function loadSyncedSpecs(force: boolean): Promise<Record<string, SyncedSpec>> {
	const cache = readJSON<SpecsCache | null>(SPECS_CACHE_PATH, null);
	if (!force && cache?.specs && Object.keys(cache.specs).length && Date.now() - cache.fetchedAt < SPECS_REFRESH_MS) {
		return cache.specs;
	}
	const live = await syncSpecs();
	if (Object.keys(live).length) {
		writeJSON(SPECS_CACHE_PATH, { fetchedAt: Date.now(), specs: live });
		return live;
	}
	if (cache?.specs && Object.keys(cache.specs).length) {
		console.warn(`[zhipu] spec sync failed; using cached specs (${cacheAgeMin(cache.fetchedAt)}m old).`);
		return cache.specs;
	}
	console.warn("[zhipu] spec sync failed; using the built-in catalog specs.");
	return {};
}

let syncedSpecs: Record<string, SyncedSpec> = {};

// Merge strategy: known catalog (always present so the provider never
// vanishes) ∪ live /models ids. Not logged in → no network at all.
async function loadModelIds(region: RegionDef, cfg: ZhipuConfig): Promise<string[]> {
	const apiKey = readKey(region.providerId);
	const base = (cfg.baseUrlOverrides?.[region.providerId] || openaiBase(region, cfg.mode ?? "coding-plan")).replace(
		/\/$/,
		"",
	);
	let live: string[] | null = null;
	if (apiKey) live = await fetchModelIds(apiKey, base);
	const cache = readModelsCache()[region.providerId];
	if (live) {
		writeModelsCache(region.providerId, live);
	} else if (!cache?.ids?.length && apiKey) {
		console.warn(`[zhipu] ${region.providerId} /models fetch failed; using the built-in catalog.`);
	}

	// Live ids win over the (pre-write) cache so brand-new models appear on the
	// very first successful fetch instead of waiting for the next load.
	const merged = live ?? cache?.ids ?? [];
	const ids = new Set<string>(merged.length ? merged : []);
	for (const m of KNOWN_MODELS) {
		if (cfg.showFlash === false && /flash|free/i.test(m.id)) continue;
		ids.add(m.id);
	}
	return [...ids];
}

// ── Model catalog (documented specs + prices) ─────────────────────────
// Prices in CNY/USD per 1M tokens: input (cache miss) / output / cache hit.
type ModelRates = { input: number; output: number; cacheRead: number; cacheWrite: number };

interface KnownModelDef {
	id: string;
	name: string;
	vision?: boolean;
	/** Thinking is always enabled and cannot be disabled (GLM-5.3). */
	alwaysThinking?: boolean;
	/** Accepts reasoning_effort (low/high/max). */
	effort?: boolean;
	ctx: number;
	maxOut: number;
	/** Prices per 1M tokens by currency. Missing → DEFAULT_COST. */
	cost?: Partial<Record<"CNY" | "USD", ModelRates>>;
}

const KNOWN_MODELS: KnownModelDef[] = [
	{
		id: "glm-5.3",
		name: "GLM-5.3",
		alwaysThinking: true,
		effort: true,
		ctx: 1_000_000,
		maxOut: 131_072,
		cost: {
			CNY: { input: 8, output: 28, cacheRead: 2, cacheWrite: 0 },
			USD: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
		},
	},
	{
		id: "glm-5.3-flash",
		name: "GLM-5.3 Flash",
		vision: true,
		ctx: 1_000_000,
		maxOut: 131_072,
		cost: {
			CNY: { input: 0.8, output: 2.8, cacheRead: 0.23, cacheWrite: 0 },
		},
	},
	{
		id: "glm-5.2",
		name: "GLM-5.2",
		effort: true,
		ctx: 1_000_000,
		maxOut: 131_072,
		cost: {
			CNY: { input: 8, output: 28, cacheRead: 2, cacheWrite: 0 },
			USD: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
		},
	},
	{
		id: "glm-5.1",
		name: "GLM-5.1",
		ctx: 200_000,
		maxOut: 131_072,
		cost: {
			CNY: { input: 4, output: 18, cacheRead: 1, cacheWrite: 0 },
		},
	},
	{
		id: "glm-5",
		name: "GLM-5",
		ctx: 200_000,
		maxOut: 131_072,
		cost: {
			CNY: { input: 4, output: 18, cacheRead: 1, cacheWrite: 0 },
		},
	},
	{
		id: "glm-5-turbo",
		name: "GLM-5 Turbo",
		ctx: 200_000,
		maxOut: 131_072,
	},
	{
		id: "glm-4.7",
		name: "GLM-4.7",
		ctx: 200_000,
		maxOut: 131_072,
	},
	{
		id: "glm-4.7-flashx",
		name: "GLM-4.7 FlashX",
		ctx: 200_000,
		maxOut: 131_072,
	},
	{
		id: "glm-4.7-flash",
		name: "GLM-4.7 Flash",
		ctx: 200_000,
		maxOut: 131_072,
		cost: { CNY: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
	},
	{
		id: "glm-4.6",
		name: "GLM-4.6",
		ctx: 200_000,
		maxOut: 131_072,
	},
	{
		id: "glm-4.5-air",
		name: "GLM-4.5 Air",
		ctx: 128_000,
		maxOut: 98_304,
	},
	{
		id: "glm-4.5-flash",
		name: "GLM-4.5 Flash",
		ctx: 128_000,
		maxOut: 98_304,
		cost: { CNY: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
	},
	{
		id: "glm-5v-turbo",
		name: "GLM-5V Turbo",
		vision: true,
		ctx: 200_000,
		maxOut: 131_072,
	},
	{
		id: "glm-4.6v",
		name: "GLM-4.6V",
		vision: true,
		ctx: 128_000,
		maxOut: 32_768,
	},
	{
		id: "glm-4.6v-flash",
		name: "GLM-4.6V Flash",
		vision: true,
		ctx: 128_000,
		maxOut: 32_768,
		cost: { CNY: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
	},
	{
		id: "glm-4.1v-thinking-flashx",
		name: "GLM-4.1V Thinking FlashX",
		vision: true,
		ctx: 64_000,
		maxOut: 16_384,
	},
	{
		id: "glm-4.1v-thinking-flash",
		name: "GLM-4.1V Thinking Flash",
		vision: true,
		ctx: 64_000,
		maxOut: 16_384,
	},
];

// Unknown live ids are assumed cheap until known, like the deepseek extension
// defaults unknown models to the flash rates.
const DEFAULT_COST: Record<"CNY" | "USD", ModelRates> = {
	CNY: { input: 0.8, output: 2.8, cacheRead: 0.23, cacheWrite: 0 },
	USD: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
};

function modelCost(id: string, currency: "CNY" | "USD"): ModelRates {
	const known = KNOWN_MODELS.find((m) => m.id === id);
	// Only fall back within the same currency — mixing ¥ into the USD region (or
	// vice versa) would misreport cost.
	return known?.cost?.[currency] ?? DEFAULT_COST[currency];
}

// ── Capability defaults for ids /models returns but the catalog lacks ──
interface Capability {
	ctx: number;
	maxOut: number;
	vision: boolean;
	alwaysThinking: boolean;
	effort: boolean;
}

// Fallbacks by id pattern (documented model families), used for unknown live
// ids and for spec fields the docs pages don't report.
function patternCapability(id: string): Capability {
	const vision = /glm-5v|glm-4\.\d+v/i.test(id);
	const alwaysThinking = /^glm-5\.3$/i.test(id);
	const effort = /^glm-5\.3$|^glm-5\.2$/i.test(id);
	let ctx = 200_000;
	let maxOut = 131_072;
	if (/1m|long/i.test(id)) {
		ctx = 1_000_000;
		maxOut = /long/i.test(id) ? 4_096 : maxOut;
	} else if (/glm-4\.1v/i.test(id)) {
		ctx = 64_000;
		maxOut = 16_384;
	} else if (/glm-4\.5-air|glm-4\.5-flash|glm-4\.6v/i.test(id)) {
		ctx = 128_000;
		maxOut = /glm-4\.6v/i.test(id) ? 32_768 : 98_304;
	}
	return { ctx, maxOut, vision, alwaysThinking, effort };
}

// Effective capability: synced docs spec → known catalog → id patterns.
// Live specs win so the extension tracks docs changes without an update;
// missing spec fields fall back to the catalog, then to patterns.
function capabilityFor(id: string): Capability {
	const spec = syncedSpecs[id];
	const known = KNOWN_MODELS.find((m) => m.id === id);
	const pattern = patternCapability(id);
	return {
		ctx: spec?.ctx ?? known?.ctx ?? pattern.ctx,
		maxOut: spec?.maxOut ?? known?.maxOut ?? pattern.maxOut,
		vision: spec?.vision ?? known?.vision ?? pattern.vision,
		alwaysThinking: spec?.alwaysThinking ?? known?.alwaysThinking ?? pattern.alwaysThinking,
		effort: spec?.effort ?? known?.effort ?? pattern.effort,
	};
}

// ── Thinking level maps ───────────────────────────────────────────────
// ZAI reasoning_effort values are low/high/max. GLM-5.3 always thinks and
// rejects thinking.type "disabled" → hide "off" for it; other models map
// off → "disabled" like the deepseek extension.
const EFFORT_MAP: Record<string, string | null> = {
	minimal: null,
	low: "low",
	medium: "high",
	high: "high",
	xhigh: "max",
	max: "max",
};
function thinkingMapFor(alwaysThinking: boolean): Record<string, string | null> {
	return alwaysThinking ? { off: null, ...EFFORT_MAP } : { off: "disabled", ...EFFORT_MAP };
}

// ── Model definition builder ──────────────────────────────────────────
function prettyName(id: string): string {
	return id
		.replace(/^glm-/i, "GLM ")
		.replace(/-/g, " ")
		.replace(/\b([a-z])/g, (s) => s.toUpperCase());
}

function buildModels(region: RegionDef, ids: string[], cfg: ZhipuConfig): ProviderModelConfig[] {
	const overrides = cfg.contextWindowOverrides ?? {};
	const base = (cfg.baseUrlOverrides?.[region.providerId] || openaiBase(region, cfg.mode ?? "coding-plan")).replace(
		/\/$/,
		"",
	);
	return ids.map((id) => {
		const known = KNOWN_MODELS.find((m) => m.id === id);
		const cap = capabilityFor(id);
		const ctx = overrides[id] ?? overrides["*"] ?? cap.ctx;
		return {
			id,
			name: known?.name ?? prettyName(id),
			reasoning: true,
			input: cap.vision ? (["text", "image"] as ("text" | "image")[]) : (["text"] as ("text" | "image")[]),
			cost: modelCost(id, region.currency),
			contextWindow: typeof ctx === "number" && ctx > 0 ? ctx : cap.ctx,
			maxTokens: cap.maxOut,
			api: "openai-completions",
			baseUrl: base,
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: cap.effort,
				maxTokensField: "max_tokens",
				thinkingFormat: "zai",
				zaiToolStream: true,
			},
			thinkingLevelMap: thinkingMapFor(cap.alwaysThinking),
		};
	});
}

// ── Module state ──────────────────────────────────────────────────────
const modelIds: Record<string, string[]> = {};

export default async function (pi: ExtensionAPI) {
	// Always re-read the config so registerProvider reflects the latest
	// settings (mode changes land via /zhipu → saveConfig → ctx.reload()).
	const registerProviders = () => {
		const cfg = loadConfig();
		for (const region of REGIONS) {
			const base = (
				cfg.baseUrlOverrides?.[region.providerId] || openaiBase(region, cfg.mode ?? "coding-plan")
			).replace(/\/$/, "");
			pi.registerProvider(region.providerId, {
				name: region.name,
				baseUrl: base,
				apiKey: `$${region.envKey}`,
				api: "openai-completions",
				authHeader: true,
				models: buildModels(region, modelIds[region.providerId] ?? [], cfg),
			});
		}
	};

	// ── Live catalog + spec fetch (before provider registration) ───────
	const cfg0 = loadConfig();
	for (const region of REGIONS) {
		modelIds[region.providerId] = await loadModelIds(region, cfg0);
	}
	// Spec sync (context/max output/vision/thinking from the docs pages):
	// only when logged in — not logged in means no startup requests at all.
	if (readKey("zai-coding-cn") || readKey("zai")) {
		syncedSpecs = await loadSyncedSpecs(false);
	}
	registerProviders();

	// ── Lazy refresh on session start ──────────────────────────────────
	pi.on("session_start", async () => {
		try {
			const c = loadConfig();
			for (const region of REGIONS) {
				modelIds[region.providerId] = await loadModelIds(region, c);
			}
			registerProviders();
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			console.warn(`[zhipu] session_start catalog refresh failed (${msg}); keeping previously loaded models.`);
		}
	});

	// ── Command: /zhipu ────────────────────────────────────────────────
	pi.registerCommand("zhipu", {
		description: "Manage Zhipu GLM configuration (mode, models, regions)",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			const choice = await ctx.ui.select("Zhipu GLM:", [
				"Status",
				"Refresh model lists",
				"Mode — Coding Plan / API",
				"Re-login",
				"Base URL — override",
				"Context Window — override",
				"Reset all",
			]);
			if (!choice) return;

			const c = loadConfig();
			const auth = readAuth();

			if (choice === "Status") {
				const lines: string[] = [
					`Mode:    ${c.mode ?? "coding-plan (default)"}`,
					`Flash:   ${c.showFlash === false ? "hidden" : "on"}`,
					`Specs:   ${Object.keys(syncedSpecs).length} models synced from docs (7d TTL) / built-in fallback`,
				];
				for (const region of REGIONS) {
					const cred = auth[region.providerId];
					const cache = readModelsCache()[region.providerId];
					const age = cache ? cacheAgeMin(cache.fetchedAt) : null;
					const state = cache?.ids?.length ? `live/cached, ${age}m old` : "built-in catalog";
					lines.push(
						`${region.name}: ${cred ? "logged in" : process.env[region.envKey] ? `via $${region.envKey}` : "not logged in"}`,
					);
					lines.push(
						`  Base:    ${(c.baseUrlOverrides?.[region.providerId] || openaiBase(region, c.mode ?? "coding-plan")).replace(/\/$/, "")}`,
					);
					lines.push(`  Models:  ${(modelIds[region.providerId] ?? []).length} (${state})`);
				}
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (choice === "Refresh model lists") {
				const missing = REGIONS.filter((r) => !readKey(r.providerId));
				if (missing.length) {
					ctx.ui.notify(
						`Not logged in: ${missing.map((r) => r.providerId).join(", ")}. Run /login → ${missing.map((r) => regionById(r.providerId).name).join(" / ")} first.`,
						"error",
					);
					return;
				}
				for (const region of REGIONS) {
					modelIds[region.providerId] = await loadModelIds(region, c);
				}
				syncedSpecs = await loadSyncedSpecs(true); // force: user asked explicitly
				registerProviders();
				ctx.ui.notify(
					`Fetched model lists (${REGIONS.map((r) => `${r.providerId}: ${(modelIds[r.providerId] ?? []).length}`).join(", ")}).`,
					"info",
				);
				await ctx.reload();
				return;
			}

			if (choice === "Mode — Coding Plan / API") {
				const sel = await ctx.ui.select("Zhipu billing mode:", [
					"Coding Plan — subscription quota (recommended)",
					"API — pay-per-token",
				]);
				if (!sel) return;
				c.mode = sel.startsWith("Coding Plan") ? "coding-plan" : "api";
				saveConfig(c);
				ctx.ui.notify(`Zhipu mode: ${c.mode}`, "info");
				await ctx.reload();
				return;
			}

			if (choice === "Re-login") {
				if (
					!(await ctx.ui.confirm(
						"Wipe Zhipu credentials and re-login?",
						"Removes zai-coding-cn and zai from auth.json",
					))
				)
					return;
				const a = readAuth();
				for (const region of REGIONS) delete a[region.providerId];
				writeAuth(a);
				ctx.ui.notify("Zhipu credentials wiped. Run /login → Use an API key → Z.AI Coding CN / Z.AI.", "info");
				await ctx.reload();
				return;
			}

			if (choice === "Base URL — override") {
				for (const region of REGIONS) {
					const current = c.baseUrlOverrides?.[region.providerId] || openaiBase(region, c.mode ?? "coding-plan");
					const o = (
						await ctx.ui.input(`OpenAI-compatible base URL for ${region.name} (current: ${current}):`)
					)?.trim();
					if (o === undefined) return;
					c.baseUrlOverrides = c.baseUrlOverrides || {};
					if (o === "") delete c.baseUrlOverrides[region.providerId];
					else c.baseUrlOverrides[region.providerId] = o;
				}
				if (c.baseUrlOverrides && Object.keys(c.baseUrlOverrides).length === 0) delete c.baseUrlOverrides;
				saveConfig(c);
				ctx.ui.notify("Zhipu base URLs updated.", "info");
				await ctx.reload();
				return;
			}

			if (choice === "Context Window — override") {
				const ov = c.contextWindowOverrides || {};
				const fmt = (n: number) => n.toLocaleString();
				const labelToId = new Map<string, string>();
				const opts: string[] = [];
				for (const id of [
					...new Set(
						Object.values(modelIds)
							.flat()
							.concat(KNOWN_MODELS.map((m) => m.id)),
					),
				].sort()) {
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
					await ctx.ui.input(
						`Context window for ${id} in tokens (default 200,000–1,000,000; 0 removes the override):`,
					)
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
						"Reset all Zhipu settings?",
						"Wipes zhipu-config.json, the models cache, and the zai/zai-coding-cn auth entries.",
					))
				)
					return;
				for (const p of [CONFIG_PATH, MODELS_CACHE_PATH]) {
					try {
						fs.unlinkSync(p);
					} catch {
						// File already gone — nothing to clean up.
					}
				}
				const a = readAuth();
				for (const region of REGIONS) delete a[region.providerId];
				writeAuth(a);
				ctx.ui.notify("All Zhipu settings wiped.", "info");
				await ctx.reload();
				return;
			}
		},
	});
}
