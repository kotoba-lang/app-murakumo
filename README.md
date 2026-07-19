# murakumo — etzhayyim distributed cluster

Mac-mini fleet + custom Rust kubelet + launchd control plane. **No VKE, no Karmada, no commercial K8s** (per ADR-2605191346).

## What lives where

| Concern | Path |
|---|---|
| Fleet definition (10 nodes × 15 cells) | `50-infra/murakumo/fleet.toml` |
| Cluster runtime (Rust: node CLI, tailmesh, worker, daemon) | `50-infra/cluster/murakumo/` |
| Custom kubelet (no K8s API server required) | `50-infra/k8s/murakumo-kubelet/` |
| Cell runner (kotodama-cell-runner launchd plist) | `50-infra/cluster/murakumo/cell-runner/` |
| LiteLLM gateway (launchd, 127.0.0.1:4000) | `50-infra/cluster/murakumo/litellm/` |
| Cloudflare Worker (edge proxy) | `50-infra/cloudflare/workers/murakumo/` |
| Multicluster placement contract (mesh, no Karmada) | `50-infra/multicluster/murakumo-mesh/` |
| Lexicons (XRPC contracts) | `00-contracts/lexicons/com/etzhayyim/{murakumo,apps/murakumo,apps/murakumoFleet}` + `00-contracts/lexicons/com/etzhayyim/murakumo` |
| BPMN process contracts | `00-contracts/bpmn/com/etzhayyim/murakumo/` |
| Browser-side inference (ameno) | `orgs/etzhayyim/com-etzhayyim-ameno/` |
| This project shell (metadata + model roster) | `60-apps/etzhayyim-project-murakumo/` |

## Control plane

- **No commercial K8s** (per ADR-2605191346). Replaced by:
  - `launchd` on each Mac mini node (`com.etzhayyim.kotodama-cell-runner.plist`)
  - Swarm-style **leader election** (ADR-2605191603)
  - **Broadcast** + **heartbeat** protocols (ADRs 2605191524 / 2605191645)
  - Self-hosted **tailmesh** (X25519 + XChaCha20-Poly1305 — no Tailscale dependency); see `50-infra/cluster/murakumo/src/murakumo_mesh.rs`
- **Custom kubelet** (`50-infra/k8s/murakumo-kubelet`) for any node that needs pod-like semantics, talking to the swarm control plane rather than a K8s API server.

## Fleet topology

10 Mac minis named for the 12 tribes (per ADR-2605182312):

```
naphtali  charter-compliance leader + kuni-umi survey leader
simeon    ipfs-pinner + stewardship leader + commission leader
judah     land-trust leader
zebulun   economic + planning leader
levi      membership + council orchestration + audit leader
joseph    phenotype-agent shard 0 + construction leader
issachar  phenotype-agent shard 1
dan       phenotype-agent shard 2 + decommission leader
benjamin  force + ethics leader
asher     replica + failover (any cell)
```

External GPU pod for heavy LLM/image/audio: **evo-x2** (AMD Ryzen AI Max+ 395 + Radeon 8060S, Windows; LAN-only, ADR-2605202345).

## Boundary notes (vendor vs religious-corp)

This is the **etzhayyim** murakumo. The vendor (etzhayyim Japan) keeps a separate RunPod-based inference platform at `etzhayyim.com` for paid SaaS workloads. They share no infrastructure — only the `com.etzhayyim.*` lexicon namespace (vendor-authored, religious-corp-borrowable). etzhayyim murakumo does **not** call out to RunPod, Vultr VKE, Linode GPU, or any commercial K8s.
