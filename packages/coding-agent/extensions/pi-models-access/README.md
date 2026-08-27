# pi-models-access

The complete [`pi`](https://github.com/badlogic/pi-mono) extension set for Alibaba's model lineup — **Qwen 3.8 Max**, **Qwen 3.7 Max / Plus / Flash**, **Qwen 3.6 Plus / Flash**, **DeepSeek V4 Pro / Flash**, **Kimi K2.6 / K2.7**, **GLM-5.1 / 5.2**, **MiniMax M2.5**, and the rest of the catalog — **plus the official DeepSeek API provider** (Completions / Anthropic / Responses API modes, dynamic model list, balance query, image understanding) **and the Zhipu GLM provider** (智谱 Coding Plan + API, dynamic model list, documented pricing). Native thinking-level support, both Anthropic- and OpenAI-shaped APIs (including the new OpenAI **Responses** API), International / China / US / Japan / Frankfurt endpoints, both Coding Plan subscriptions and pay-per-token Cloud keys.

## Origin

This extension is a **fork and extension of [pi-alibaba-models](https://www.npmjs.com/package/pi-alibaba-models) by [Francesco Frapporti](https://fornace.it) at [Fornace](https://fornace.it)** (the author field and the "From the same author" section below reflect the original work). We forked it and extended it with the **official DeepSeek API provider** (Completions / Anthropic / Responses API modes, dynamic model list, balance query, image understanding), the OpenAI **Responses** API shape for the Cloud provider, and renamed the package to `pi-models-access`.

## Features

- **Alibaba providers**: subscription-based Model Studio Coding Plan **and** pay-per-token Alibaba Cloud (DashScope) — registered side by side, switch per chat from the model picker.
- **DeepSeek official provider**: `deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-v4-flash-vision-exp` against `api.deepseek.com` in three switchable API modes (`/deepseek → API Format`), with `GET /models` dynamic catalog, `GET /user/balance` (command + `deepseek_balance` tool), vision input on the exp model, and a **footer balance line** (`DS ¥12.34`). When no key is present the provider makes **zero startup requests** (no `/models`, no pricing-page sync).
- **Zhipu GLM provider**: overrides pi's built-in `zai-coding-cn` (智谱开放平台) and `zai` (Z.AI intl) providers, reusing their `/login` flow. Both **Coding Plan** (subscription quota) and **API** (pay-per-token) billing modes (`/zhipu → Mode`), `GET /models` dynamic catalog, documented CNY/USD pricing, and capability defaults (vision, context window, thinking) filled per model — GLM-5.3 included with its always-on thinking.
- **Three API Shapes** (Alibaba): Anthropic-compatible (`/v1/messages`) by default; OpenAI-compatible Chat Completions (`/compatible-mode/v1`) auto-selected for DeepSeek on the Anthropic format; the new OpenAI **Responses** API (`/compatible-mode/v1/responses`) selectable per-Cloud via `/alibaba` (DeepSeek-V4 included, Beijing/Singapore).
- **Dual Provider Support** (Alibaba): Both the subscription-based Model Studio Coding Plan **and** the pay-per-token Alibaba Cloud (DashScope) — registered side by side, switch per chat from the model picker.
- **Five Regions**: International (`dashscope-intl.aliyuncs.com`), China (`dashscope.aliyuncs.com`), US-Virginia (`dashscope-us.aliyuncs.com`), Japan-Tokyo and Germany-Frankfurt (workspace domains), plus Alibaba's recommended **business-space (workspace) domains** for Beijing/Singapore — switch with `/alibaba`, no re-login needed.
- **Native Reasoning**: First-class thinking-level support for every reasoning-capable model, including `reasoning_effort` levels (Qwen 3.8 Max: low/medium/xhigh; DeepSeek V4, GLM 5.x: high/max) on the OpenAI path.
- **Vision Capable**: Image input automatically enabled for VL models, Qwen 3.8 Max, and Qwen 3.x Plus variants.
- **Live Catalog**: Pulls the real `/v1/models` from DashScope on every login + the canonical Qwen-Code plan template. New models appear as Alibaba ships them — no extension update needed. The Cloud catalog now uses Alibaba's native `GET /api/v1/models` (real context windows, max output tokens, Reasoning/VU capability tags, input modality and **pricing** — no more id-based guessing where available), falling back to the compatible-mode endpoint on domains that don't expose it.
- **Footer status lines**: DeepSeek shows your account balance in the footer (`DS ¥12.34`, refreshed after each completed conversation round and on a 15-minute timer — toggle with `/deepseek → Balance in status bar`); Alibaba Cloud shows the active model's rate-limit quota when the limits endpoint is reachable (Beijing workspace domain).
## How to Use (Quickstart)

1. **Install** the extension (see below).
2. **Restart** `pi` to load the extension.
3. Type `/login` in your pi chat input.
4. Select your provider based on your account type:
   - Choose **Plans > Alibaba Model Studio Coding Plan** if you have a subscription (your token likely starts with `sk-sp-` or `sk-tok-`).
   - Choose **Use an API key > Alibaba Cloud (API Key)** if you use the pay-as-you-go DashScope service (your token likely starts with `sk-`).
5. Paste your token when prompted.
6. Open the model picker, select a model (e.g., `Qwen 3.8 Max`, `Qwen 3.7 Plus`, `Qwen 3.6 Flash`, or `DeepSeek V4 Pro`), and start chatting!

## Install

```bash
# recommended
pi install pi-models-access

# explicit npm form (fallback if the bare name doesn't resolve)
pi install npm:pi-models-access

# or from GitHub
pi install git:github.com/blueye-y/pi-models-access

# or from a local checkout (development)
git clone https://github.com/blueye-y/pi-models-access
cd pi-models-access && pi install .
```

After install, restart `pi`. The extension registers two providers and a slash command on every boot.

## Uninstall

`pi remove` only removes the package entry from `settings.json["packages"]` — it does not clean extension-private state (auth entries, config, model cache, enabled-model lists). For a clean uninstall:

```text
1. /alibaba  →  "Reset all"      (wipes config, both auth entries, plan-models cache, alibaba-* enabledModels)
2. pi remove pi-models-access
```

If you've already run `pi remove` and want to clean leftovers manually:

```bash
rm -f ~/.pi/agent/alibaba-config.json ~/.pi/agent/alibaba-plan-models.cache.json
# then edit ~/.pi/agent/auth.json and remove the "alibaba-plan" / "alibaba-cloud" entries
# then edit ~/.pi/agent/settings.json and drop any "alibaba-*/..." or "dashscope/..." entries from enabledModels
```

## Two providers

| Provider id    | Section in `/login`     | Auth shape | Use it for                                 |
|----------------|-------------------------|------------|--------------------------------------------|
| `alibaba-plan` | Plans                   | OAuth (paste token) | Model Studio Coding Plan subscription |
| `alibaba-cloud`| Use an API key          | API key (paste via `/login`, or `$DASHSCOPE_API_KEY`) | Pay-per-token DashScope API           |

The Plan provider registers an `oauth`-shaped login (paste token) so it appears under Plans in `/login`; the Cloud provider is API-key-registered under “Use an API key”, and also works from the `DASHSCOPE_API_KEY` env var. Credentials live in `~/.pi/agent/auth.json` under their respective keys; the Plan provider stores the chosen endpoints in the `refresh` field as JSON, and the Cloud provider stores its domain in `~/.pi/agent/alibaba-config.json`.

> **Cloud without `/login`:** the Cloud provider also reads the `DASHSCOPE_API_KEY` environment variable. If it's set, the extension fetches your live model catalog from it on startup — no `/login` needed. With **no** credential at all (no `/login`, no env var) the Cloud provider still shows up in `/login → Use an API key` via a single placeholder model, so you can sign in; your real catalog replaces it the moment a key is present.

### Endpoints

**Plan (default Singapore / Global):**
- Anthropic-compat: `https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic` (pi appends `/v1/messages`)
- OpenAI-compat:    `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`

**Cloud (default International):**
- Anthropic-compat: `https://dashscope-intl.aliyuncs.com/apps/anthropic`
- OpenAI-compat:    `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` (Chat Completions **and** Responses)

**Cloud — other regions** (set via `/alibaba → Cloud — Change Domain`):
- China:      `https://dashscope.aliyuncs.com`
- US (Virginia): `https://dashscope-us.aliyuncs.com`
- Beijing / Singapore / Tokyo / Frankfurt workspace domains: `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com`, `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com`, `https://{WorkspaceId}.ap-northeast-1.maas.aliyuncs.com`, `https://{WorkspaceId}.eu-central-1.maas.aliyuncs.com` — Alibaba recommends migrating to these for Beijing/Singapore; the old shared domains still work.

> **OpenAI Responses API** (`/compatible-mode/v1/responses`): Alibaba's newest OpenAI-compatible surface, with built-in tools (web search, code interpreter, web extractor) and `reasoning.effort` thinking levels (none/minimal/low/medium/high). Select it per-Cloud via `/alibaba → Cloud — Change API Format → OpenAI Responses`. DeepSeek-V4 is supported on it too — but only in the **Beijing and Singapore** regions. When the format is Anthropic, DeepSeek models still fall back to Chat Completions (the Anthropic-compat path hangs for them).
## Key prefix reference

| Prefix      | Provider       | Where to obtain                                                   |
|-------------|----------------|-------------------------------------------------------------------|
| `sk-sp-`    | `alibaba-plan` | Model Studio Coding Plan console — Singapore / Global             |
| `sk-tok-`   | `alibaba-plan` | Model Studio Coding Plan console — alternate token format         |
| `sk-`(other)| `alibaba-cloud`| DashScope API Keys console (per-token billing)                    |

Consoles:
- International / Singapore Coding Plan: <https://modelstudio-intl.console.alibabacloud.com/>
- China Coding Plan:                     <https://bailian.console.aliyun.com/>
- DashScope (per-token):                 <https://dashscope.console.aliyun.com/> or <https://dashscope-intl.console.aliyun.com/>

The login flow validates the prefix and offers to redirect you to the correct provider if you paste the wrong type.

## Region table

| Region        | Plan host                                         | Cloud host                       |
|---------------|---------------------------------------------------|----------------------------------|
| International | `token-plan.ap-southeast-1.maas.aliyuncs.com`     | `dashscope-intl.aliyuncs.com`    |
| China         | (region-specific host, paste via "Custom")        | `dashscope.aliyuncs.com`         |
| US (Virginia) | —                                                 | `dashscope-us.aliyuncs.com`      |
| Hong Kong     | —                                                 | `cn-hongkong.dashscope.aliyuncs.com` |
| Beijing (workspace) | `{WorkspaceId}.cn-beijing.maas.aliyuncs.com` | `{WorkspaceId}.cn-beijing.maas.aliyuncs.com` |
| Singapore (workspace) | `{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com` | `{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com` |
| Japan (Tokyo) | —                                                 | `{WorkspaceId}.ap-northeast-1.maas.aliyuncs.com` |
| Germany (Frankfurt) | —                                            | `{WorkspaceId}.eu-central-1.maas.aliyuncs.com` |
| US (workspace) | —                                              | `{WorkspaceId}.us-east-1.maas.aliyuncs.com` |
| Custom        | paste both base URLs at login                     | paste domain at login            |

> The Beijing / Singapore workspace domains are the ones Alibaba recommends (and they're required for Japan/Frankfurt). `/alibaba → Cloud — Change Domain` asks for your business-space ID (`业务空间详情` in the console) and builds the host for you.

### Rate limits

`/alibaba → Rate limits (Cloud)` queries `GET /api/v1/models/limits` with your API key and prints each model's quota: request rate (req/s or req/min), token usage limit per period, and async queue/concurrency where applicable. It's a read-only best-effort view — the endpoint is currently only documented on the **Beijing workspace domain**, so on other domains it tells you to switch (`/alibaba → Cloud — Change Domain`) and retry. The view is filtered to the models in your current Cloud catalog so it stays focused. When the active model is an `alibaba-cloud` model, its rate limit is also shown in the footer (`Ali qwen3.7-max 60 req/min`, refreshed on a 15-minute timer; toggle with `/alibaba → Status in footer`).

### Authorized-models filter

`GET /api/v1/models/permissions` returns the models your business space is authorized to call (`authorization_scope=AUTHORIZED`, `action=INFERENCE`). When the endpoint is reachable (Beijing workspace domain), the extension intersects it with the live catalog and hides models you don't have inference permission for — no more picking a model that 404s only at request time. It's on by default; disable any time via `/alibaba → Cloud — Authorized-only Filter` (or set `cloudAuthorizedOnly: false` in `~/.pi/agent/alibaba-config.json`). If the fetch fails (non-Beijing domains) or the intersection would be empty, the full catalog is shown instead.
## Studio plan models — dynamic source

The plan model list is fetched from the canonical Qwen Code template:

<https://github.com/QwenLM/qwen-code/blob/main/packages/cli/src/constants/codingPlan.ts>

Cached at `~/.pi/agent/alibaba-plan-models.cache.json` for **4 hours**. The live API is always the source of truth; on a failed fetch the extension falls back to the last-known-good on-disk cache (and, if there's no cache either, registers an empty list rather than crashing). Force a refresh from `/alibaba → Refresh model lists`.

The Cloud provider mirrors the live catalog from Alibaba's native `GET /api/v1/models` (paginated, `capabilities=TG` for text generation, then filtered for chat-capable ids) — Qwen 3.8 Max, Qwen 3.7 Max/Plus/Flash, Qwen 3.6 Plus/Flash, DeepSeek V4 Pro/Flash, Kimi K2.6/K2.7, GLM-5.1/5.2, MiniMax M2.5 etc. all surface automatically as Alibaba ships them, with real context windows, max-token limits and per-1M-token pricing from the API. Domains without `/api/v1/models` fall back to the compatible-mode endpoint (id-based inference). (DeepSeek v3.x line was retired by Alibaba in July 2026 — migrate to DeepSeek V4 or Qwen 3.x.)

## Limitations & Known Issues

- **DeepSeek Compatibility**: The Anthropic-compatible path on the Alibaba Plan host often hangs or times out for DeepSeek models. To resolve this seamlessly, this extension automatically forces any model ID containing `deepseek` to use the **OpenAI-completions endpoint** instead.
- **Model Availability (404s)**: The picker shows the catalog your account is actually **authorized** to call when the permissions endpoint is reachable (`GET /api/v1/models/permissions`, available on the Beijing workspace domain) — models you lack inference permission for are hidden instead of 404ing at request time. Toggle with `/alibaba → Cloud — Authorized-only Filter`. When the endpoint is unreachable (other domains), the full advertised catalog is shown and a model you can't access still errors only when you actually send a message.
- **API Wrapper Quirks**: Alibaba's native Anthropic compatibility layer can occasionally be strict or quirky with complex parallel tool calls. If you experience systemic parsing errors on DashScope, you can use the `/alibaba` command to switch your Cloud API format to "OpenAI Chat Completions" or "OpenAI Responses".
- **Responses API**: the OpenAI Responses surface supports DeepSeek-V4 only on Beijing/Singapore — on other regions those models fall back to Chat Completions, and not every model supports every built-in tool. If a model errors out, switch back to Chat Completions or Anthropic for that session.
- **Dynamic Caching**: Model lists are cached for 4 hours. If a new model drops and you don't see it, run `/alibaba` -> `Refresh model lists`.
- **Inferred Context Windows**: The `/v1/models` API returns only ids and names, so context windows are inferred from the model id. If a brand-new model shows the wrong size, fix it yourself with `/alibaba → Context Window — Override` (per model, or `*` for all) — no extension update needed.

## `/alibaba` command reference

| Choice                       | What it does                                                              |
|------------------------------|---------------------------------------------------------------------------|
| Status                       | Print Plan/Cloud login state, active endpoints, model count, cache age   |
| Refresh model lists          | Force-refetch Plan + Cloud catalogs and reload the extension             |
| Re-login Plan                | Wipe `alibaba-plan` from `auth.json` and reload (then run `/login`)      |
| Re-login Cloud               | Wipe `alibaba-cloud` from `auth.json` and reload (then run `/login`)     |
| Plan — Change Endpoints      | Override OpenAI / Anthropic base URLs                                    |
| Cloud — Change Domain        | International / China / US / Japan / Frankfurt / workspace domains / Custom |
| Cloud — Change API Format    | Anthropic Messages / OpenAI Chat Completions / OpenAI Responses          |
| Rate limits (Cloud)          | Show per-model rate/usage quotas for the current API key (`/api/v1/models/limits`) |
| Status in footer — toggle    | Show/hide the active Cloud model's rate-limit quota in the footer                |
| Cloud — Authorized-only Filter | Toggle hiding catalog models the account isn't authorized to call (`/api/v1/models/permissions`) |
| Context Window — Override    | Set the context-window shown on a model's card (per model, or `*` for all) |
| Reset all                    | Wipe all Alibaba state (config, both auth entries, plan-models cache)    |

## Troubleshooting

- **Model picker shows "No matching models"** → run `/login`, pick the right Alibaba entry, paste your key. Models register only after a successful login (Cloud fetches its real model list at boot from the live key).
- **`sk-sp-` accidentally pasted into the Cloud slot** → run `/alibaba → Re-login Cloud`, then `/login → Alibaba Model Studio Coding Plan` and paste it there. (The login validators will also catch this and offer to redirect you.)
- **DeepSeek hangs / times out** → make sure you're on the latest version of this extension; it forces DeepSeek to OpenAI-compat. If you customised plan endpoints, verify the OpenAI URL ends in `/compatible-mode/v1`.
- **Plan picker shows models that 404 at request time** → your subscription tier may not include every advertised model. The picker shows whatever upstream advertises; the API tells you "model_not_found" only when you actually call it.
- **`/alibaba` command doesn't appear** → `pi list` should show `pi-models-access` (or whatever source you installed from) under "User packages". If absent, run `pi install pi-models-access` again and restart `pi`.

## Files

| Path                                                  | Purpose                            |
|-------------------------------------------------------|------------------------------------|
| `~/.pi/agent/auth.json`                               | Provider credentials (0600)        |
| `~/.pi/agent/alibaba-config.json`                     | Alibaba endpoint / domain / format config |
| `~/.pi/agent/alibaba-plan-models.cache.json`          | 4 h plan-models cache              |
| `~/.pi/agent/alibaba-cloud-models.cache.json`         | 4 h cloud-models cache             |
| `~/.pi/agent/deepseek-config.json`                    | DeepSeek API format / base URL config |
| `~/.pi/agent/deepseek-models.cache.json`              | DeepSeek `GET /models` cache       |
| `~/.pi/agent/deepseek-prices.cache.json`              | Last-synced official pricing (both peak/off-peak rate sets) |
## DeepSeek official API provider (`/deepseek`)

Since v1.1.0 the package also ships a **DeepSeek official API** extension
(`extensions/deepseek.ts`). It follows the official documentation at
[api-docs.deepseek.com/zh-cn](https://api-docs.deepseek.com/zh-cn/) and implements the
full capability surface:

- **Three API modes**, switchable per session via `/deepseek → API Format`:
  - `openai-completions` — `POST https://api.deepseek.com/chat/completions` (default)
  - `anthropic-messages` — `POST https://api.deepseek.com/anthropic/v1/messages`
  - `openai-responses`   — `POST https://api.deepseek.com/responses`
- **Thinking mode** per the official docs — `{"thinking":{"type":"enabled/disabled"}}`
  + `reasoning_effort` (OpenAI), `output_config.effort` (Anthropic),
  `reasoning.effort` (Responses). The documented effort mapping is baked in:
  `low→low, medium→high, high→high, xhigh→high, max→max`; thinking defaults on at
  `high` like the raw API.
- **Dynamic model list** — `GET /models` at startup and on `/deepseek → Refresh model list`,
  with an offline cache fallback (`~/.pi/agent/deepseek-models.cache.json`).
- **Balance query** — `GET /user/balance` via `/deepseek → Balance` or the `deepseek_balance` tool
	  (`is_available` + per-currency total/granted/topped-up balances, CNY/USD), plus a **footer
	  balance line** (`DS ¥12.34`) refreshed after each completed conversation round and on a
	  15-minute timer (`/deepseek → Balance in status bar — toggle`).
- **Price sync** — model costs are parsed from the official pricing page
	  ([api-docs.deepseek.com/quick_start/pricing](https://api-docs.deepseek.com/quick_start/pricing))
	  once per extension load, caching both **peak and off-peak** USD rates
	  (`~/.pi/agent/deepseek-prices.cache.json`). The active rate set follows the
	  UTC clock (peak = weekdays 01:00-04:00 + 06:00-10:00 UTC, exactly 2× off-peak),
	  re-registering the provider at each boundary so the footer `$` cost stays
	  accurate. Offline, the last-synced cache (then a built-in table) is used.
- **Image understanding** — `deepseek-v4-flash-vision-exp` (JPEG/PNG/GIF/WebP) is included
  with `input: ["text", "image"]`; toggle it via `/deepseek → Vision model`.
- **Model catalog** — deepseek-v4-flash, deepseek-v4-pro, deepseek-v4-flash-vision-exp
  (1M context / 384K max output), plus any ids returned by `/models` — new models appear
  without an extension update.

### Quickstart

1. `pi install pi-models-access` (or run from a checkout) and restart `pi`.
2. `/login → Use an API key → DeepSeek` and paste your key from
   [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) —
   or just export `DEEPSEEK_API_KEY` (the provider is registered with
   `apiKey: "$DEEPSEEK_API_KEY"`).
3. Open the model picker and pick `DeepSeek V4 Pro` / `DeepSeek V4 Flash` /
   `DeepSeek V4 Flash Vision (exp)`.
4. `/deepseek → API Format` to switch between the Completions, Anthropic and
   Responses API modes (reloads automatically).

### `/deepseek` command reference

| Menu item                | Action                                                            |
|--------------------------|-------------------------------------------------------------------|
| Status                   | Auth state, API format, base URLs, model count, cache age, price sync state, current peak/off-peak period |
| Refresh model list       | Force `GET /models` and re-register the provider                  |
| API Format               | Switch `openai-completions` / `anthropic-messages` / `openai-responses` |
| Balance                  | `GET /user/balance` (is_available + CNY/USD totals), then refreshes the footer line |
| Balance in status bar — toggle | Show/hide the account balance in the footer            |
| Re-login                 | Wipe the `deepseek` auth entry and re-run `/login`                |
| Base URL — override      | Custom OpenAI/Anthropic base URLs (proxies/gateways)              |
| Vision model — toggle    | Show/hide `deepseek-v4-flash-vision-exp`                          |
| Context Window — override| Per-model (or `*`) context-window override                       |
| Reset all                | Wipe config, models cache and auth entry                          |

> **Notes**
> - The Anthropic mode uses a custom streaming implementation that sends exactly what
>   the docs specify for that endpoint (`thinking.type` + `output_config.effort`), so
>   thinking levels work on all three formats.
> - `deepseek_balance` is a custom tool the LLM can call on its own.
> - Context caching (KV cache) is automatic server-side per the docs — cache-hit tokens
>   are surfaced in usage as `cacheRead`.

## Zhipu GLM provider (`/zhipu`)

The package also ships a **Zhipu (智谱) GLM** extension (`extensions/zhipu.ts`) that
overrides pi's built-in `zai-coding-cn` (智谱开放平台, `open.bigmodel.cn`) and `zai`
(Z.AI international, `api.z.ai`) providers, so the built-in `/login` flow keeps
working unchanged — the `auth.json` entries and `$ZAI_CODING_CN_API_KEY` /
`$ZAI_API_KEY` env vars are inherited from the built-ins (same trick the DeepSeek
extension uses to reuse pi's default DeepSeek login).

- **Two billing modes**, switchable via `/zhipu → Mode`:
  - **Coding Plan** (subscription quota, default): `https://open.bigmodel.cn/api/coding/paas/v4`
  - **API** (pay-per-token): `https://open.bigmodel.cn/api/paas/v4`
  - intl equivalents on `api.z.ai`. Both use the OpenAI Chat Completions shape
    (thinking format `zai`, `zaiToolStream`, `max_tokens`) — the same shape as the
    built-ins, so no custom streaming is needed.
- **Dynamic model list** — `GET /models` at startup and on `/zhipu → Refresh model lists`,
  with an offline cache fallback (`~/.pi/agent/zhipu-models.cache.json`) and the
  built-in catalog as last resort.
- **Live model specs** — context window, max output, vision and thinking are parsed
  from the official docs pages (`docs.bigmodel.cn` serves every model page as
  markdown; discovery goes through the model-overview index), cached for 7 days
  (`~/.pi/agent/zhipu-specs.cache.json`) and refreshed via `/zhipu → Refresh model
  lists`. Synced specs override the built-in catalog, so spec changes land without
  an extension update. Only runs when logged in.
- **Documented pricing** — CNY per 1M tokens (USD for intl): GLM-5.3/5.2
  ¥8 in / ¥28 out / ¥2 cache hit, GLM-5 ¥4 / ¥18 / ¥1, GLM-5.3-Flash
  ¥0.8 / ¥2.8 / ¥0.23. Unknown ids fall back to default rates. (智谱's pricing page
  is a JS-rendered console page with no public static source, so prices come from
  the documented table rather than a live page parse.)
- **Capability defaults** filled per model id — context window, max output, vision and
  thinking: GLM-5.3 is 1M ctx with thinking **always on** (its `off` thinking level is
  hidden because the API rejects `thinking.type: disabled`); GLM-5.3-Flash / 5V / 4.6V /
  4.1V models are flagged vision-capable; flash/free models can be hidden via
  `showFlash` in `zhipu-config.json`.

### Quickstart

1. `pi install pi-models-access` (or run from a checkout) and restart `pi`.
2. `/login → Use an API key → Z.AI Coding CN` (China) or `Z.AI` (intl) and paste your
   Coding Plan token or API key from the 智谱 console — or export
   `ZAI_CODING_CN_API_KEY` / `ZAI_API_KEY`.
3. Open the model picker and pick e.g. `GLM-5.3`.
4. `/zhipu → Mode` to switch between Coding Plan and API billing.

### `/zhipu` command reference

| Menu item                | Action                                                            |
|--------------------------|-------------------------------------------------------------------|
| Status                   | Mode, flash toggle, spec-sync state, per-region auth, base URL, model count, cache age |
| Refresh model lists      | Force `GET /models` for both regions and re-register the providers |
| Mode — Coding Plan / API | Switch the billing endpoint                                        |
| Re-login                 | Wipe the `zai`/`zai-coding-cn` auth entries and re-run `/login`    |
| Base URL — override      | Custom OpenAI-compatible base URL per region (proxies/gateways)    |
| Context Window — override| Per-model (or `*`) context-window override                         |
| Reset all                | Wipe config, models cache and auth entries                         |

> **Note** — there is no account-balance/quota command for Zhipu: the platform has no
> documented API-key balance endpoint (the console balance page is session-authenticated).

## From the same author
By [Francesco Frapporti](https://fornace.it) at [Fornace](https://fornace.it).

- **[pi-bench](https://github.com/fornace/pi-bench)** — LLM benchmark toolkit for pi. Probes every available model to find the fastest and cheapest.
- **[pi-recap](https://github.com/fornace/pi-recap)** — Always-visible session recap panel for pi. Uses pi-bench data to pick the fastest summarization model.
- **[pi-banana](https://github.com/fornace/pi-banana)** — Generate and edit images inside pi using Google Nano Banana. All package banners in this ecosystem were created with pi-banana.
- **[pi-notte-theme](https://github.com/fornace/pi-notte-theme)** — Notte: a true-dark pi theme where darkness has color and text glows like terminal phosphor.
