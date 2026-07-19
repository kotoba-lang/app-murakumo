---
id: opus-distill-moe-student
title: Opus Specialist Distillation Design
status: active
doc_type: explanation
topic: distillation-pipeline
authoritative: true
last_verified: 2026-03-30
authoritative_for:
  - specialist model design
  - distillation control-plane intent
---

# Opus Specialist Distillation Design

## Goal

Transfer long-horizon task structure from frontier teacher models into smaller specialist models managed by `murakumo`.

## Model Family

- family: `etzhayyim/etzhayyim-moe-moe-kyun`
- naming: `etzhayyim/etzhayyim-moe-moe-kyun-{specialist}-{version}`

## Distillation Focus

- long-context planning
- codebase-wide reasoning
- review and compliance specialists
- structured output fidelity

## Control-Plane Requirements

- teacher sample generation
- dataset validation
- student job scheduling
- artifact registration
- evaluation and rollout gating

## Constraints

- this design is runtime-agnostic at the document level
- removed local legacy assets are not part of the current design surface
- file references must point only to live implementation, not deleted legacy scripts
