# etzhayyim-project-murakumo — Server Inference Platform (Compute + Inference)

## Overview

**Server-side inference cluster.** Primary: RunPod GPU cluster (RTX 6000 Ada, vLLM) via
LiteLLM gateway on judah + CF Worker gateway. Public API is OpenAI-compat; browser visitors
of https://murakumo.etzhayyim.com/ get an in-page chat UI that talks to the cluster via an
ephemeral HMAC token (no sk_live_* key needed for anonymous chat).

SSoT: **ADR-2605010000** (RunPod RTX 6000 Ada unified pod). Mac Mini fleet demoted to
L8 Somatic Inference for resident organism actors only (ADR-2605080600).

```
Browser / API client
  → murakumo.etzhayyim.com (CF Worker v4.1.0, auth + proxy)
    - GET /                          → chat HTML + ephemeral mkc_* token
    - POST /v1/chat/completions       → requireAuth → LITELLM_URL
    - GET  /v1/models, /v1/model/info → LITELLM_URL
    - GET  /_app/meta, /health        → R2 roster (cron `*/5`)
  → LITELLM_URL = judah:4000 LiteLLM (OpenAI-compat gateway)
  → RunPod Serverless API (vLLM, OpenAI-compat)
    https://api.runpod.ai/v2/vyp99t9px7h4dl/openai/v1
    GPU: RTX 6000 Ada (48 GB VRAM) — pod vyp99t9px7h4dl
    Model: gemma-4-e4b-it (primary), image: ghcr.io/etzhayyim/runpod-vllm-gemma:latest
```

**Auth layers**:
- sk_live_* (HYPERDRIVE `vertex_api_key`, scope=`murakumo:inference`) — API consumers
- MURAKUMO_API_KEY (break-glass, ADR-0023) — emergency
- mkc_* HMAC ephemeral (MURAKUMO_CHAT_SECRET) — browser chat UI (1h TTL, anonymous)
- x-kotodama-verified (internal) — dispatcher-side trust

**Legacy pruned (2026-04-20, [[migrations]] murakumo-cf-worker-litellm-rewire done)**:
serve_plain.py / daemon.py / Nomad / Ray / mesh_tunnel / Linode GPU Ollama tier /
RunPod Tier-3 fallback / image+audio endpoints / CoordinatorDO+SessionDO DOs /
`cdn.etzhayyim.com/mlx-models/*.tar.gz` B2 fallback / hayate custom inference server.
Git history preserves; `_archive/` holds retired serve_plain.py etc.

### Migration from V1 (Nomad + daemon.py + CoordinatorDO)

Design doc: `90-docs/260408-murakumo-fleet-redesign-shannon-comparison.md`

| V1 (deprecated) | V3 (current) | Benefit |
|---|---|---|
| SSH tunnel (macOS LN Privacy) | **Cloudflare Tunnel** (outbound HTTPS) | Ghost worker 問題解消、LN Privacy 無関係 |
| daemon.py poll loop (2s) | **serve_plain.py** (Starlette + uvicorn, push) | η 2.9% → 99%、poll/heartbeat/CoordinatorDO 全廃 |
| CoordinatorDO (7 DOs, 3519 行) | **CF Worker proxy** (~100 行, stateless) | State entropy H = 2.58 → 0 bits (stateless) |
| Nomad 1.11.3 + daemon.py | **Pure Python** (starlette + mlx_lm, zero deps) | Ray/Nomad/Go 依存排除 |
| model affinity bug | **tokenizer.apply_chat_template** | 正しいプロンプトフォーマット、正答確認済 |

**Verified (2026-04-08)**:
- Inference: `gemma-4-e2b-it` 8 sequential requests → **6/8 success** (2 warm-up miss), 正答確認 (3+3=6, 6+6=12 etc.)
- Fleet: 4 active nodes (dan/simeon/naphtali/levi) — each runs `serve_plain.py` (Starlette + uvicorn + mlx_lm, no Ray)
- Network: Cloudflare Tunnel (`murakumo-fleet`, ID `ae341542`) — 4 connectors, Cloudflare auto-LB
- Dispatcher: `ORIGIN_PASSTHROUGH_HOSTS` に tunnel hostname 追加済み
- Latency: 220-284ms GPU, 400-570ms E2E (warm gemma-4-e2b-it)

- **`murakumo.etzhayyim.com`** — Mac Mini fleet + OpenAI-compatible API
- **nanoid**: `m9r4k8m0`
- **Worker**: `50-infra/cloudflare/workers/murakumo/` (`index.ts`)

### Physical LAN topology (2026-05-11)

**fleet LAN は `.murakumo.lan` ドメインで `jacob` 上の dnsmasq が SSoT** — `judah.murakumo.lan` 等の FQDN を ansible / scripts / runbook の標準参照名とする。`.local` mDNS 依存は段階的廃止。詳細は ADR-2605111400。

- **dual-router cascade を発見**: broadcom 192.168.1.1 (Sony NCP NURO 系 WiFi router) と NTT HGW 192.168.1.1 (`ntt.setup`) が同一サブネット `192.168.1.0/24` を別々の L2 で配っている。WiFi 側と Ethernet 側は **L2 で相互到達不能**
- **Phase 1-5 移行**: jacob を NTT HGW Ethernet 化 → 全 mini Ethernet 化 → service order + DNS + pmset を ansible 一括 → broadcom bridge mode 化 → DHCP reservation。詳細は `deps.toml [[migrations]] murakumo-fleet-lan-dnsmasq-ethernet-unification`
- **dnsmasq 設定**: `/opt/homebrew/etc/dnsmasq.conf` + `/opt/homebrew/etc/dnsmasq.d/murakumo-fleet.conf` + `/etc/resolver/murakumo.lan` (macOS Stub Resolver → 192.168.1.37)
- **WireGuard overlay (`cmd/murakumo-netd/`) と Tailscale は不採用継続** — 物理 LAN を綺麗にすれば overlay 不要

### WIT Architecture (案 E — interface 分離 + deployment 統合)

```
kotodama:compute/accelerator@1.0.0    ← compute substrate 抽象化
  ├─ load-model, execute, unload-model, health, list-models
  └─ Providers: MLX (current), CUDA/RunPod (future)

kotodama:inference/text@1.0.0          ← 推論抽象化 (OpenAI-compatible)
  ├─ chat-completions, embeddings
  └─ Consumes: compute/accelerator

kotodama:inference/image@1.0.0         ← 画像生成抽象化
  └─ generations

kotodama:inference/fleet@1.0.0         ← fleet 管理
  └─ get-cluster-status, list-workers

kotodama:inference/audio@1.0.0         ← 音楽/音声生成抽象化 (ongakuka.etzhayyim.com 駆動)
  ├─ text-to-music         (lyrics + style → audio tokens or wav)
  ├─ text-to-music-stems   (vocal/inst/drums/bass を分離 stem で出力)
  ├─ vocoder               (RVQ codes → waveform 44.1kHz)
  ├─ audio-tokenizer       (wav → RVQ codes、学習データ前処理)
  └─ Providers: DiffRhythm/YuE (MLX, Phase 0) → 自前 2 段 LM (Phase 2)
```

**3 app の役割分担:**

| App | WIT | 役割 |
|---|---|---|
| **murakumo** | import compute/accelerator, export inference/{text,image,fleet} | Server-side inference (MLX, CUDA) |
| **ameno** | import compute/accelerator, export inference/text | Browser-side inference (WebGPU ONNX) |
| **llm** | import inference/text from {murakumo, ameno, Workers AI} | Inference router (use_case → provider) |

### Architecture

```
Client → murakumo.etzhayyim.com (CF Worker, stateless gateway)
           │ fetch("https://murakumo-serve.etzhayyim.com/...")
           ↓
         Cloudflare Tunnel (murakumo-fleet, ae341542, auto-LB)
           ├─→ dan      ┐
           ├─→ simeon   │ serve_plain.py v3.0.0
           ├─→ naphtali │ (Starlette + uvicorn)
           └─→ levi     ┘
                │
                ├─ compute/accelerator  → MLX provider (accelerator_load/execute)
                ├─ inference/text       → chat_completions (tokenizer + generate)
                ├─ inference/image      → image_generations (diffusers SDXL MPS)
                └─ inference/fleet      → xrpc_cluster_status / xrpc_list_workers
```

### Key Design Decisions

| Decision | Rationale |
|---|---|
| **WIT interface 分離** | compute (substrate) ⊥ inference (workload) を型レベルで分離。deployment は統合維持 |
| **Provider pattern** | `accelerator_load()` / `accelerator_execute()` を MLX provider として分離。CUDA provider 追加 = 新 provider のみ |
| **inference_ms (not gpu_ms)** | Apple Silicon は discrete GPU ではない。wall clock = inference latency |
| **Single tunnel hostname** | 全ノードが同じ tunnel ID。Cloudflare が connector 間で自動 LB |
| **CF Worker = stateless proxy** | auth + `fetch()` to tunnel のみ。DO/scheduling 不要 |

**Verified (2026-04-08)**: 4/4 ノード到達、arithmetic 4/4 PASS、E2E 400-570ms

## Inference

### Text (LLM_INFERENCE)

| Model | Runtime | Nodes | Latency (warm) |
|---|---|---|---|
| `gemma-4-e2b-it` (mlx-community/gemma-4-e2b-it-4bit) | `serve_plain.py` + `mlx_lm.generate()` | **4 ノード** (dan/simeon/naphtali/levi) | 220-284ms inference, 400-570ms E2E |

- **serve_plain.py**: Starlette + uvicorn + mlx_lm (compute/accelerator: MLX provider)
- **Model warmup**: 起動時に `accelerator_warmup()` で `mlx_lm.load()` + trivial generate (cold start 排除)
- **Chat template**: `tokenizer.apply_chat_template()` で gemma4 フォーマット自動適用
- **Model aliases**: `serve/serve_plain.py` `MODEL_ALIASES` dict

### Image (IMAGE_GENERATION)

| Model | Runtime | Latency |
|---|---|---|
| `wai-real` (John6666/wai-real-mix-v11-sdxl) | `serve_plain.py` + `diffusers` SDXL + PyTorch MPS | ~2min (cold) |

`StableDiffusionXLPipeline.from_pretrained()` → `.to("mps")`。model cached in-process。

**Supported models**: `wai-real`, `wai-real-mix-v11`, `sdxl`, `flux-schnell`

### Audio / Music (AUDIO_GENERATION) — ongakuka driver

| Model | Runtime | Latency (target) |
|---|---|---|
| `diffrhythm-1.2-ja` (ASLP-lab/DiffRhythm + ja LoRA) | `serve_plain.py` + diffrhythm + MLX/MPS | 30–60s for 90s clip (warm) |
| `yue-7b-music` (m-a-p/YuE-s1-7B-anneal-en-cot) | `serve_plain.py` + YuE 2-stage | 60–120s for 90s clip |
| `encodec-24k` / `dac-44k` | `serve_plain.py` (vocoder + tokenizer) | <500ms for 30s clip |

**Routes (planned, Phase 0)**:
```
POST /api/audio/v1/music/generations       → text-to-music     {lyrics, style, durationSec, seed} → wav blob
POST /api/audio/v1/music/stems             → text-to-music-stems → {vocal, inst, drums, bass} blobs
POST /api/audio/v1/music/vocode            → vocoder            {tokens[]} → wav
POST /api/audio/v1/music/tokenize          → audio-tokenizer    wav → {rvqCodes[][]}
GET  /api/audio/v1/models                  → audio model list
```

**Node placement (Phase 0)**:
- Music gen は unified memory が重いので **32GB+ ノード必須** (現 16GB fleet では不可)。Mac Studio M2 Max 64GB or M4 Pro 48GB を 1–2 台追加し `audio_pool` Ansible group に切り出す
- Vocoder/tokenizer は軽量 → 既存 16GB fleet で同居可

**Cost model (consumer, planned)**:

| Component | Rate |
|---|---|
| Base | 50 credits/track |
| Audio sec | 5 credits/sec |
| Stem 出力 | +20 credits/stem |
| Vocoder only | 1 credit/sec |

Reward / penalty は既存 `kotodama:metering/{reward,penalty}` を再利用。`audio_pool` operator の reward base = 5 credits/req (compute weight 高)。

**Status**: Spec only (2026-04-15)。実装は ongakuka MVP 着手と同期。Provider order: DiffRhythm (歌詞付き、最も Suno に近い OSS) → YuE (英語強い、CoT) → 自前 distill (Phase 2)。

## Metering & Credits (kotodama:metering)

**CF Worker = metering point。** per-request で usage tracking、cost 計算、reward/penalty を実行。

### Architecture

```
Request (x-org-id, x-user-id, x-api-key)
  → CF Worker (auth + quota check)
    → proxyWithMetering() → serve_plain.py (x-request-id, x-org-id 伝搬)
      ← response (usage: {prompt_tokens, completion_tokens}, x_inference_ms, x_node)
    → calculateCost(usage) → credits debit
    → calculateReward(usage) → node operator credit
    → emitMeteringEvent() → PDS (com.etzhayyim.apps.murakumo.inferenceUsage record)
```

### Cost Model (Consumer)

| Component | Rate | 例 (100 prompt + 50 completion tokens) |
|---|---|---|
| Base | 2 credits/req | 2 |
| Prompt tokens | 1 credit/1K tokens | 1 |
| Completion tokens | 3 credits/1K tokens | 1 |
| **Total** | — | **4 credits** |

### Reward Model (Node Operator)

| Component | Rate | 例 (150 total tokens) |
|---|---|---|
| Per-inference base | 1 credit/req | 1 |
| Token volume | 0.5 credits/1K tokens | 1 |
| **Total** | — | **2 credits** |

### Penalty Model

| Violation | Consumer (penalize-consumer) | Provider (penalize-provider) |
|---|---|---|
| Rate limit exceeded | throttle 1hr | — |
| Monthly quota exceeded | reject 429 | — |
| High error rate (>10%) | — | deprioritize routing、credits deduction |
| Slow response (>5s warm) | — | deprioritize routing |
| Abuse pattern | suspend | — |

### WIT Interfaces

| Interface | 役割 | 実装場所 |
|---|---|---|
| `kotodama:metering/usage` | per-request usage 記録 + cost 計算 | CF Worker (`calculateCost`, `emitMeteringEvent`) |
| `kotodama:metering/quota` | pre-request quota gate | CF Worker (→ kakin.etzhayyim.com 連携予定) |
| `kotodama:metering/reward` | node operator credit 報酬 | CF Worker (`calculateReward`) → credits.etzhayyim.com |
| `kotodama:metering/penalty` | abuse/SLA violation 処理 | CF Worker → credits.etzhayyim.com |

### Credits Integration

| Flow | From | To | API |
|---|---|---|---|
| **Consumer spend** | CF Worker | credits.etzhayyim.com | `SpendCredits({user_id, amount, action: "inference"})` |
| **Operator reward** | CF Worker | credits.etzhayyim.com | `RewardFromCompute({node_id, inference_ms, tokens})` |
| **Usage log** | CF Worker | PDS | `createRecord("com.etzhayyim.apps.murakumo.inferenceUsage")` |
| **Quota check** | CF Worker | kakin.etzhayyim.com | `CheckQuota({org_id, estimated_tokens})` |

## Persistence

**serve_plain.py は stateless (per-request)。** Model は in-process cached。Metering は CF Worker が担当。

## Key Files

| Purpose | Path |
|---|---|
| **Inference server (PRIMARY)** | `serve/serve_plain.py` v3.0.0 — Starlette + uvicorn + mlx_lm (compute/accelerator + inference/text) |
| **Mesh tunnel** | `serve/mesh_tunnel.py` — Python TCP-over-UDP tunnel (LN Privacy bypass, future multi-node 用) |
| **CF Worker gateway (ACTIVE)** | `50-infra/cloudflare/workers/murakumo/src/index.ts` — inference proxy + metering |
| **CF Worker wrangler (ACTIVE)** | `50-infra/cloudflare/workers/murakumo/wrangler.jsonc` — single route, B2, PDS_SERVICE |
| **WIT compute** | `_archive/00-contracts/wit/wit/deps/kotodama-compute/package.wit` (archived 2026-04-12) — accelerator interface (MLX/CUDA/WebGPU) |
| **WIT inference** | `_archive/00-contracts/wit/wit/deps/kotodama-inference/package.wit` (archived 2026-04-12) — text/image/fleet interfaces |
| **WIT metering** | `_archive/00-contracts/wit/wit/deps/kotodama-metering/package.wit` (archived 2026-04-12) — usage/quota/reward/penalty interfaces |
| **Dispatcher passthrough** | `50-infra/cloudflare/workers/dispatcher/worker.ts` — `ORIGIN_PASSTHROUGH_HOSTS` に tunnel hostname 登録 |
| **Python daemon (LEGACY)** | `cli/daemon.py` v1.4.0 — Nomad poll loop (deprecated) |
| **Ansible playbooks** | `ansible/` — cloudflared, venv, legacy (ssh-tunnel, nomad) |
| **Ansible inventory** | `ansible/inventory/hosts.yml` — 10 nodes, ray_head=dan, cloudflared_tunnel_id |
| **Design doc** | `90-docs/260408-murakumo-fleet-redesign-shannon-comparison.md` — 5 案 Shannon 比較 |
| Fleet CLI (Go) | `70-tools/etzhayyim/murakumo.go` + `murakumo_fleet.go` |

## Ansible Fleet Management (2026-04-08)

**Ansible = cloudflared + venv provisioning。** Legacy roles (ssh-tunnel, nomad) は `[legacy]` tag。

```bash
cd 60-apps/etzhayyim-project-murakumo/ansible

# Full fleet (cloudflared + venv + legacy)
ansible-playbook site.yml

# Cloudflare Tunnel only
ansible-playbook site.yml --tags=cloudflared

# OpenClaw CLI only
ansible-playbook site.yml --tags=openclaw

# Health check (read-only)
ansible-playbook health-check.yml
```

### Roles

| Role | Target | 内容 |
|---|---|---|
| **common** | fleet | .etzhayyim dir, SSH keys, node.conf |
| **venv** | fleet | Python venv + mlx-lm + starlette + uvicorn |
| **cloudflared** | fleet | Cloudflare Tunnel install + config + launchd |
| **openclaw** | fleet + `openclaw_gateway` | CLI install (all fleet) + gateway launchd service, yoro-profile agent, Murakumo provider, cron registry (gateway host only) |
| **ssh-tunnel** | nomad_clients | (LEGACY) SSH tunnel |
| **nomad-server** | nomad_servers | (LEGACY) Nomad server |
| **nomad-client** | nomad_clients | (LEGACY) Nomad client |
| **daemon** | fleet | (LEGACY) daemon.py deploy |

### Verified (2026-04-08)

- Cloudflare Tunnel: 4 connectors active (dan/simeon/naphtali/levi), Cloudflare auto-LB verified
- serve_plain.py: 4 nodes running (Starlette + uvicorn + mlx_lm), gemma-4-e2b-it loaded, 220-284ms GPU
- E2E: `murakumo.etzhayyim.com` → CF Worker → Tunnel → serve_plain.py → 4 ノード分散、正答確認 (3+3=6 etc.)
- Dispatcher: `ORIGIN_PASSTHROUGH_HOSTS` passthrough verified

## Architecture shift — Ollama fleet + LiteLLM (2026-04-18 pm)

Replaces the custom `serve_plain.py` + CF Tunnel + CF Worker proxy stack with industry-standard Ollama + LiteLLM. Motivation: the legacy stack hit three classes of failure in one session (root-owned HF cache → crash loop, dead B2 CDN fallback, single-thread MLX saturation at ~10 concurrent). Ollama solves all three natively (model lifecycle, no custom download path, continuous batching with `OLLAMA_NUM_PARALLEL`). LiteLLM becomes the unified router so future backends (vLLM cloud, external providers) can be added without app-side changes.

### New topology (2026-04-20 update — openclaw retired, goose owns agent runtime)

```
goose cron (judah crontab, ADR-0034)
  ├─ yoro-profile-heartbeat   (*/15m, wrapper throttle 1h)
  ├─ yoro-persona-cron        (0 */4h — actor-manifest cron pipeline)
  └─ yoro-mention-drain       (*/15m — subscribeRepos substitute)
  │
  │  native Ollama (tool-use path, LiteLLM bypass mandatory)
  ▼
Ollama localhost :11434  ──┐
  qwen3.5:9b               │
                           │  LAN (192.168.1.*:11434, non-tool paths)
LiteLLM proxy             ─┘
(judah:4000, Python 3.11 venv)
  │
  ▼
Ollama fleet (10 Mac Mini M4, OLLAMA_HOST=0.0.0.0:11434)
  ├─ gemma3:1b (815 MB, loaded on all 10)
  ├─ gemma4:e4b
  └─ qwen3.5:9b
```

### Operational facts

| Layer | Location | Binding | Persistence | Log |
|---|---|---|---|---|
| Ollama | 10 nodes `/opt/homebrew/opt/ollama/bin/ollama` 0.21.0 | `0.0.0.0:11434` (LAN + loopback) | `crontab -l | grep ollama` — `@reboot` entry | `/tmp/ollama.log` per node |
| LiteLLM | judah `~/litellm-venv/bin/litellm` 1.83.9 | `0.0.0.0:4000` | `crontab -l | grep litellm` — `@reboot` entry | `~/.etzhayyim/litellm.log` |
| Config | `/Users/judah/litellm.yaml` | router_settings: `routing_strategy: simple-shuffle`, `num_retries: 2`, `timeout: 30` | — | — |
| Secret | `/Users/judah/.etzhayyim/rw-url` (chmod 600) + macOS Keychain `etzhayyim.rw ROOT_URL` | RisingWave PG URL for goose recipes (ADR-0034). LiteLLM master_key `sk-etzhayyim-litellm-local` from ansible var | — | — |
| Model registry | LiteLLM `model_list[]` — 10 entries same `model_name=gemma3-1b` but different `api_base` | simple-shuffle spreads requests across all 10 Ollama backends | — | — |

### LaunchAgent vs crontab @reboot decision

macOS SSH sessions cannot reliably `launchctl bootstrap` into `gui/{uid}` (returns "Domain does not support specified action 125") when no user is logged into the GUI — standard for headless fleet nodes. Legacy `launchctl load -w` is also flaky. **Solution**: `@reboot` crontab entry + `nohup … & disown`. Survives reboots, starts in background, SSH-friendly. Same pattern we use for murakumo fleet daemon (pre-existing `daemon` ansible role).

### Verified (2026-04-20) — Goose-as-yoro-actor E2E

| Test | Result |
|---|---|
| openclaw full retirement | LaunchAgent bootout + `~/.openclaw/` + plist removed; ansible role + CLI + lexicon JSON deleted; handler block in PDS worker removed; typecheck clean |
| 3 goose recipes deployed | yoro-profile-heartbeat (3.0KB) / yoro-persona-cron (1.8KB) / yoro-mention-drain (2.4KB) — all pass `goose recipe validate` |
| Integration test | 10/10 PASS (wrapper T1–T5 + recipe validate T7–T8) |
| Ollama context length | 16384 (was 4096 default — root cause of tool-call stalls) |
| goose `--no-profile --with-builtin developer` | qwen3.5:9b emits structured `tool_calls` + executes shell steps. Verified direct `/api/chat` probe + full recipe e2e |
| persona-cron e2e write-path | goose read live KPIs (`POSTS=47 ACTORS=49`) → composed persona note → INSERT `com.etzhayyim.yoro.platformDigest` row into RisingWave → `/tmp/yoro-persona-cron.log` confirmation. Model self-corrected a quote-escape error on first INSERT and retried successfully |
| crontab cadence | 3 entries live on judah (heartbeat + persona-cron + mention-drain); cron-fired mention-drain observed at 12:15:01 |

### Verified (2026-04-18 pm) — Ollama + LiteLLM stack

| Test | Result |
|---|---|
| 15 parallel req via LiteLLM → fleet | **15/15 ok** (was 11/20 with serve_plain.py) |
| 30 parallel req (stress, was saturation point) | **30/30 ok** (was 15/30 → 50% with serve_plain.py) |
| Unique Ollama backends handling load | **10/10** (`/api/ps` shows `gemma3:1b` loaded on every node) |
| openclaw cron run (yoro-profile-refresh) | **status=ok**, durationMs=6628, agent loop accepted response, summary: "User yoro profile refresh completed successfully." |
| End-to-end path (non-agent) | client → localhost:4000 LiteLLM → LAN 11434 Ollama → gemma3:1b/qwen3.5:9b → response |
| End-to-end path (agent tool-use) | goose cron → localhost:11434 Ollama (native, LiteLLM bypass) → qwen3.5:9b → `tool_calls` → psql / curl side effects |

### Migration notes

- **openclaw retired (2026-04-20)**: Ansible role + CLI (`70-tools/etzhayyim/etzhayyim/openclaw.go`) + LaunchAgent (`ai.openclaw.gateway`) deleted. goose role ships an idempotent `purge_openclaw.yml` task that removes `~/.openclaw/` on next apply. Replacement topology: 3 goose recipes (heartbeat / persona-cron / mention-drain) co-owned by the wrapper shell script for deterministic side effects + qwen3.5:9b for narrative text.
- `serve_plain.py` LaunchAgent (`com.etzhayyim.murakumo-serve`) still loaded on fleet but no longer consumed by the agent path. Retire when public `murakumo.etzhayyim.com` API is either re-wired to LiteLLM or confirmed unused (see `[[migrations]] serve-plain-py-retirement`).
- Public `murakumo.etzhayyim.com` endpoint still proxies via CF Worker → CF Tunnel → serve_plain.py on fleet. Unchanged during this phase.

### Verified (2026-04-18) — 10/10 node restoration

Starting state: 2 nodes dark (naphtali/levi, crash-loop on model load) + 3 tunnels unregistered (naphtali/levi/asher). 20-req fan-out showed 45% failure rate (openclaw 503 fleet_unavailable root cause).

| Layer | Before | After |
|---|---|---|
| `serve_plain.py` /health | 8/10 | **10/10** |
| `cloudflared tunnel` process | 7/10 | **10/10** |
| LB routing success @ 10 concurrent | 55% | **100%** |
| Unique responders seen | 4 | **6** (simeon, issachar, zebulun, dan, benjamin, asher) |
| Saturation boundary | ~10 concurrent | **~15 concurrent** (single-threaded MLX inference) |

### Fleet failure-mode runbook

Two distinct crash-loop shapes seen on 2026-04-18. Both reach `_r2_download_model()` fallback which 404s against the deprecated `cdn.etzhayyim.com/mlx-models/*.tar.gz` path (see `[[migrations]] murakumo-serve-r2-fallback-removal`).

**Pattern A — stale root-owned `.locks/` subdir**:

```
hf_hub → WeakFileLock(~/.cache/huggingface/hub/.locks/models--…/*.lock)
         → PermissionError (subdir owner=root, user can't create file)
         → mlx_lm.load raises → serve_plain.py except block → _r2_download_model → 404 → SIGTERM
         → KeepAlive restarts → crash loop
```

Recovery: parent `.locks/` is user-owned, so the root-owned subdir can be rm'd by the user:

```bash
rm -rf ~/.cache/huggingface/hub/.locks/models--mlx-community--<name>
launchctl kickstart -k gui/$(id -u)/com.etzhayyim.murakumo-serve
```

**Pattern B — entire model tree root-owned**:

When `models--…/snapshots/`, `blobs/`, `refs/` are all root-owned, the user can't even rm them (need write perm on parent dirs). Workaround: point hf_hub at a fresh cache via `HF_HUB_CACHE` env and download the model blocking before re-enabling the service.

```bash
# 1. Redirect cache via LaunchAgent env
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:HF_HUB_CACHE string $HOME/.cache/hf-new/hub" \
  ~/Library/LaunchAgents/com.etzhayyim.murakumo-serve.plist

# 2. Stop the crash loop
launchctl bootout gui/$(id -u)/com.etzhayyim.murakumo-serve

# 3. Blocking download (so the serve_plain.py fallback never fires)
env HF_HUB_CACHE=$HOME/.cache/hf-new/hub ~/.local/share/murakumo-venv/bin/python3 -c \
  "from mlx_lm import load; load('mlx-community/<name>')"

# 4. Re-bootstrap service (picks up new HF_HUB_CACHE)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.etzhayyim.murakumo-serve.plist
```

Note: `HF_HOME` is NOT respected by the pinned `huggingface_hub` version in `murakumo-venv` — only `HF_HUB_CACHE` works as an override.

**Pattern C — LaunchAgent plist installed but never bootstrapped (tunnel)**:

`ansible` `cloudflared` role places the plist but a prior `launchctl bootout` (or ansible run interruption) leaves it unregistered. Recovery: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.etzhayyim.cloudflared.plist`. Process appears within 2-3s, CF edge registration ~30s.

### Saturation + concurrency

- serve_plain.py is single-threaded per node (MLX + Python GIL), so **each node handles ~1 in-flight inference**. Queue depth climbs immediately under parallel load.
- Warm per-request latency (gemma-4-e2b-it-4bit, 3-5 tokens): **~4s** incl. CF Worker + Tunnel + MLX
- CF LB spreads across active connectors but favours whichever reports lowest latency first → 6-8 nodes rotate even with 10 connectors up
- goose tool-use runs on native Ollama `:11434` (LiteLLM bypass). Bursts of ~20-30 sequential calls in 5 min put qwen3.5:9b above single-host saturation; fix is **more qwen nodes** or **shorter wrapper cadence throttle**, not more gemma nodes.

## Goose agent runtime (RETIRED 2026-05-23 per ADR-2605231630) — yoro-as-actor topology (ADR-0034, 2026-04-20)

> **Status: retired** as of 2026-05-23 (ADR-2605231630). The canonical agent runtime is
> `(LangGraph, kotoba-datomic, langserver)`; Goose recipes + crontab entries on judah are removed
> in favor of LangGraph cells under `40-engine/kotoba/crates/kotoba-kotodama/cells/yoro_*/`. Ollama on `:11434` and
> the LiteLLM proxy on `:4000` remain in place (they're LLM backend + router, not agent
> runtime). The historical section below is preserved for context only — do not extend it.
>
> Operator transition tasks (Ansible-automated where possible, interactive where required):
>
> - `ansible-playbook site.yml --tags=goose,purge` runs `purge_goose.yml` (removes
>   `~/.config/goose/`, the wrapper shell, and the role-installed plist).
> - `crontab -e` on judah: remove `yoro-profile-heartbeat`, `yoro-persona-cron`,
>   `yoro-mention-drain` lines.
> - Re-implement the three pipelines as LangGraph cells (per ADR-2605202200 cell runtime
>   contract) under `40-engine/kotoba/crates/kotoba-kotodama/cells/yoro_heartbeat/`, `…/yoro_persona_cron/`,
>   `…/yoro_mention_drain/`. Each cell exports `build_graph(deps)` and is wrapped by
>   `langserver` for XRPC dispatch.
> - The wrapper-owned deterministic side effects (cadence tracker INSERT into
>   `vertex_repo_commit`) are reimplemented inside each cell as substrate-anchored
>   ObservationRecords on kotoba-datomic-dht (per ADR-2605211200 + the Stage D wrapper at
>   `40-engine/kotoba/crates/kotoba-kotodama/py/src/kotodama/unispsc_capabilities/wrapper.py`).

**Goose is the sole agent runtime on judah.** OpenClaw (role + CLI + LaunchAgent) was retired 2026-04-20 — its `chat completion once` cron runner never parsed `tool_calls`, so every scheduled job produced text with zero side effects. Goose has a working MCP tool-use loop (sends `tools[]`, parses `tool_calls`, executes, feeds results back) and is now wired to impersonate T1 actors directly from their `actor-manifest.jsonld`.

### Topology — goose impersonates yoro

```
crontab @ judah
  ├─ */15m  yoro-profile-heartbeat        (cadence tracker, optional AT heartbeatNote)
  ├─ 0 */4  yoro-persona-cron             (actor-manifest cron pipeline → platformDigest + derive:social)
  └─ */15m  yoro-mention-drain            (subscribeRepos substitute → reply to @yoro)
           │
           ▼ ~/.etzhayyim/goose-cron-wrapper.sh (shinka throttle + deterministic side effects)
           │   1. resolve $RW_URL (Keychain → ~/.etzhayyim/rw-url)
           │   2. joucho cadence override (vertex_actor_shinka_state.cadence_ms)
           │   3. throttle — skip when elapsed < cadence
           │   4. INSERT tracker row into vertex_repo_commit (deterministic)
           │   5. optional AT post via `etzhayyim agent-token --lxm com.atproto.repo.createRecord`
           │   6. invoke goose run --recipe $RECIPE (non-fatal)
           │
           ▼ goose qwen3.5:9b (GOOSE_PROVIDER=ollama, native :11434, LiteLLM bypass)
           │   - instructions = actor-manifest.jsonld convoSystemPrompt (pinned in template)
           │   - shell tool: psql $RW_URL  (read KPI / pick mention)
           │   - shell tool: psql $RW_URL  (INSERT domain record — platformDigest / reply)
           │   - shell tool: curl → atproto.etzhayyim.com/xrpc (optional federation)
           │
           ▼ RisingWave public.vertex_repo_commit
               (repo=did:web:yoro.etzhayyim.com, collection=com.etzhayyim.yoro.* | com.etzhayyim.convo.message)
```

### Hard requirements

| Rule | Reason |
|---|---|
| `GOOSE_PROVIDER=ollama` + `OLLAMA_HOST=http://127.0.0.1:11434` | LiteLLM proxy translates OpenAI tools[] into a form qwen3.5:9b interprets as `<think>` content instead of structured `tool_calls`. LiteLLM bypass is **mandatory** for the tool-use loop. LiteLLM remains the front for non-agent chat paths. |
| `GOOSE_MODEL=qwen3.5:9b` | gemma3:1b too small; gemma4:e4b emits tool calls as text content (not `tool_calls`); qwen3.5:9b is the only fleet-pulled model that emits proper structured `tool_calls` on Ollama native. Verified via `curl /api/chat` with `"tools":[...]`. |
| `GOOSE_MODE=auto` | Auto-approve tool execution. Without it, goose waits for interactive confirmation and a non-interactive cron run shows only the tool-call JSON then exits. |
| **`--no-profile --with-builtin developer` (CRITICAL)** | goose 1.31.0 default profile enables 7 extensions (developer/todo/skills/summon/apps/extensionmanager) exposing 20-35 tools. qwen3.5:9b (9.7B Q4_K_M) is overwhelmed — Ollama stalls (30s stream timeout) or model emits shell commands as text content. Constraining to just the `developer` builtin (~3 tools: shell/text_editor/write) restores proper `tool_calls` emission. Verified 2026-04-20 via direct `/api/chat` probe. Wrapper passes these flags on every goose invocation. |
| **`OLLAMA_CONTEXT_LENGTH=16384` (CRITICAL)** | Ollama 0.21.0 default is 4096 tokens. goose's system prompt + tools[] + recipe + message history easily exceeds 4K, causing silent truncation → model drops tool definitions and falls back to text-only output. qwen3.5:9b supports up to 32K; 16K is the sweet spot for recipe+tool-use with bounded KV cache memory. Set via Ansible `ollama_context_length` default on the `ollama` role. Drift detection via `ps -E -p $pid` grep. Verified active: `curl /api/ps` returns `context_length: 16384`. |
| **Recipe size <3KB** | Even with 16K context + 3 tools, recipes >3.5KB correlate with tool-call degradation on qwen3.5:9b 4-bit. Keep recipes terse: drop verbose persona strings, compress multi-line SQL to single-line. Current: heartbeat 3.0KB, persona-cron 1.8KB, mention-drain 2.4KB. |
| **RisingWave SQL: no PG dollar-quoted strings** | RisingWave SQL parser does not implement PG `$$...$$` dollar-quoted string literals. Use regular single-quoted JSON text with escaping. The wrapper shell already follows this; recipes must too. Legacy heartbeat recipe's Step 3 INSERT was deleted because it both duplicated the wrapper INSERT and used unsupported dollar quotes. |
| Recipe validated via `goose recipe validate <file>` | Invalid schema → silent no-op at scheduler time. Integration test T7/T8 enforces this on every ansible apply. |
| Cron via **crontab** (not `goose schedule add`) | `goose schedule` requires a deprecated scheduler daemon. Plain `crontab -e` with the wrapper shell follows the same `@reboot`/entry pattern as ollama/litellm and keeps SSH-friendly provisioning. |
| Single-host (judah only) | `goose_gateway` inventory group has exactly one member. Cron multiplex across hosts would double-INSERT into `vertex_repo_commit`. |
| Wrapper owns deterministic side effects | qwen3.5:9b occasionally skips or mis-escapes prompt steps. The wrapper shell INSERTs the cadence tracker + optional AT post; the recipe adds narrative enrichment that tolerates occasional omission. Wrapper also handles bash 3.2 (macOS default) array expansion quirks via scalar `TIMEOUT_BIN` + fallback-to-unbounded. |
| Recipe persona = actor-manifest.jsonld convoSystemPrompt (compressed) | Each persona recipe pins a 1–2 sentence persona summary inline in `instructions:` so the agent voice is traceable to the T1 manifest. Full `convoSystemPrompt` paragraphs trigger the >3KB recipe size ceiling — keep it short. |

### Recipes (ADR-0034)

| Recipe | Cron | Wrapper cadence | Actor-manifest link | Side effects |
|---|---|---|---|---|
| `yoro-profile-heartbeat` | `*/15 * * * *` | 1h (joucho override) | `heartbeatRequired: true` | tracker row in `com.etzhayyim.yoro.heartbeat` + optional `heartbeatNote` AT post |
| `yoro-persona-cron` | `0 */4 * * *` | 4h | `pipelines[].trigger.cron == "0 */4 * * *"` — platformStats→activeUsers→compose→derive:social | tracker row in `com.etzhayyim.yoro.personaCron` + `platformDigest` row (posts24h, activeActors, narrative) + optional `app.bsky.feed.post` |
| `yoro-mention-drain` | `*/15 * * * *` | 1m | `pipelines[].trigger.subscribeRepos.collections ⊇ ["com.etzhayyim.convo.message"]` — indexMessage→linkReply→compose→derive:social | tracker row in `com.etzhayyim.yoro.mentionDrain` + reply row in `com.etzhayyim.convo.message` (senderDid=yoro, replyTo=mention.rkey) + optional federated AT post |

All three recipes ship via the `goose` ansible role (`templates/*.j2` → `~/.config/goose/recipes/*.yaml`) on judah only. Recipes are pure data — no inline secrets, no model config. The wrapper injects `$RW_URL`, `$etzhayyim_AGENT_TOKEN`, and the cadence env.

### AT Protocol federation (optional per recipe)

Each recipe has a Step 4 guarded by `$etzhayyim_AGENT_TOKEN_OK`. The wrapper sets it when `etzhayyim agent-token --lxm com.atproto.repo.createRecord -sub did:web:yoro.etzhayyim.com` returns a valid 60s ES256 JWT. Without a live `etzhayyim authn signin` session on judah, Step 4 is skipped and only the RisingWave direct write lands — the actor-manifest pipeline still produces the domain record, just without public federation. Gated on session-auth provisioning for the yoro DID.

### Scaling the pattern to other actors

Topology is actor-agnostic. To add a new T1 actor (e.g. `mangaka.etzhayyim.com`):

1. Read the actor's `actor-manifest.jsonld` `convoSystemPrompt` + `pipelines[]`
2. Copy `yoro-persona-cron.yaml.j2` → `<actor>-persona-cron.yaml.j2`, swap the persona string + DIDs + collections
3. Map each cron/subscribeRepos trigger to a goose recipe (one recipe per trigger)
4. Append to `goose_recipes:` in `roles/goose/defaults/main.yml` with `repo_did` + `heartbeat_collection` + `cadence_ms`
5. `ansible-playbook site.yml --tags=goose --limit judah` — wrapper + crontab + recipe validate automatic

Constraint: judah-only. Scaling out to multiple hosts requires partitioning by `repo_did` (a different `goose_gateway` host per actor DID) so two wrappers never race on the same `vertex_repo_commit` row.

## Qwen 3.5 9B vs Opus 4.6 Benchmark (2026-03-31, simeon M4 16GB)

**Qwen3.5-9B-4bit** (mlx-community, M4 Mac Mini 16GB) vs **Claude Opus 4.6** (API)。6 task、max_tokens=200、temperature=0.3。

### Performance

| Metric | Qwen 3.5 9B 4-bit | Opus 4.6 |
|---|---|---|
| **Peak memory** | 5.1 GB | N/A (cloud) |
| **Avg throughput** | 18.2 tok/s | ~80-100 tok/s (API) |
| **Avg latency (200 tok)** | 9.8s | ~2-3s (API) |
| **Cost per 1M tokens** | ¥0 (on-prem) | ~$15 input / $75 output |

### Quality Comparison (6 tasks)

| Task | Qwen 3.5 9B | Opus 4.6 | Winner |
|---|---|---|---|
| **math** (17×23+45) | Correct (391+45=436)。PEMDAS 解説付き、分解計算あり | Correct。簡潔で正確 | Draw |
| **code** (palindrome) | 正しい実装。type hints + docstring + normalize。末尾でプロンプト繰返し (200tok 切れ) | 正しい実装。edge case 考慮、テスト例付き | Opus (completeness) |
| **reasoning** (3 fields) | 正しい代数的解法。B=175, A=350, C=175。200tok で途中切れ | 完全な解答 + 検算 | Draw (both correct) |
| **japanese** (三権分立) | `<think>` タグで思考過程を出力、実際の回答が 200tok 内に収まらず | 立法(国会)・行政(内閣)・司法(裁判所) を簡潔に説明 | Opus (format) |
| **summarize** (TCP/UDP) | Markdown 表形式で比較。Reliability/Ordering/Speed を網羅 | 同等の構造化比較 | Draw |
| **creative** (haiku) | "Silicon dreams awake / Learning patterns from the past / Future takes its shape" (5-7-5 正確) | 同等の品質 | Draw |

### Quality Score (5-point scale)

| Dimension | Qwen 3.5 9B | Opus 4.6 |
|---|---|---|
| **Correctness** | 4.5/5 | 5.0/5 |
| **Completeness** | 3.5/5 (200tok cutoff + `<think>` tag overhead) | 5.0/5 |
| **Format/Readability** | 4.0/5 | 5.0/5 |
| **Japanese** | 3.0/5 (`<think>` で token 浪費) | 5.0/5 |
| **Code quality** | 4.5/5 | 5.0/5 |
| **Overall** | **3.9/5** | **5.0/5** |

### Key Observations

- **Qwen 3.5 = reasoning model**: `<think>` タグで内部推論を出力する。日本語タスクでは思考過程が 200 tokens の大半を消費し、回答本体が切れる
- **Math/Code は Opus 相当**: 基本的な数学・コーディングは正確で実用的
- **Cost efficiency**: Opus $75/M output tokens に対し、on-prem ¥0。heartbeat/shinka 等の大量低コスト推論に最適
- **推奨用途**: `heartbeat` (joucho cadence)、`shinka` (社会進化)、`general` (汎用応答) — 高頻度・低コスト推論。`reasoning`/`kyumei-koji` は引き続き Opus/Qwen3-30B 推奨

### Qwen 3.5 27B Opus-Distill GGUF (2026-03-31, naphtali M4 16GB) — 実用不可

`Jackrong/Qwen3.5-27B-Claude-4.6-Opus-Reasoning-Distilled-v2-GGUF` Q4_K_M (16.5GB) を naphtali (M4 16GB) でテスト。

| Metric | Result |
|---|---|
| Model load | 57.3s (mmap + swap) |
| 10 tokens 生成 | **692s** (0.014 tok/s) |
| Swap 使用 | ~5GB |
| GPU offload | ngl=0 (CPU only、ngl=20 は hang) |

**結論**: Q4_K_M (16.5GB) は M4 16GB unified memory を超過し、swap thrashing で ~700x 遅い。**32GB+ ノード必須。** 9B 4-bit (5.1GB, 18.2 tok/s) が 16GB fleet の実用上限。

## CRITICAL: yoro Human Participation Credits

→ `etzhayyim dodaf tv1 query --id etzhayyim-project-murakumo-yoro-human-participation-credits` / MCP `etzhayyim.dodaf.tv1.query`

## Model Family: `etzhayyim/etzhayyim-moe-moe-kyun` (9-Node Mac Mini Cluster)

**Opus 4.6 (1M context) distilled specialist model family。** Naming: `etzhayyim/etzhayyim-moe-moe-kyun-{specialist}-{version}`。Cloud orchestration (CoordinatorDO + B2) + Mac Mini M4 × 9 ノード MLX LoRA。

### Hayate V4a

| Model | Params | Architecture | Best PPL | Speed | API Model ID |
|---|---|---|---|---|---|
| **hayate-v4** (DID-Neuron MoE) | **172M** | SSM+LinearAttn+DomainPKM+FFN (512d, 4L) | **1.10** | 23.8 tok/s | `hayate-v4` |

**Custom architecture**: `hayate_serve.py` が inference server。`daemon.py` の `run_inference()` で routing。7/9 nodes に checkpoint deployed。

### Verified Baseline

| Node | Model | Params | RAM | Speed | Date |
|---|---|---|---|---|---|
| benjamin | etzhayyim-moe-moe-kyun-general-v0 (Qwen2.5-3B) | 3.1B | 2.0 GB | 19.7 tok/s | 2026-03-24 |
| simeon | Qwen3.5-9B-4bit (mlx-community) | 9.2B | 5.1 GB | 18.2 tok/s avg (20.9 peak) | 2026-03-31 |
| zebulun | Qwen3.5-9B-4bit (mlx-community) | 9.2B | 5.1 GB | verified | 2026-03-31 |

### Specialist Registry (9-Node Cluster)

| Node | Model ID (`etzhayyim-moe-moe-kyun-*`) | Base | RAM |
|---|---|---|---|
| benjamin | `codegen-v1` | gemma-4-12b-it-4bit | ~7GB |
| joseph | `refactor-v1` | gemma-4-12b-it-4bit | ~7GB |
| judah | `review-v1` | gemma-4-12b-it-4bit | ~7GB |
| issachar | `wit-v1` | gemma-4-12b-it-4bit | ~7GB |
| dan | `compliance-v1` | gemma-4-12b-it-4bit | ~7GB |
| simeon | `general-v2` | Qwen3.5-9B-4bit | 5.1GB |
| zebulun | `heartbeat-v2` | Qwen3.5-9B-4bit | 5.1GB |
| asher | `i18n-v1` | gemma-4-12b-it-4bit | ~7GB |
| naphtali | `security-v1` | gemma-4-12b-it-4bit | ~7GB |

### Long-Context Distillation (Opus 優位性活用)

```
Layer 1: CoT Distillation — step 分解 (各 2-4K ctx)
Layer 2: Chunked Summary — chunk→summarize→integrate
Layer 3: Orchestrator — Opus plan ($3) → moe-kyun execute ($0) → Opus verify (10%)
```

### LongDistill-Bench η 目標 (moe-kyun-*)

| Level | Context | codegen | refactor | review | compliance | security |
|---|---|---|---|---|---|---|
| LDB-1 | 2K | 0.92 | — | — | — | — |
| LDB-3 | 20K | — | 0.85 | 0.80 | — | 0.78 |
| LDB-4 | 100K | — | 0.78 | 0.75 | 0.80 | 0.75 |
| LDB-6 | 500K | — | 0.65 | — | 0.72 | — |

### Version Scheme

`v1` = single-shot distill, `v2` = CoT distill, `v3` = long-context distill, `v{N}p` = patch

### Architecture

```
CLI → Worker (CoordinatorDO) → R2 + NativeWorkerDO dispatch
                                        ↓
                              Mac Mini cluster (9 nodes, MLX)
                              R2 ↔ train ↔ R2

Production (long task):
  Opus plan (1M ctx) → R2 cache → Student execute (4-32K ctx) → Opus verify (10%)
```

### API Status (verified 2026-04-07)

| Endpoint | Status | Notes |
|---|---|---|
| `GET /health` | **200 OK** | `{"status":"ok","sessions":0,"pending":0}` |
| `GET /api/openai/v1/models` | **200 OK** | text + image models |
| `POST /api/openai/v1/chat/completions` (gemma-4-e2b-it) | **200 OK** | **8/8 parallel**, 2s warm / 19s last-in-queue |
| `POST /api/openai/v1/chat/completions` (qwen3.5-4b) | **200 OK** | 22s cold |
| `POST /api/openai/v1/images/generations` | **200 OK** | Python daemon → diffusers SDXL (MPS) |
| `GET /internal/capacity` | **200 OK** | `{idleNative:8, idleBrowser:0, totalPollWorkers:14}` (ghost workers blacklisted) |
| `POST /api/purge-workers` | **200 OK** | 全 worker + task + result クリア — **⚠ ghost workers re-register fresh with consecutiveFailures=0; needs ~7 batches of 8 requests to re-blacklist** |
| `POST /api/reap` | **200 OK** | Stale worker/task reap |

### OpenAI API Auth (2026-03-31)

- `/api/openai/v1/models` と `/api/openai/v1/chat/completions` は API key 必須。
- 認証は `Authorization: Bearer <key>` または `x-api-key: <key>`。
- 本番優先値は Cloudflare Secret `MURAKUMO_API_KEY`。
- 開発用の一時逃げ道が必要な場合のみ `DEV_INSECURE_API_KEY` を明示設定して使う。
- hardcoded fallback key は使用しない。
- `etzhayyim murakumo ingest --extract-raw` も同じ key を利用:
  1. `--extract-api-key`
  2. `MURAKUMO_API_KEY` env
  3. `~/.config/etzhayyim/murakumo_api_key`

### B2 Key Layout (`etzhayyim-moe-moe-kyun/`)

```
etzhayyim-moe-moe-kyun/
  ├── models/{specialist}/v{N}/
  │   ├── teacher-data/{sha256}.json
  │   ├── training/{train,valid}.jsonl
  │   ├── adapter/adapters.safetensors
  │   └── eval/_metrics.json
  ├── benchmarks/ldb-{N}/{model_id}/results.json
  └── orchestrator/plans/{task_id}.json
```

### Sources

- Design doc: `260324-opus-distill-moe-student-design.md`
- Cloud handler: `50-infra/cloudflare/workers/murakumo/src/cloud-distill.ts`
- CLI: `cli/distill.go` (`moeKyunModelID()`)
- WIT: `wit/murakumo/package.wit` — `etzhayyim:murakumo@1.0.0`

## Hard Constraints (2026-05-23 update per ADR-2605231630; 2026-05-11 baseline)

1. **Primary LLM inference = RunPod vLLM** — SSoT ADR-2605010000. RunPod Serverless endpoint
   `vyp99t9px7h4dl` (RTX 6000 Ada 48 GB), image `ghcr.io/etzhayyim/runpod-vllm-gemma:latest`.
   All LLM API traffic routes here. Mac Mini Ollama is **not** LLM SSoT (unchanged).
2. **LLM router = LiteLLM** — OpenAI-compat proxy on judah:4000, pointing to RunPod endpoint via
   `RUNPOD_GEMMA4_OPENAI_BASE` + `RUNPOD_API_KEY`. Master key `sk-etzhayyim-litellm-local`
   (Keychain / secrets.json). Unchanged.
3. **Mac Mini fleet = L8 Somatic Inference + religious-corp cell host** — 10-node Mac Mini M4 fleet
   at `192.168.1.11–21:11434` (Ethernet, per fleet.toml 2026-05-21) remains active for resident
   organism actor inference (ADR-2605080600). **Additionally (per ADR-2605231630): the same fleet
   hosts religious-corp Pregel cells as k3s Pods on Lima VMs (ADR-2605232100, ansible-driven).**
   Not exposed via murakumo.etzhayyim.com public endpoint.
4. **Canonical agent runtime = LangGraph + kotoba-datomic + langserver** (per ADR-2605231630). Goose
   cron recipes on judah (ADR-0034 scope) are **retired**: yoro pipelines re-implement as
   LangGraph cells under `40-engine/kotoba/crates/kotoba-kotodama/cells/yoro_*/`. Ollama (model backend) and LiteLLM
   (router) stay; only the Goose agent loop is removed.
5. **Ray / Nomad / Aeron / UCX / RDMA 禁止 — 再導入禁止.** K8s / k3s / WireGuard are permitted
   for etzhayyim/* religious-corp cell scope **only** (per ADR-2605231630 + ADR-2605232100).
   Vultr / EKS / GKE / AKS / DigitalOcean Kubernetes remain prohibited (ADR-2605191346 §1) —
   self-hosted k3s on Mac mini Lima VMs is the only permitted form.
6. **No custom inference server** — `serve_plain.py` (MLX + Starlette) and `daemon.py` are
   dead. Any new inference server on Mac Mini uses Ollama.

## Fleet Topology

### RunPod GPU Cluster (primary — LLM SSoT, ADR-2605010000)

| Endpoint ID | GPU | Role | API base |
|---|---|---|---|
| `vyp99t9px7h4dl` | RTX 6000 Ada 48 GB | **Primary vLLM inference** | `https://api.runpod.ai/v2/vyp99t9px7h4dl/openai/v1` |

- Image: `ghcr.io/etzhayyim/runpod-vllm-gemma:latest`
- Model: `gemma-4-e4b-it` (served via vLLM OpenAI-compat API)
- Auth: `RUNPOD_API_KEY` env var on LiteLLM host

### Mac Mini M4 Fleet (L8 Somatic Inference — resident organism actors only)

| Node | IP | Role | SSH user |
|---|---|---|---|
> **IPs updated 2026-05-23 per fleet.toml 2026-05-21 Ethernet-side verification (ADR-2605211910 + ADR-2605231630).** The .49–.67 range below was the pre-migration WiFi-side inventory; current Ethernet-side IPs (mDNS + ARP from jacob, 2026-05-21) are .11–.21.

| Node | IP (Ethernet, fleet.toml 2026-05-21) | Role | SSH user |
|---|---|---|---|
| judah | 192.168.1.17 | **LiteLLM gateway (:4000) + Ollama (:11434)** (Goose retired per ADR-2605231630) | judah |
| benjamin | 192.168.1.14 | Ollama backend (L8 somatic) | benjamin |
| joseph | 192.168.1.15 | Ollama backend (L8 somatic) | joseph |
| issachar | 192.168.1.12 | Ollama backend (L8 somatic) | issachar |
| simeon | 192.168.1.19 | Ollama backend (L8 somatic) + IPFS pinner | simeon |
| dan | 192.168.1.13 | Ollama backend (L8 somatic) | dan |
| naphtali | 192.168.1.18 | Ollama backend (L8 somatic) | naphtali |
| levi | 192.168.1.16 | Ollama backend (L8 somatic) | levi |
| zebulun | 192.168.1.11 | Ollama backend (L8 somatic) | zebulun |
| asher | 192.168.1.21 | Ollama backend (L8 somatic) | asher |

SSH config (`~/.ssh/config`) + `/etc/hosts` に全 10 node 登録済 (operator's primary machine).
On other dev machines `/etc/hosts` may need population from `50-infra/murakumo/fleet.toml`
ip_lan column; the Ansible inventory at `ansible/inventory/hosts.yml` uses the short
hostname (e.g. `naphtali`) as both `ansible_host` and SSH alias.
Mac Mini fleet は公開 `murakumo.etzhayyim.com` エンドポイントを経由しない。

## Dead Components (再導入禁止)

Retired inference + orchestration stacks. Source archived under
`60-apps/etzhayyim-project-murakumo/_archive/` or deleted; git history preserves.

| Stack | Why dead | Replaced by |
|---|---|---|
| `serve_plain.py` (MLX + Starlette + uvicorn) | Single-thread saturation @ ~10 concurrent; dead cdn.etzhayyim.com B2 tarball fallback; crash-loops on root-owned hf_hub cache | Ollama per-node (continuous batching, model lifecycle, OpenAI-compat API built-in) |
| `cli/daemon.py` (Nomad poll loop) | Ghost-worker blacklist complexity, CoordinatorDO state entropy H=2.58, model affinity bugs | Stateless LiteLLM `simple-shuffle` router — no per-worker state |
| Nomad 1.11.3 + SSH tunnel + port-forward.py | macOS LN Privacy workaround stack, 3-server quorum burden, manual Screen Sharing for LN allow | @reboot crontab + Ollama LAN bind (`OLLAMA_HOST=0.0.0.0:11434`) |
| CoordinatorDO (7 DOs, 3519 lines) | Worker-pool orchestration on CF Durable Objects | Ollama's own process model; no orchestration layer needed |
| B2 `cdn.etzhayyim.com/mlx-models/*.tar.gz` | URL deprecated, 404s, no replacement | `ollama pull` (HF Hub direct) |
| Rust daemon CLI (`cli/src/*.rs`, Cargo.toml) | Superseded by Python `serve_plain.py`, now both dead | Ollama |
| V1 wrangler.jsonc / V1 CF Worker | Stateless rewrite | Current `50-infra/cloudflare/workers/murakumo/` Tier 1 (Linode GPU Ollama via `ollama-tunnel.etzhayyim.com`) |
| Aeron / UCX / RDMA / Ray / Nomad / geth / LanceDB projections | Architectural dead ends | n/a |
| **K8s / k3s / WireGuard (Murakumo LLM scope)** | Was dead 2026-05-11 for Murakumo LLM substrate — **un-deaded 2026-05-23 (ADR-2605231630) for etzhayyim/* religious-corp cell scope only.** Self-hosted k3s on Mac mini Lima VMs is the canonical religious-corp cell substrate per ADR-2605232100. Commercial K8s (Vultr / EKS / GKE / AKS) remains prohibited (ADR-2605191346 §1). | k3s on Lima VMs across Mac mini fleet via `60-apps/etzhayyim-project-murakumo/ansible/k8s-gpu-cluster.yml` |
| **Goose agent runtime (ADR-0034 scope)** | Single-runtime canonical policy (ADR-2605231630). Recipe-size <3KB ceiling, qwen3.5:9b tool-call brittleness, dollar-quoted-string SQL incompatibility, --no-profile + 16K-context tuning fragility — already breaking down at 3 recipes (yoro). Cannot host the 15-cell religious-corp catalog or the 18,342 UNSPSC actors. | LangGraph cells under `40-engine/kotoba/crates/kotoba-kotodama/cells/` + langserver XRPC façade (per ADR-2605202200 + ADR-2605232100), reference impl `lg-open-unispsc` |
| **Virtual Kubelet (Murakumo Kubelet, 50-infra/k8s/murakumo-kubelet/)** | Retained as a **bridge** to RunPod for GPU burst (ADR-2605110100 vendor-monorepo). Not "dead", but scoped to GPU-burst overflow only. | unchanged — retain as bridge component |
| `/api/purge-workers`, `consecutiveFailures` ghost-worker blacklist | Patch for CoordinatorDO worker-pool staleness | No worker pool; LiteLLM retries transient 5xx transparently |
| MLX `gemma-4-e2b-it-4bit` weights + `mlx_lm.generate` chat template | Agent-loop rejection + single-thread | Ollama `gemma3:1b` (GGUF); larger models via `ollama pull` |
| `venv` ansible role (mlx_lm + starlette) | Retired with serve_plain.py | Ollama's own runtime, no Python venv on fleet nodes |
| `daemon` ansible role (scp daemon.py + Nomad restart) | Retired with daemon.py | `ollama` ansible role (brew + @reboot cron) |
| OpenClaw gateway (`ai.openclaw.gateway` LaunchAgent, `~/.openclaw/`) | Cron runner was chat-completion-once: never injected `tools[]`, never parsed `tool_calls` → every scheduled job was a silent no-op. Gateway + isolated-agent + pairing model duplicated goose capabilities. | `goose` (ADR-0034): recipes per actor-manifest pipeline, wrapper-owned deterministic side effects, native Ollama tool-use. Idempotent `purge_openclaw.yml` task in goose role cleans up leftover plist + `~/.openclaw/` on first apply. |
| `openclaw` ansible role + `openclaw-play.yml` + `openclaw_gateway` inventory group | Retired with the LaunchAgent (2026-04-20). | `goose` role (`roles/goose/`), `goose_gateway` group. |
| `70-tools/etzhayyim/etzhayyim/openclaw.go` CLI proxy | Unused shim around the retired `openclaw` binary. | Deleted 2026-04-20; `etzhayyim agent-token --lxm` covers the scoped-auth use case. |
