# Pre-Ollama fleet artefacts (archived 2026-04-18)

Superseded by the Ollama + LiteLLM topology. See root CLAUDE.md §Architecture
shift — Ollama fleet + LiteLLM (2026-04-18 pm).

| Path | Was | Replaced by |
|---|---|---|
| `ray/serve_plain.py` | MLX + Starlette custom inference server on each Mac Mini | Ollama (`brew install ollama`, per-node service) |
| `ray/wan4_native_exec.ts` | TS helper for legacy exec path | n/a |
| `ray/dist/` | compiled artefacts | n/a |
| `cli/` | Rust + TS harness for local experimentation | Direct `ollama run …` / `curl` |

Safe to delete entirely once ADR confirms no external consumer needs MLX-specific
behaviour. Keep until `[[migrations]] murakumo-cf-worker-litellm-rewire` is closed
and public `murakumo.etzhayyim.com` runs through LiteLLM.
