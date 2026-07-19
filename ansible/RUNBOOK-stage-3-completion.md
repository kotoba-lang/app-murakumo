---
id: runbook-stage-3-completion-2026-05-23
title: "Stage 3 completion runbook — 2026-05-23 operator-side actions"
status: active
doc_type: how-to
topic: stage-3-completion
authoritative: true
last_verified: 2026-05-23
authoritative_for:
  - simeon / levi Lima network-bind issue resolution
  - joseph / issachar / dan manual bootstrap workaround
  - ansible-playbook gather_facts hang on jacob dev machine
related:
  - 90-docs/adr/2605232100-religious-corp-cells-on-k3s-daemonset.md
  - 90-docs/adr/2605231630-langgraph-chain-server-canonical-goose-retirement.md
---

# Stage 3 Completion Runbook (2026-05-23)

Per ADR-2605232100 §Migration plan Stage 3. At session close 2026-05-23 ~18:30 JST,
4 of 10 Mac mini nodes (naphtali control-plane + benjamin / judah / zebulun
agents) are joined to the k3s cluster running 14/15 religious-corp cell
DaemonSets. The remaining 6 nodes need operator-side action.

## Current cluster state

```bash
ssh naphtali@naphtalinomac-mini.local \
  'export PATH=/opt/homebrew/bin:/opt/homebrew/sbin:$PATH; \
   limactl shell k3s-server -- kubectl get nodes'
```

Should report:

```
NAME       STATUS   ROLES           AGE    VERSION
benjamin   Ready    <none>          ...    v1.35.5+k3s1
judah      Ready    <none>          ...    v1.35.5+k3s1
naphtali   Ready    control-plane   ...    v1.35.5+k3s1
zebulun    Ready    <none>          ...    v1.35.5+k3s1
```

## Outstanding issues per node

### simeon + levi — Lima image download `EADDRNOTAVAIL`

**Symptom**: `limactl start k3s-agent` fails:

```
dial tcp 185.125.190.37:443: connect: can't assign requested address
```

Curl to `cloud-images.ubuntu.com` returns HTTP 000 from these two nodes, while
joseph / naphtali / judah / etc. return HTTP 200 to the same URL.

**Root cause** (suspected): macOS network bind to nonexistent local source
address — IPv6 priority + IPv4 fallback broken, or an active VPN client
binding the outbound interface.

**Fix path (operator, physical access required)**:

```bash
ssh simeon@simeonnomac-mini.local
# Check active network interfaces
ifconfig | grep -E "^[a-z]|inet " | head -20
# Look for VPN clients (utun*, tun*)
ifconfig | grep -E "utun|tun"
# Reset network state
sudo dscacheutil -flushcache
sudo killall -HUP mDNSResponder
sudo route -n flush
# Retry the URL — should return HTTP 200
curl -sI -m 10 -o /dev/null -w "HTTP %{http_code}\n" \
  https://cloud-images.ubuntu.com/releases/noble/release/ubuntu-24.04-server-cloudimg-arm64.img
```

**Alternative**: simeon + levi have a stale `~/.lima/k3s-agent/lima.yaml` referencing
Ubuntu 24.04 (current Lima template uses Fedora 43 per the ansible role at
`roles/lima_k3s_gpu/templates/lima-k3s.yaml.j2`). Delete + recreate:

```bash
ssh simeon@simeonnomac-mini.local 'export PATH=/opt/homebrew/bin:$PATH; \
  limactl delete -f k3s-agent'
# Then re-run ansible bootstrap (after the network bind is fixed):
cd 60-apps/etzhayyim-project-murakumo/ansible
MURAKUMO_K3S_TOKEN="..."  ansible-playbook -i inventory/hosts.yml \
  k8s-gpu-cluster.yml --tags=bootstrap \
  --ssh-extra-args="-o ControlMaster=no -o ConnectTimeout=10" \
  --limit "simeon,levi" -f 2
```

### joseph + issachar + dan — `~/.lima/` not yet created

**Symptom**: SSH works fine, Lima 2.1.1 installed, but `~/.lima/` directory does
not exist on these nodes. No Lima instance has ever been created.

**Network**: HTTP 200 to `cloud-images.ubuntu.com` confirmed — they should be
able to bootstrap once `ansible-playbook --tags=bootstrap` is run successfully.

**Blocker on jacob dev machine 2026-05-23**: `ansible-playbook` hangs at
"Gathering Facts" for the bootstrap play (even with `ControlMaster=no` +
`ANSIBLE_GATHER_TIMEOUT=15`). The ad-hoc `ansible -m ping` works fine on the
same nodes individually. The `--tags=tools` and `--tags=preflight` stages
also worked, but `--tags=bootstrap` exhibits the hang. Root cause TBD —
possibly the bootstrap-specific tasks (downloading + creating VM disk via
limactl) take long enough that ansible-playbook's task timeout interacts
poorly with this dev machine's SSH config.

**Workaround 1 (recommended)** — run the playbook from a different host:

The naphtali Mac mini is already provisioned with Lima + krunkit + Homebrew.
Copy the ansible playbook to naphtali (via rsync) and run from there. The
WireGuard wg0 path between naphtali (control-plane) and joseph / issachar /
dan should be fast.

```bash
rsync -a 60-apps/etzhayyim-project-murakumo/ansible/ \
  naphtali@naphtalinomac-mini.local:~/ansible-stage-3/
ssh naphtali@naphtalinomac-mini.local 'cd ~/ansible-stage-3 && \
  MURAKUMO_K3S_TOKEN="<token>" \
  ansible-playbook -i inventory/hosts.yml k8s-gpu-cluster.yml \
  --tags=bootstrap --limit "joseph,issachar,dan" -f 3'
```

The `MURAKUMO_K3S_TOKEN` for the existing cluster is the contents of
`/var/lib/rancher/k3s/server/node-token` inside naphtali's k3s-server Lima VM:

```bash
ssh naphtali@naphtalinomac-mini.local \
  'export PATH=/opt/homebrew/bin:/opt/homebrew/sbin:$PATH; \
   limactl shell k3s-server -- sudo cat /var/lib/rancher/k3s/server/node-token'
```

**Workaround 2** — manual `limactl create` per node:

1. Get the rendered Lima config from naphtali's existing instance:
   ```bash
   ssh naphtali@naphtalinomac-mini.local 'cat ~/.lima/k3s-server/lima.yaml' \
     > /tmp/lima-k3s-agent.yaml
   # Edit to remove server-specific bits (it's a k3s-server config;
   # k3s-agent config is similar but joins instead of inits)
   ```

2. SCP + create + start on each node:
   ```bash
   for h in joseph issachar dan; do
     scp /tmp/lima-k3s-agent.yaml $h@${h}nomac-mini.local:/tmp/
     ssh $h@${h}nomac-mini.local '
       export PATH=/opt/homebrew/bin:/opt/homebrew/sbin:$PATH
       limactl create --name=k3s-agent /tmp/lima-k3s-agent.yaml
       limactl start k3s-agent
     '
   done
   ```

3. Inside each VM, install k3s with the server's address + token (manual k3s
   join command — see [k3s docs](https://docs.k3s.io/quick-start#high-availability-with-embedded-db)).
   The ansible playbook automates this; doing it manually is error-prone and
   recommended only if Workaround 1 fails.

### asher — IP confirmation (already resolved)

`192.168.1.21` reachable (ping 0.858ms). `fleet.toml` value is correct. The
Murakumo CLAUDE.md `.54` IP was old WiFi-side inventory; ADR-2605231630 +
the 2026-05-23 fleet.toml update set the SoT to `.21`.

## Cell deployment state

14 of the 15 religious-corp cells (per `kubectl -n etzhayyim-cells get pods`)
are 1/1 Ready and stable for 30+ min. The remaining cell —
`charter-attestation-request-cell` — was in CrashLoopBackOff due to a
`build_graph()` signature mismatch in `cells/charter_attestation_request/cell.py`.
The fix landed in commit `0660207cf` (cell_host adapter introspects the cell
signature, fills CellDeps fields, leaves unknowns None). Once the
`kotodama-image.yml` workflow rebuilds and pushes the new image, restart
the DaemonSet:

```bash
ssh naphtali@naphtalinomac-mini.local 'export PATH=/opt/homebrew/bin:$PATH; \
  limactl shell k3s-server -- kubectl -n etzhayyim-cells \
  rollout restart daemonset/charter-attestation-request-cell'
```

## Known infrastructure issue: WireGuard mesh duplicate IPs

`kubectl get nodes -o wide` reports all 4 nodes with INTERNAL-IP `192.168.5.15`.
This is the WireGuard wg0 address — each node should have a unique IP in the
192.168.5.0/24 range. The current state breaks `kubectl exec` and `kubectl logs`
across nodes (kubelet API at `<NODE_IP>:10250` is unreachable because the IP
collides).

**Symptom**: `kubectl exec / logs` returns:

```
proxy error from 127.0.0.1:6443 while dialing 192.168.5.15:10250, code 502: 502 Bad Gateway
```

**Impact**: Pods do schedule + run (flannel pod-to-pod networking works since
it uses different CIDR 10.42.0.0/16). HTTP probes work (kubelet probes
locally). But operator visibility into running Pods (logs, exec, port-forward)
is broken.

**Fix path**: The `lima_k3s_gpu` role's bootstrap.yml provision script binds
k3s `--node-ip` and flannel to `wg0`. If wg0 isn't getting unique addresses
per VM, the WireGuard config (key exchange, allowed-ips) needs operator
attention. Re-run bootstrap with `lima_k3s_force_recreate=true` may help,
but is destructive.

## Summary

| Node | Status | Operator action |
|---|---|---|
| jacob | control plane host (no Lima needed) | — |
| naphtali | k3s-server Ready 165min | — |
| benjamin | k3s-agent Ready 58min | — |
| judah | k3s-agent Ready 41min | — |
| zebulun | k3s-agent Ready 41min | — |
| simeon | Lima instance partial (Ubuntu template + network bind issue) | Reset network + delete instance + re-bootstrap |
| levi | Lima instance partial (same as simeon) | Same |
| joseph | ~/.lima/ empty | Run bootstrap from naphtali (workaround 1) |
| issachar | ~/.lima/ empty | Same |
| dan | ~/.lima/ empty | Same |
| asher | reachable at .21, no Lima yet | Same |
