# Murakumo Hayate V6 Pipeline Lexicon + CLI

Namespace: `com.etzhayyim.murakumo.*`

## NSID Step Map

1. `com.etzhayyim.murakumo.planPipeline`
2. `com.etzhayyim.murakumo.graphExtract`
3. `com.etzhayyim.murakumo.graphIngest`
4. `com.etzhayyim.murakumo.coverageExport`
5. `com.etzhayyim.murakumo.fleetPlan`
6. `com.etzhayyim.murakumo.trainExperts`
7. `com.etzhayyim.murakumo.evalV6`
8. `com.etzhayyim.murakumo.runPipeline`

Lexicon JSON files live under:
`60-apps/etzhayyim-project-murakumo/lexicons/com/etzhayyim/murakumo/*.json`

## etzhayyim CLI Mapping

- `etzhayyim murakumo plan`
- `etzhayyim murakumo graph-extract --labels <comma labels> --output /Volumes/251220/graph_results/graph_entities.jsonl`
- `etzhayyim murakumo graph-ingest --input /Volumes/251220/graph_results --lancedb-uri /Volumes/251220/lancedb --push-yata`
- `etzhayyim murakumo coverage-export --output /Volumes/251220/coverage_domains`
- `etzhayyim murakumo fleet-plan --data-dir /Volumes/251220/expert_domains --target-slots 500000`
- `etzhayyim murakumo train-experts --n-labels 8 --samples-per 5000 --epochs 2`
- `etzhayyim murakumo eval --mode quick --cypher`

Generic XRPC invocation:

```bash
etzhayyim murakumo xrpc --nsid com.etzhayyim.murakumo.graphExtract --payload-file payload.json
```

## Data Path Contract

- Graph extraction output: `/Volumes/251220/graph_results/*.jsonl`
- Graph ingest tables: `graph_entities`, `graph_relations` in `/Volumes/251220/lancedb`
- Coverage export: `/Volumes/251220/coverage_domains`
- Fleet inputs: `/Volumes/251220/expert_domains`
- Yata graph path: `/Volumes/251220/yata`
