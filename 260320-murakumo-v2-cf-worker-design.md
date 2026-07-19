---
id: murakumo-v2-cf-worker-design
title: Murakumo V2 Control Plane Design
status: active
doc_type: explanation
topic: distributed-inference-control-plane
authoritative: true
last_verified: 2026-03-30
---

# Murakumo V2 Control Plane Design

## Purpose

`murakumo` is the control plane for distributed inference and distillation across native and browser workers.

## Runtime Classes

- `native_webgpu`
- `native_cuda`
- `native_cpu`
- browser WebGPU contributor runtime

## Core Components

- Worker: public API and routing entrypoint
- CoordinatorDO: scheduling, leases, result collection
- NativeWorkerDO: native host lifecycle and capability tracking
- InferenceRouterDO: request classification and dispatch
- SessionDO: browser session state

## Control-Plane Responsibilities

- register hosts and pods
- track capabilities and warm models
- dispatch tasks by runtime class and policy
- renew and revoke leases
- commit results and failures
- orchestrate distillation jobs and artifact movement

## Non-Goals

- embedding legacy Python runtimes in the hot path
- implementation-specific references to removed local training scripts
- dependence on deleted `model-moe-moe-kyun/training` assets

## Current Policy

- live inference uses `kotodama-inference` and native WebGPU-oriented runtimes
- removed legacy fallbacks are not part of the design
