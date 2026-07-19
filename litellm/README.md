# murakumo LiteLLM gateway

`llm.etzhayyim.com` → LiteLLM (one mac mini, port 4000) → serve_plain.py (loopback + fleet fallback).

## Why

LKE GPU Ollama retired 2026-04-19. All LLM calls consolidate onto the murakumo mac mini fleet. LiteLLM fronts the fleet to give:

1. Unified OpenAI-compatible `/v1/chat/completions` endpoint with a stable model-name contract (`tier0-general` / `tier0-structured` / `tier1-reasoning`)
2. Per-call timeouts + retry with fallback (local serve_plain.py → fleet tunnel if local saturated)
3. Single place to add rate limit / budget / audit later (swap `cache: false` + add `success_callback`)

## Topology

```
CF Worker (murakumo, news, shinshi, ...)
  │ Authorization: Bearer $LITELLM_MASTER_KEY
  ↓
https://llm.etzhayyim.com
  │ CF Tunnel `murakumo-fleet` (ae341542), ingress route added to host mac mini
  ↓
LiteLLM @ 127.0.0.1:4000  (launchd com.etzhayyim.litellm)
  │
  ├── fast path: http://127.0.0.1:8000/v1   (same-host serve_plain.py, p50 <300ms)
  │
  └── fallback:   https://murakumo-serve.etzhayyim.com/v1   (fleet tunnel, auto-LB)
```

## Install (one mac mini, recommended `dan`)

```bash
# 1. Generate master key once, store in Keychain
security add-generic-password -s etzhayyim.litellm -a MASTER_KEY \
  -w "sk-litellm-$(openssl rand -hex 32)" -U

# 2. Clone repo + cd to litellm/
cd 60-apps/etzhayyim-project-murakumo/litellm

# 3. Install
./install.sh

# 4. Add CF Tunnel ingress route (manual edit on this mac)
#    /opt/etzhayyim/cloudflared-fleet/config.yaml (or wherever tunnel config lives):
#
#    ingress:
#      - hostname: llm.etzhayyim.com
#        service: http://localhost:4000
#      - hostname: murakumo-serve.etzhayyim.com
#        service: http://localhost:8000
#      ...

# 5. Create DNS in Cloudflare (orange or gray cloud)
#    llm.etzhayyim.com → CNAME ae341542.cfargotunnel.com

# 6. Distribute the master key to Worker secrets
#    wrangler secret put LITELLM_MASTER_KEY  (inside each consumer Worker)
```

## Consumer change

`40-engine/kotoba/crates/kotoba-kotodama/sdk/kotodama-host-sdk/src/llm-model-registry.ts` should map:

```
use-case=general     → tier0-general
use-case=structured  → tier0-structured
use-case=reasoning   → tier1-reasoning
```

`MURAKUMO_CHAT_URL` env in each Worker: `https://llm.etzhayyim.com/v1/chat/completions`
`MURAKUMO_API_KEY` secret: value of `etzhayyim.litellm/MASTER_KEY`.

## Ops

- **Logs**: `/var/log/etzhayyim-litellm.{out,err}.log`
- **Restart**: `launchctl unload ~/Library/LaunchAgents/com.etzhayyim.litellm.plist && launchctl load ~/Library/LaunchAgents/com.etzhayyim.litellm.plist`
- **Health**: `curl -fs http://127.0.0.1:4000/health/liveliness`
- **Model list**: `curl -s -H "Authorization: Bearer $KEY" http://127.0.0.1:4000/v1/models | jq`

## Known limitations

- Single-host gateway (if the mac mini hosting LiteLLM dies, `llm.etzhayyim.com` goes 5xx even if the other 3 serve_plain nodes are up). Mitigation: run LiteLLM on 2 macs and front with CF Tunnel LB (both registered for `llm.etzhayyim.com`). Not wired up yet.
- No persistent budget/auth DB. Every call authenticates against the single `LITELLM_MASTER_KEY`; granular keys require adding postgres.
- Embedding path not yet configured. When embedding model ships on mac mini, add model block + update `deps.toml embedding_server`.
