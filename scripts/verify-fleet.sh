#!/bin/bash
# verify-fleet.sh — V3 fleet health check (Cloudflare Tunnel + SSH)
#
# Checks:
#   1. SSH-reachable nodes: serve_plain.py health + cloudflared + swap
#   2. Public API: models list
#   3. CF Tunnel E2E: inference success rate (sample 8 requests)
#
# No Nomad dependency. Works from any machine with SSH access to fleet nodes.

set -euo pipefail

MURAKUMO_URL="${MURAKUMO_URL:-https://murakumo.etzhayyim.com}"
API_KEY="${MURAKUMO_API_KEY:-}"
MODEL="${MURAKUMO_MODEL:-gemma-4-e4b-it}"
SSH_NODES=(
  "benjamin:192.168.1.51"
  "dan:192.168.1.52"
  "simeon:192.168.1.59"
  "naphtali:192.168.1.64"
  "levi:192.168.1.65"
)
E2E_SAMPLES="${E2E_SAMPLES:-8}"
E2E_TIMEOUT="${E2E_TIMEOUT:-12}"
MIN_SUCCESS_RATE="${MIN_SUCCESS_RATE:-70}"

pass=0; fail=0; warn=0

_ok()   { echo "  OK   $*"; pass=$((pass+1)); }
_warn() { echo "  WARN $*"; warn=$((warn+1)); }
_fail() { echo "  ERR  $*"; fail=$((fail+1)); }

echo "=== murakumo fleet verify (V3) ==="
echo "  url=$MURAKUMO_URL  model=$MODEL  samples=$E2E_SAMPLES"
echo ""

if [ -z "$API_KEY" ]; then
  echo "MURAKUMO_API_KEY is required" >&2
  exit 1
fi

# ── 1. SSH node checks ──────────────────────────────────────────────
echo "── 1. SSH node checks ──"
healthy_nodes=0
for entry in "${SSH_NODES[@]}"; do
  node="${entry%%:*}"
  ip="${entry##*:}"
  printf "  %-10s (%s): " "$node" "$ip"

  if ! ssh -o ConnectTimeout=4 -o BatchMode=yes -o StrictHostKeyChecking=no \
      "${node}@${ip}" true 2>/dev/null; then
    _fail "SSH unreachable"
    continue
  fi

  # Collect node data via single SSH call — all variables escaped with backslash
  raw=$(ssh -o ConnectTimeout=8 -o BatchMode=yes -o StrictHostKeyChecking=no \
    "${node}@${ip}" '
      h=$(curl -s --max-time 5 http://localhost:8000/health 2>/dev/null || echo "")
      cf=$(ps ax 2>/dev/null | grep -c "[c]loudflared" || echo 0)
      sw=$(sysctl vm.swapusage 2>/dev/null | awk "{print \$7}" | tr -d "M" || echo 0)
      echo "$h|||$cf|||$sw"
    ' 2>/dev/null || echo "|||0|||0")

  health_json="${raw%%|||*}"
  rest="${raw#*|||}"
  cf_count="${rest%%|||*}"
  swap_str="${rest##*|||}"
  swap_int="${swap_str%.*}"
  [ -z "$swap_int" ] && swap_int=0

  # Parse health
  if echo "$health_json" | grep -q '"status":"ok"'; then
    version=$(echo "$health_json" | python3 -c \
      "import sys,json; d=json.load(sys.stdin); print(d.get('version','?'))" 2>/dev/null || echo "?")
    uptime_s=$(echo "$health_json" | python3 -c \
      "import sys,json; d=json.load(sys.stdin); print(d.get('uptime_s',0))" 2>/dev/null || echo 0)
    reqs=$(echo "$health_json" | python3 -c \
      "import sys,json; d=json.load(sys.stdin); print(d.get('requests',0))" 2>/dev/null || echo 0)
    uptime_h=$(echo "$uptime_s / 3600" | bc 2>/dev/null || echo "?")
    serve_ok=1
  else
    serve_ok=0; version="?"; uptime_h="0"; reqs=0
  fi

  # cloudflared
  if [ "${cf_count:-0}" -ge 1 ] 2>/dev/null; then
    cf_note="cf×${cf_count}"
    [ "${cf_count:-0}" -gt 1 ] && cf_note="cf×${cf_count}(!dup)"
    cf_ok=1
  else
    cf_note="cf=MISSING"; cf_ok=0
  fi

  # swap
  if [ "${swap_int:-0}" -gt 6000 ] 2>/dev/null; then
    mem_note="swap=${swap_str}M(!crit)"; mem_ok=0
  elif [ "${swap_int:-0}" -gt 3000 ] 2>/dev/null; then
    mem_note="swap=${swap_str}M(warn)"; mem_ok=1
  else
    mem_note="swap=${swap_str}M"; mem_ok=1
  fi

  if [ "$serve_ok" -eq 1 ] && [ "$cf_ok" -eq 1 ] && [ "$mem_ok" -eq 1 ]; then
    _ok "v${version} up=${uptime_h}h req=${reqs}  ${cf_note}  ${mem_note}"
    healthy_nodes=$((healthy_nodes+1))
  elif [ "$serve_ok" -eq 1 ]; then
    _warn "v${version} up=${uptime_h}h req=${reqs}  ${cf_note}  ${mem_note}"
    healthy_nodes=$((healthy_nodes+1))
  else
    _fail "serve DOWN  ${cf_note}  ${mem_note}"
  fi
done
echo ""

# ── 2. Public API: models list ──────────────────────────────────────
echo "── 2. Public models API ──"
models_json=$(curl -s --max-time 10 \
  "${MURAKUMO_URL}/api/openai/v1/models" \
  -H "x-api-key: ${API_KEY}" 2>/dev/null || echo '{}')
if echo "$models_json" | python3 -c \
    "import sys,json; d=json.load(sys.stdin); assert d.get('object')=='list'" 2>/dev/null; then
  count=$(echo "$models_json" | python3 -c \
    "import sys,json; d=json.load(sys.stdin); print(len(d.get('data',[])))" 2>/dev/null || echo 0)
  has_m=$(echo "$models_json" | python3 -c \
    "import sys,json; d=json.load(sys.stdin); ids=[m['id'] for m in d.get('data',[])]; m='${MODEL}'; print('yes' if any(m in i or i in m for i in ids) else 'no')" \
    2>/dev/null || echo "no")
  if [ "$has_m" = "yes" ]; then
    _ok "${count} models  ${MODEL} present"
  else
    _warn "${count} models  ${MODEL} NOT found"
  fi
else
  _fail "models API unreachable"
fi
echo ""

# ── 3. E2E inference (CF Tunnel) ─────────────────────────────────────
echo "── 3. E2E inference (${E2E_SAMPLES} requests, timeout=${E2E_TIMEOUT}s) ──"
ok_count=0; err_count=0; nodes_seen=""
for i in $(seq 1 "$E2E_SAMPLES"); do
  resp=$(curl -s -w "|||%{http_code}" --max-time "$E2E_TIMEOUT" \
    "${MURAKUMO_URL}/api/openai/v1/chat/completions" \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"ok\"}],\"max_tokens\":4,\"temperature\":0}" \
    2>/dev/null || echo "|||000")
  body="${resp%|||*}"
  http_code="${resp##*|||}"

  if [ "$http_code" = "200" ]; then
    x_node=$(echo "$body" | python3 -c \
      "import sys,json; d=json.load(sys.stdin); print(d.get('x_node','?'))" 2>/dev/null || echo "?")
    gpu_ms=$(echo "$body" | python3 -c \
      "import sys,json; d=json.load(sys.stdin); print(d.get('x_gpu_time_ms','?'))" 2>/dev/null || echo "?")
    echo "    [${i}] 200  ${x_node}  ${gpu_ms}ms"
    ok_count=$((ok_count+1))
    # collect unique node names
    short="${x_node%%noMac*}"; short="${short%%.local}"
    echo "$nodes_seen" | grep -qw "$short" 2>/dev/null || nodes_seen="${nodes_seen} ${short}"
  else
    echo "    [${i}] ERR http=${http_code}"
    err_count=$((err_count+1))
  fi
done

total=$((ok_count+err_count))
pct=$((ok_count * 100 / total))
echo ""
echo "  success: ${ok_count}/${total} (${pct}%)  nodes:${nodes_seen}"

if [ "$pct" -ge "$MIN_SUCCESS_RATE" ]; then
  _ok "E2E ${pct}% >= ${MIN_SUCCESS_RATE}%"
else
  _fail "E2E ${pct}% < ${MIN_SUCCESS_RATE}% threshold"
fi
echo ""

# ── Summary ─────────────────────────────────────────────────────────
echo "══════════════════════════════════════"
printf "  pass=%-3s warn=%-3s fail=%s\n" "$pass" "$warn" "$fail"
echo "  ssh-healthy: ${healthy_nodes}/${#SSH_NODES[@]}"
if [ "$fail" -gt 0 ]; then
  echo "  RESULT: FAIL"
  exit 1
elif [ "$warn" -gt 0 ]; then
  echo "  RESULT: WARN"
  exit 0
else
  echo "  RESULT: PASS"
  exit 0
fi
