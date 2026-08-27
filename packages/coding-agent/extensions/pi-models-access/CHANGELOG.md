# Changelog

## [Unreleased]

## [1.2.0] - 2026-08-27

- **Zhipu GLM providers** (`extensions/zhipu.ts`, `/zhipu`): overrides pi's built-in `zai-coding-cn` (智谱开放平台, `open.bigmodel.cn`) and `zai` (Z.AI international, `api.z.ai`) providers so the built-in `/login → Z.AI Coding CN / Z.AI` flow keeps working unchanged (the `auth.json` entries and `$ZAI_CODING_CN_API_KEY` / `$ZAI_API_KEY` env vars are inherited from the built-ins, same as DeepSeek reuses pi's default login). Adds:
  - **Live model specs**: context window / max output / vision / thinking parsed from the official docs pages (`docs.bigmodel.cn` serves every model page as markdown; discovery through the model-overview index) — 7-day cache (`~/.pi/agent/zhipu-specs.cache.json`), synced specs override the built-in catalog, refreshed on startup (logged in only) and via `/zhipu → Refresh model lists`. Prices stay on the documented table.
  - **Two billing modes**, switchable via `/zhipu → Mode`: **Coding Plan** (subscription quota, `https://open.bigmodel.cn/api/coding/paas/v4`) or **API** (pay-per-token, `https://open.bigmodel.cn/api/paas/v4`); intl variants on `api.z.ai`. Both use the OpenAI Chat Completions shape (thinking format `zai`, `zaiToolStream`, `max_tokens`) — the same shape as the built-ins, so no custom streaming is needed.
  - **Dynamic model list**: `GET /models` at startup and `/zhipu → Refresh model lists`, with an offline cache fallback (`~/.pi/agent/zhipu-models.cache.json`) and the built-in catalog as last resort.
  - **Documented pricing** (CNY per 1M tokens; USD for intl): GLM-5.3/5.2 ¥8 in / ¥28 out / ¥2 cache hit, GLM-5 ¥4 / ¥18 / ¥1, GLM-5.3-Flash ¥0.8 / ¥2.8 / ¥0.23; unknown ids fall back to default rates. (智谱's pricing page is a JS-rendered console page with no public static source, so prices come from the documented table rather than a live page parse.)
  - **Capability defaults** filled per model id (context window / max output / vision / thinking): GLM-5.3 is 1M ctx with thinking **always on** (its `off` thinking level is hidden because the API rejects `thinking.type: disabled`); GLM-5.3-Flash / 5V / 4.6V / 4.1V models are flagged vision-capable; flash/free models can be hidden via `showFlash` in `zhipu-config.json`.
  - **`/zhipu` command**: Status, Refresh model lists, Mode, Re-login, Base URL override, Context Window override, Reset all.
- **DeepSeek: no startup requests when not logged in** (`extensions/deepseek.ts`): with no API key (no `auth.json` entry, no `$DEEPSEEK_API_KEY`), extension load and `session_start` no longer touch the network at all — the `/models` fetch and the official pricing-page sync are skipped and the cached list + built-in catalog are used instead (previously the pricing page was fetched on every startup regardless of login).

## [1.1.3] - 2026-08-23

- **Fresher footer balance** (`/deepseek`): the balance line now also refreshes after each
  completed conversation round (`agent_settled` — once per user message, after the last turn
  and once no retry/compaction is pending), so the footer number tracks actual spend
  immediately instead of waiting for the next 15-minute timer tick. The timer stays as a
  fallback for idle time.

## [1.1.2] - 2026-08-23

- **Price sync from the official pricing page** (`extensions/deepseek.ts`): model costs are parsed from [api-docs.deepseek.com/quick_start/pricing](https://api-docs.deepseek.com/quick_start/pricing) once per extension load (startup and `/reload`), replacing the stale models.dev values (those hadn't been updated since the V4 launch). Both **peak and off-peak** USD rates are cached (`~/.pi/agent/deepseek-prices.cache.json`) and the active set follows the UTC clock — peak is weekdays 01:00-04:00 + 06:00-10:00 UTC, exactly 2× off-peak. The provider re-registers at each boundary via a precise `setTimeout` scheduler, so the footer `$` cost stays accurate across the day; offline it falls back to cache, then to a built-in table.
- **Footer balance line** (`/deepseek`): the account balance now shows in the footer (`DS ¥12.34`, CNY/USD symbol per currency) — refreshed on `session_start` and every 15 minutes, plus right after `/deepseek → Balance`. Toggle with `/deepseek → Balance in status bar — toggle` (`showBalanceInStatus` in `deepseek-config.json`, default on); cleared when there's no key, the fetch fails, or the session ends.
- **Alibaba Cloud footer quota** (`/alibaba`): when the active model is from `alibaba-cloud` and the limits endpoint is reachable (Beijing workspace domain), the footer shows its rate limit (`Ali qwen3.7-max 60 req/min`), refreshed on a 15-minute timer and on model switches. Toggle with `/alibaba → Status in footer — toggle` (`showStatusInFooter` in `alibaba-config.json`, default on).
- **`/deepseek → Status`** now also reports the price-sync state (number of synced models, current peak/off-peak period); **`/alibaba → Status`** reports the footer setting.
- Docs: README updated for the footer status lines, the price-sync source/periods, and the new menu entries.
## 1.1.1

- **Package banner now GitHub-hosted**: `pi.image` points to `raw.githubusercontent.com/blueye-y/pi-models-access/main/banner.jpg` (own repo) instead of the old Supabase URL on the original author's bucket. New banner art in `banner.jpg`.
- **Repo cleanup**: removed the stale `graphify-out/` analysis artifacts (old-name references, original author's machine paths) and gitignored the directory.

## 1.1.0

- **Official DeepSeek API provider** (`extensions/deepseek.ts`, `/deepseek`): implements the full official API surface from [api-docs.deepseek.com/zh-cn](https://api-docs.deepseek.com/zh-cn/) as a pi provider that overrides the built-in `deepseek` provider.
- **Three API modes**, switchable per session via `/deepseek → API Format` (reloads automatically): OpenAI **Chat Completions** (`https://api.deepseek.com/chat/completions`, default), **Anthropic** (`https://api.deepseek.com/anthropic/v1/messages`) and OpenAI **Responses** (`https://api.deepseek.com/responses`).
- **Doc-faithful thinking control** in every mode: `{"thinking":{"type":"enabled/disabled"}}` + `reasoning_effort` (OpenAI), `output_config.effort` (Anthropic — via a custom `streamSimple` because the Anthropic endpoint only accepts `type: enabled/disabled` and ignores `budget_tokens`), and `reasoning.effort` (Responses). The official effort mapping (`low→low, medium→high, high→high, xhigh→high, max→max`) is baked into each format's `thinkingLevelMap`; thinking defaults on at `high` like the raw API.
- **Dynamic model list**: `GET /models` at startup and `/deepseek → Refresh model list`, with an offline cache fallback (`~/.pi/agent/deepseek-models.cache.json`) and the built-in catalog as last resort — the provider never disappears offline.
- **Balance query**: `GET /user/balance` via `/deepseek → Balance` **and** a `deepseek_balance` tool the LLM can call (`is_available` + per-currency total/granted/topped-up balances).
- **Image understanding**: `deepseek-v4-flash-vision-exp` ships with `input: ["text", "image"]` (JPEG/PNG/GIF/WebP per docs; base64 images on the Anthropic path, standard image blocks on the OpenAI paths); toggle via `/deepseek → Vision model — toggle`.
- **Model catalog**: deepseek-v4-flash / deepseek-v4-pro / deepseek-v4-flash-vision-exp with the documented 1M context and 384K max output, documented CNY pricing per M tokens, plus any ids `GET /models` returns — new models appear without an update.
- **Auth**: `/login → Use an API key → DeepSeek` stores the key in `auth.json` (`deepseek` entry); `$DEEPSEEK_API_KEY` also works. Config lives in `~/.pi/agent/deepseek-config.json` (apiFormat, base URLs, vision toggle, context-window overrides).
- **Extension-standards pass over the repo**: `extensions/deepseek.ts` follows the pi extension docs (async factory, `registerProvider` legacy config form, `registerCommand`, `registerTool`, `session_start` refresh, `ui.select/notify/confirm/input`); `extensions/alibaba.ts` auth helpers were tightened from `Record<string, any>` to a typed `AuthEntry` shape. Type-checked with `@earendil-works/pi-ai` and `typebox` added as devDependencies.
- **Renamed the package to `pi-models-access`** (previously `pi-alibaba-models`): now published under the new name with the repo at `github.com/blueye-y/pi-models-access`. Install with `pi install pi-models-access`.

## 1.0.15

- **OpenAI Responses API (latest Bailian API)**: new `openai-responses` format for the Cloud provider — selectable via `/alibaba → Cloud — Change API Format → OpenAI Responses` (endpoint `https://{domain}/compatible-mode/v1/responses`, Alibaba's newest OpenAI-compatible surface with built-in web search / code interpreter / web extractor tools). DeepSeek-V4 is supported on Responses too (Beijing/Singapore regions per Alibaba's docs); on the Anthropic format DeepSeek still falls back to Chat Completions (the Anthropic-compat path hangs). Thinking uses `reasoning.effort` (none/minimal/low/medium/high), mapped per pi's thinking levels.
- **New regions**: US-Virginia preset (`dashscope-us.aliyuncs.com`), Hong Kong preset (`cn-hongkong.dashscope.aliyuncs.com`), and workspace-domain presets for Beijing / Singapore / Tokyo / Frankfurt / US (`{WorkspaceId}.{region}.maas.aliyuncs.com`) — Alibaba recommends the workspace domains for Beijing/Singapore and requires them for Japan/Frankfurt/US. `/alibaba → Cloud — Change Domain` prompts for the business-space ID and builds the host.
- **Cloud catalog via the native `GET /api/v1/models`**: the Cloud model list is now fetched from Alibaba's DashScope-native model API (paginated, `capabilities=TG`), which returns real `context_window` / `max_output_tokens`, `Reasoning` / `VU` capability tags, input modality and **per-1M-token pricing** — the extension's id-based guessing is only used as a fallback for domains/regions that don't expose the endpoint (or when fields are missing).
- **Rate-limit inspection**: new `/alibaba → Rate limits (Cloud)` queries `GET /api/v1/models/limits` with the Cloud API key and shows each model's request rate (req/s or req/min), token usage limit per period, and async queue/concurrency. Read-only and best-effort — the endpoint is only documented on the Beijing workspace domain so far; elsewhere it hints at switching domains. The view is filtered to the current Cloud catalog.
- **Authorized-models filter**: when `GET /api/v1/models/permissions` is reachable (Beijing workspace domain), the Cloud catalog is intersected with the account's `AUTHORIZED` inference models so models you can't actually call are hidden instead of 404ing at request time. On by default, toggle via `/alibaba → Cloud — Authorized-only Filter` (or `cloudAuthorizedOnly: false` in `alibaba-config.json`); falls back to the full catalog when the endpoint is unavailable or the intersection would be empty.
- **Latest model metadata**: `qwen3.8-max` is now flagged vision-capable with 1M context and a `reasoning_effort` map (low/medium/xhigh); `deepseek-v4-*` and `glm-5.x` get `reasoning_effort` maps (high/max) on the OpenAI path; smarter per-model max output tokens across the catalog (mirrors pi's native Qwen token-plan data: 384K for DeepSeek V4, 131K for Qwen 3.x Max / GLM-5.2, 262K for Kimi K2.6+).
- **OpenAI-path compat fix**: `supportsDeveloperRole: false` and `supportsStore: false` are now set on every model (pi otherwise sends `role: "developer"` messages, which Qwen's endpoint rejects).
- **Compatibility with the latest pi**: `ctx.modelRegistry.authStorage` was removed from pi's public extension API — the `/alibaba` Re-login / Change Endpoints / Reset-all flows now write `~/.pi/agent/auth.json` directly.
- README: refreshed model lineup, endpoints, region table (US / Japan / Frankfurt / workspace domains), Responses-API docs, and removed the stale deepseek-v3.2 allow-list note (DeepSeek v3.x was retired by Alibaba in July 2026).

## 1.0.14

- Release bump. First npm publish since 1.0.10; bundles the 1.0.11–1.0.13 work: Qwen 3.7 Plus/Max metadata (1M context, 3.7 Plus multimodal), shared Plan/Cloud capability heuristics, the `/alibaba → Context Window — Override` setting, the `/login` Cloud-visibility fix (#1), and Cloud catalog loading from `$DASHSCOPE_API_KEY`.

## 1.0.13

- **Cloud catalog now loads from `DASHSCOPE_API_KEY` too.** Previously the live catalog was only fetched when a key was saved via `/login`; users who authenticate the Cloud provider purely through the `DASHSCOPE_API_KEY` env var were stuck on the login-seed model. The catalog fetch now uses the saved key **or** the env var, so env-var users get their full, correctly-described model list. As a result the hardcoded login seed (added in 1.0.12 for #1) is now used **only** when there is no credential anywhere — a state in which no model is usable regardless, so it's purely a "sign in" entry, not a model guess.
- `/alibaba → Status` now reports Cloud auth via `$DASHSCOPE_API_KEY` when that's how you're authenticated.
- Docs: document env-var auth for the Cloud provider.

## 1.0.12

- **Fix: Cloud provider missing from `/login`** (#1). pi hides any provider that has zero registered models, so after the hardcoded fallbacks were removed the **Alibaba Cloud (API Key)** entry disappeared from `/login → Use an API key` until you were already logged in. The provider now registers a single real login seed (`qwen-plus`) whenever the live catalog is empty, so it's always visible to log into. This is one login seed, not a model-catalog fallback — the live catalog replaces it the moment you log in.
- **New setting: context-window override.** `/alibaba → Context Window — Override` lets you correct the context size shown on a model's card — per model id, or `*` for a global default. Stored in `alibaba-config.json` under `contextWindowOverrides`. Handy when a brand-new model is inferred with the wrong size (the `/v1/models` API doesn't report context windows).
- Docs: corrected a stale "48 hours" cache note (it's 4 h).

## 1.0.11

- **Qwen 3.7 support**: `qwen3.7-plus` and `qwen3.7-max` now report their correct **1M (1,048,576) token** context windows, and Qwen 3.7 Plus is correctly flagged as multimodal (text + image input). Both surface automatically from the live catalog — this just fixes their inferred metadata.
- Corrected `qwen3.6-max` to its actual **256K** context window (it does not share the 1M window of Qwen 3.6/3.7 Plus).
- Capability inference (context window, reasoning, vision) is now shared between the Plan and Cloud code paths via common helpers, so they can no longer drift apart. Fixes a case where Qwen 3.x Plus was treated as text-only and non-reasoning on the Cloud provider.
- Context-window matching now also covers dated model variants (e.g. `qwen3.7-plus-2026-06-01`).
- Docs: refreshed the model lineup and corrected stale cache notes (4 h TTL, cache-based offline fallback — no hardcoded list).
- Thanks to [@pkking](https://github.com/pkking) for reporting the context-window issue (#3).

## 1.0.10

- Fix `qwen3.6-plus` context window: now reports **1M (1,048,576)** tokens instead of the hardcoded 128K, on both the Plan and Cloud endpoints (#3, #4). Thanks [@pkking](https://github.com/pkking).
- Use the `$`-prefixed `$DASHSCOPE_API_KEY` env var reference to silence the legacy environment-variable deprecation warning.

## 1.0.9

- Offline resilience: a failed catalog fetch (no connection, DNS, timeout) no longer crashes the extension — and therefore no longer prevents `pi` from starting or blocks your local/other-provider models. The startup and `session_start` catalog loads now fall back to the last-known-good on-disk cache and emit a warning instead of throwing. Live API remains the source of truth whenever it's reachable; the cache is an offline fallback only. If there's no cache either, the affected provider registers with an empty model list (a warning, not a fatal error).

## 1.0.8

- Fix startup model resolution by making the extension factory async and fetching live Plan/Cloud catalogs before provider registration. Pi now validates `enabledModels` against the real API model lists immediately, eliminating startup "No models match pattern" warnings without hardcoded or cache fallbacks.

## 1.0.7

- Bump (1.0.6 already published).

## 1.0.6

- Removed all hardcoded model fallbacks (`PLAN_MODEL_DEFS_FALLBACK`, `CLOUD_FALLBACK`). If the API is unreachable and no stale cache exists, the extension now errors immediately instead of silently degrading to a stale model list. This eliminates transient "no models match" warnings caused by the hardcoded list being out of sync with the live catalog.

## 1.0.5

- Plan model list now fetched dynamically from the Plan endpoint's own `/compatible-mode/v1/models` API (primary source), replacing the fragile GitHub TypeScript template parser. New models appear automatically as Alibaba ships them — no extension update needed. The GitHub template parser remains as a secondary fallback.

## 1.0.4

- Version bump (no code changes)

## 1.0.3

- Sync factory pattern: hardcoded models registered instantly for picker availability, with lazy `session_start` fetch that re-registers both providers with live catalog data

## 1.0.2

- Fix README install instructions: replaced hardcoded local path (`/Users/francesco/alibaba-pi-package`) with `pi install pi-alibaba-models` everywhere (Install, Uninstall, Troubleshooting). npm and git fallbacks documented.

## 1.0.1

- Pre-release polish: fix LICENSE author, fix import scope, expand README, sync model lineup (Qwen 3.6 Max, DeepSeek V4 Pro), gitignore `package-lock.json`
- Use Supabase CDN for directory banner

## 1.0.0

- Initial release
- Two providers: `alibaba-plan` (Model Studio Coding Plan) and `alibaba-cloud` (DashScope API Key)
- `/alibaba` slash command for runtime configuration
- Dynamic plan model list fetched from upstream Qwen Code template
- Cloud model list fetched live from DashScope `/v1/models`
- Vision support via `input: ["text", "image"]` for VL/Qwen-plus models
- Qwen thinking support with `thinkingFormat: "qwen"` and `thinkingLevelMap`
- DeepSeek models forced to OpenAI-compat endpoint (Anthropic-compat hangs)
- Auth migration from legacy single-key format to split Plan/Cloud
