# Shipped Extensions

Officially maintained pi extensions shipped with the `@earendil-works/pi-coding-agent` package (npm tarball and binary). Unlike `examples/extensions/`, these are production extensions, not demonstrations.

They are not auto-loaded: registering third-party providers for every user would change default behavior. Load them on demand.

## pi-models-access

The complete model-provider extension set previously distributed as the standalone
[`pi-models-access`](https://github.com/blueye-y/pi-models-access) npm package (which is
deprecated in favor of this directory):

- `extensions/alibaba.ts` — Alibaba Model Studio (Coding Plan subscription + Cloud pay-per-token, Anthropic / OpenAI / Responses API shapes) and
- `extensions/deepseek.ts` — the official DeepSeek API provider (Completions / Anthropic / Responses modes, dynamic model list, balance query, vision).

`package.json` keeps the `pi.extensions` manifest so the directory remains publishable to npm
on its own (`npm publish` from `pi-models-access/`).

### Load

```bash
# From an installed coding-agent package (npm or binary)
pi install node_modules/@earendil-works/pi-coding-agent/extensions/pi-models-access

# Or explicit paths for one-off runs
pi -e extensions/pi-models-access/extensions/alibaba.ts \
   -e extensions/pi-models-access/extensions/deepseek.ts

# Or copy the files to a global auto-discovered location
cp -r extensions/pi-models-access ~/.pi/agent/extensions/
```

See `pi-models-access/README.md` for usage (login, models, regions, commands).
