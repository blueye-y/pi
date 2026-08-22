# pi-models-access

The complete [`pi`](https://github.com/badlogic/pi-mono) extension set for Alibaba's model lineup — **Qwen 3.8 Max**, **Qwen 3.7 Max / Plus / Flash**, **Qwen 3.6 Plus / Flash**, **DeepSeek V4 Pro / Flash**, **Kimi K2.6 / K2.7**, **GLM-5.1 / 5.2**, **MiniMax M2.5**, and the rest of the catalog — **plus the official DeepSeek API provider** (Completions / Anthropic / Responses API modes, dynamic model list, balance query, image understanding). Native thinking-level support, both Anthropic- and OpenAI-shaped APIs (including the new OpenAI **Responses** API), International / China / US / Japan / Frankfurt endpoints, both Coding Plan subscriptions and pay-per-token Cloud keys.

## Features

- **Alibaba providers**: subscription-based Model Studio Coding Plan **and** pay-per-token Alibaba Cloud (DashScope) — registered side by side, switch per chat from the model picker.
- **DeepSeek official provider**: `deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-v4-flash-vision-exp` against `api.deepseek.com` in three switchable API modes (`/deepseek → API Format`), with `GET /models` dynamic catalog, `GET /user/balance` (command + `deepseek_balance` tool) and vision input on the exp model.
- **Three API Shapes** (Alibaba): Anthropic-compatible (`/v1/messages`) by default; OpenAI-compatible Chat Completions (`/compatible-mode/v1`) auto-selected for DeepSeek on the Anthropic format; the new OpenAI **Responses** API (`/compatible-mode/v1/responses`) selectable per-Cloud via `/alibaba` (DeepSeek-V4 included, Beijing/Singapore).
- **Dual Provider Support** (Alibaba): Both the subscription-based Model Studio Coding Plan **and** the pay-per-token Alibaba Cloud (DashScope) — registered side by side, switch per chat from the model picker.
- **Five Regions**: International (`dashscope-intl.aliyuncs.com`), China (`dashscope.aliyuncs.com`), US-Virginia (`dashscope-us.aliyuncs.com`), Japan-Tokyo and Germany-Frankfurt (workspace domains), plus Alibaba's recommended **business-space (workspace) domains** for Beijing/Singapore — switch with `/alibaba`, no re-login needed.
- **Native Reasoning**: First-class thinking-level support for every reasoning-capable model, including `reasoning_effort` levels (Qwen 3.8 Max: low/medium/xhigh; DeepSeek V4, GLM 5.x: high/max) on the OpenAI path.
- **Vision Capable**: Image input automatically enabled for VL models, Qwen 3.8 Max, and Qwen 3.x Plus variants.
- **Live Catalog**: Pulls the real `/v1/models` from DashScope on every login + the canonical Qwen-Code plan template. New models appear as Alibaba ships them — no extension update needed. The Cloud catalog now uses Alibaba's native `GET /api/v1/models` (real context windows, max output tokens, Reasoning/VU capability tags, input modality and **pricing** — no more id-based guessing where available), falling back to the compatible-mode endpoint on domains that don't expose it.
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

`/alibaba → Rate limits (Cloud)` queries `GET /api/v1/models/limits` with your API key and prints each model's quota: request rate (req/s or req/min), token usage limit per period, and async queue/concurrency where applicable. It's a read-only best-effort view — the endpoint is currently only documented on the **Beijing workspace domain**, so on other domains it tells you to switch (`/alibaba → Cloud — Change Domain`) and retry. The view is filtered to the models in your current Cloud catalog so it stays focused.

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
  (`is_available` + per-currency total/granted/topped-up balances, CNY/USD).
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
| Status                   | Auth state, API format, base URLs, model count, cache age         |
| Refresh model list       | Force `GET /models` and re-register the provider                  |
| API Format               | Switch `openai-completions` / `anthropic-messages` / `openai-responses` |
| Balance                  | `GET /user/balance` (is_available + CNY/USD totals)               |
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

## From the same author
By [Francesco Frapporti](https://fornace.it) at [Fornace](https://fornace.it).

- **[pi-bench](https://github.com/fornace/pi-bench)** — LLM benchmark toolkit for pi. Probes every available model to find the fastest and cheapest.
- **[pi-recap](https://github.com/fornace/pi-recap)** — Always-visible session recap panel for pi. Uses pi-bench data to pick the fastest summarization model.
- **[pi-banana](https://github.com/fornace/pi-banana)** — Generate and edit images inside pi using Google Nano Banana. All package banners in this ecosystem were created with pi-banana.
- **[pi-notte-theme](https://github.com/fornace/pi-notte-theme)** — Notte: a true-dark pi theme where darkness has color and text glows like terminal phosphor.
