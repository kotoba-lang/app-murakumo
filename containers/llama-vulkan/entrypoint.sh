#!/usr/bin/env sh
set -eu

if [ "${LIST_DEVICES:-0}" = "1" ]; then
  /app/llama-cli --list-devices
fi

exec /app/llama-server \
  --host "${HOST}" \
  --port "${PORT}" \
  --alias "${MODEL_ALIAS}" \
  --hf-repo "${MODEL_REPO}" \
  --hf-file "${MODEL_FILE}" \
  --n-gpu-layers "${N_GPU_LAYERS}" \
  --ctx-size "${CTX_SIZE}" \
  --threads "${THREADS}" \
  ${EXTRA_ARGS:-}
