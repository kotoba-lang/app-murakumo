# murakumo llama.cpp Vulkan image

This image runs `llama-server` with the `ggml` Vulkan backend on macOS-hosted Linux VMs that expose Apple GPU through Venus/Virtio-GPU.

Verified locally on `jacob`:

- macOS M4 host
- Lima `krunkit`
- k3s
- pod with `/dev/dri` hostPath
- `Vulkan0: Virtio-GPU Venus (Apple M4)`

Build:

```bash
docker build \
  -t ghcr.io/etzhayyim-ai/murakumo-llama-vulkan:local \
  60-apps/etzhayyim-project-murakumo/containers/llama-vulkan
```

Runtime knobs:

- `MODEL_REPO`: Hugging Face GGUF repo
- `MODEL_FILE`: GGUF file in the repo
- `MODEL_ALIAS`: model name exposed by the OpenAI-compatible API
- `N_GPU_LAYERS`: number of layers to offload to Vulkan
- `CTX_SIZE`: context window
- `LIST_DEVICES=1`: print detected devices before starting the server

The official Ollama Linux arm64 install currently falls back to CPU in this setup. Use this image for the k8s GPU route until Ollama has a working Vulkan backend package for this environment.
