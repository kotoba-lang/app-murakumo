# murakumo llama-vulkan k8s deployment

Deploys `llama.cpp` Vulkan server into `murakumo-system`.

This is for Mac mini hosts running Linux/k8s through a VM layer that exposes Apple GPU as `/dev/dri` with Venus/Virtio-GPU. It is not expected to work on plain OrbStack Kubernetes because OrbStack does not currently expose `/dev/dri`.

## Build image

```bash
docker build \
  -t ghcr.io/etzhayyim-ai/murakumo-llama-vulkan:local \
  60-apps/etzhayyim-project-murakumo/containers/llama-vulkan
```

For local k3s, import the image into containerd:

```bash
docker save ghcr.io/etzhayyim-ai/murakumo-llama-vulkan:local \
  | sudo k3s ctr images import -
```

## Deploy

```bash
kubectl apply -k 60-apps/etzhayyim-project-murakumo/k8s/llama-vulkan
kubectl -n murakumo-system rollout status deployment/llama-vulkan
```

## Verify

```bash
kubectl -n murakumo-system logs deploy/llama-vulkan | grep 'Vulkan0'
kubectl -n murakumo-system port-forward svc/llama-vulkan 18080:8080
curl -fsS http://127.0.0.1:18080/health
curl -fsS http://127.0.0.1:18080/v1/models
```

Expected GPU evidence:

```text
Vulkan0: Virtio-GPU Venus (Apple M4)
load_tensors: offloaded 31/31 layers to GPU
```
