#!/usr/bin/env python3
"""murakumo serve — Pure Python MLX inference server.

No Ray dependency. Starlette + uvicorn + mlx_lm.
Cloudflare Tunnel routes requests to localhost:8000.

p99.9 stabilization (v2.2.0):
  - Thinking retry: 1 retry max, 2x budget, 2.5s wall-clock deadline
  - Admission control: semaphore(1) + queue depth cap → 503 if overloaded
  - Deadline propagation: respects X-Deadline-Ms from CF Worker gateway
  - Latency histogram: in-process circular buffer for p50/p95/p99
"""

import asyncio
import base64
import json
import os
import platform
import signal
import socket
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route

VERSION = "2.2.0"
DEFAULT_MODEL = os.environ.get("Etzhayyim_DEFAULT_MODEL", "gemma-4-e2b-it")
R2_MODEL_BASE = os.environ.get("Etzhayyim_R2_MODEL_BASE", "https://cdn.etzhayyim.com/mlx-models")

THINKING_RETRY_DEADLINE_S = 2.5
THINKING_RETRY_MAX = 1
THINKING_RETRY_BUDGET_MULT = 2
THINKING_RETRY_TOKEN_CAP = 16384
ADMISSION_MAX_QUEUE = 2

MODEL_ALIASES = {
    "gemma-4": "mlx-community/gemma-4-e2b-it-4bit",
    "qwen3.5-4b": "Qwen/Qwen3.5-4B",
    "qwen3.5-4b-int8": "Qwen/Qwen3.5-4B",
    "qwen3.5-4b-4bit": "Qwen/Qwen3.5-4B",
    "qwen3.5-9b": "mlx-community/Qwen3.5-9B-4bit",
    "qwen3.5-9b-4bit": "mlx-community/Qwen3.5-9B-4bit",
    "qwen3-vl-4b": "Qwen/Qwen3-VL-4B-Instruct",
    "qwen3-vl-8b": "Qwen/Qwen3-VL-8B-Instruct",
    "gemma-4-4b": "mlx-community/gemma-4-e4b-it-4bit",
    "gemma-4-e4b": "mlx-community/gemma-4-e4b-it-4bit",
    "gemma-4-e4b-it": "mlx-community/gemma-4-e4b-it-4bit",
    "gemma-4-e2b-it": "mlx-community/gemma-4-e2b-it-4bit",
    "gemma-3-12b": "mlx-community/gemma-3-12b-it-4bit",
    "gemma-3-12b-it": "mlx-community/gemma-3-12b-it-4bit",
}

IMAGE_MODEL_ALIASES = {
    "wai-real": "John6666/wai-real-mix-v11-sdxl",
    "wai-real-mix-v11": "John6666/wai-real-mix-v11-sdxl",
    "sdxl": "stabilityai/stable-diffusion-xl-base-1.0",
    "flux-schnell": "black-forest-labs/FLUX.1-schnell",
    "flux-1-schnell": "black-forest-labs/FLUX.1-schnell",
}

AUDIO_MODEL_ALIASES = {
    "musicgen-small": "facebook/musicgen-small",
    "musicgen-medium": "facebook/musicgen-medium",
    "musicgen-melody": "facebook/musicgen-melody",
}

_model = None
_tokenizer = None
_model_id = None
_model_executor = ThreadPoolExecutor(max_workers=1)
_model_lock = threading.Lock()

_inference_queue_depth = 0
_inference_semaphore: asyncio.Semaphore | None = None


def _get_inference_semaphore() -> asyncio.Semaphore:
    global _inference_semaphore
    if _inference_semaphore is None:
        _inference_semaphore = asyncio.Semaphore(1)
    return _inference_semaphore


_latency_buffer: list[float] = []
_LATENCY_BUFFER_SIZE = 1000


def _r2_model_base_candidates() -> list[str]:
    raw = os.environ.get("Etzhayyim_R2_MODEL_BASE_CANDIDATES", "")
    candidates = [part.strip().rstrip("/") for part in raw.split(",") if part.strip()]
    if not candidates:
        candidates = [R2_MODEL_BASE.rstrip("/"), "https://cdn.etzhayyim.com/models"]
    seen: set[str] = set()
    unique: list[str] = []
    for candidate in candidates:
        if candidate and candidate not in seen:
            seen.add(candidate)
            unique.append(candidate)
    return unique


def _safe_tar_filter(member, path):
    """tarfile extraction filter that blocks Zip Slip (Bandit B202).

    Rejects any member whose resolved destination escapes the target dir
    (via ``..`` or absolute paths) and drops unsafe file types (symlinks,
    hardlinks, device/pipe files). Equivalent in spirit to Python 3.12's
    ``filter='data'`` but works on older runtimes too.
    """
    import os
    import tarfile

    # Reject link members outright — model archives are plain files only.
    if member.issym() or member.islnk():
        return None
    if member.isdev() or member.ischr() or member.isblk() or member.isfifo():
        return None

    # Resolve the member path against the extraction base and ensure the
    # final destination stays inside it.
    base = os.path.abspath(path)
    target = os.path.abspath(os.path.join(base, member.name))
    if os.path.commonpath([base, target]) != base:
        raise tarfile.TarError(
            f"unsafe tar member path escapes extraction dir: {member.name!r}"
        )
    # Cap extracted size to a sane bound (512 MiB) to blunt zip-bomb attempts.
    if member.isreg() and member.size > 512 * 1024 * 1024:
        raise tarfile.TarError(
            f"oversized tar member rejected: {member.name!r} ({member.size} bytes)"
        )
    return member


def _r2_download_model(model_id: str) -> str:
    import tarfile
    import time
    from pathlib import Path
    import httpx

    safe_id = model_id.replace("/", "--")
    cache_dir = Path.home() / ".cache" / "huggingface" / "hub" / f"models--{safe_id}"
    snapshot_dir = cache_dir / "snapshots" / "main"
    if snapshot_dir.exists() and any(snapshot_dir.iterdir()):
        return str(snapshot_dir)
    last_err: Exception | None = None
    for base_url in _r2_model_base_candidates():
        r2_url = f"{base_url}/{safe_id}.tar.gz"
        missing_on_r2 = False
        for attempt in range(3):
            if attempt > 0:
                time.sleep(2 ** attempt)
            try:
                resp = httpx.get(r2_url, timeout=600, follow_redirects=True)
                if resp.status_code == 404:
                    missing_on_r2 = True
                    last_err = RuntimeError(f"R2 model archive not found: {r2_url}")
                    break
                resp.raise_for_status()
                snapshot_dir.mkdir(parents=True, exist_ok=True)
                with tarfile.open(fileobj=BytesIO(resp.content), mode="r:gz") as tar:
                    # Zip Slip hardening (Bandit B202): sanitize every member so
                    # a malicious archive cannot escape snapshot_dir via "../"
                    # or absolute paths, and drop unsafe file types (links/devs).
                    tar.extractall(path=str(snapshot_dir), filter=_safe_tar_filter)
                return str(snapshot_dir)
            except Exception as e:
                last_err = e
        if missing_on_r2:
            continue
    raise RuntimeError(f"R2 download failed for {model_id}") from last_err


def _hf_snapshot_download(model_id: str) -> str:
    from huggingface_hub import snapshot_download

    return snapshot_download(repo_id=model_id)


def ensure_model(model_id: str):
    global _model, _tokenizer, _model_id
    if _model_id == model_id and _model is not None:
        return
    with _model_lock:
        if _model_id == model_id and _model is not None:
            return
        from mlx_lm import load
        try:
            model, tokenizer = load(model_id)
        except Exception:
            try:
                local_path = _r2_download_model(model_id)
            except Exception:
                local_path = _hf_snapshot_download(model_id)
            model, tokenizer = load(local_path)
        _model, _tokenizer = model, tokenizer
        _model_id = model_id


async def ensure_model_async(model_id: str) -> None:
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(_model_executor, ensure_model, model_id)


def warmup() -> None:
    model_id = MODEL_ALIASES.get(DEFAULT_MODEL.lower(), DEFAULT_MODEL)
    ensure_model(model_id)
    from mlx_lm import generate
    generate(_model, _tokenizer, prompt="Explain the concept of machine learning in one sentence.", max_tokens=32)


_image_pipe = None
_image_pipe_model = None
_audio_model = None
_audio_processor = None
_audio_model_id = None


def _strip_thinking(text: str) -> tuple[str, bool]:
    if "<|channel>thought" in text:
        end_marker = "<channel|>"
        if end_marker in text:
            idx = text.find(end_marker) + len(end_marker)
            return text[idx:].strip(), False
        return "", True
    if "<think>" in text and "</think>" in text:
        end = text.find("</think>") + len("</think>")
        return text[end:].strip(), False
    if "<think>" in text and "</think>" not in text:
        return "", True
    return text, False


_start_time = time.time()
_request_count = 0
_total_gpu_ms = 0


def _latency_percentiles() -> dict[str, float]:
    if not _latency_buffer:
        return {}
    sorted_buf = sorted(_latency_buffer)
    n = len(sorted_buf)
    return {
        "p50_ms": sorted_buf[int(n * 0.50)],
        "p95_ms": sorted_buf[int(n * 0.95)] if n >= 20 else sorted_buf[-1],
        "p99_ms": sorted_buf[int(n * 0.99)] if n >= 100 else sorted_buf[-1],
    }


async def health(request: Request) -> JSONResponse:
    ready = _model is not None
    resp = {
        "status": "ok" if ready else "loading",
        "version": VERSION,
        "node": platform.node(),
        "model": _model_id or "loading",
        "uptime_s": int(time.time() - _start_time),
        "requests": _request_count,
        "queue_depth": _inference_queue_depth,
    }
    percentiles = _latency_percentiles()
    if percentiles:
        resp["latency"] = percentiles
    return JSONResponse(resp, status_code=200 if ready else 503)


async def models(request: Request) -> JSONResponse:
    all_models = sorted(set(list(MODEL_ALIASES.keys()) + list(IMAGE_MODEL_ALIASES.keys())))
    return JSONResponse({
        "object": "list",
        "data": [{"id": m, "object": "model", "owned_by": "murakumo"} for m in all_models],
    })


async def chat_completions(request: Request) -> JSONResponse:
    global _request_count, _total_gpu_ms, _inference_queue_depth

    _inference_queue_depth += 1
    if _inference_queue_depth > ADMISSION_MAX_QUEUE:
        _inference_queue_depth -= 1
        return JSONResponse(
            {"error": "overloaded", "queue_depth": _inference_queue_depth + 1, "retry_after_ms": 300},
            status_code=503,
        )

    try:
        return await _chat_completions_inner(request)
    finally:
        _inference_queue_depth -= 1


async def _chat_completions_inner(request: Request) -> JSONResponse:
    global _request_count, _total_gpu_ms
    request_start = time.monotonic()

    body = await request.json()
    model_alias = body.get("model", DEFAULT_MODEL)
    model_id = MODEL_ALIASES.get(model_alias.lower(), model_alias)
    messages = body.get("messages", [])
    requested_max_tokens = int(body.get("max_tokens", 8192))

    deadline_header = request.headers.get("x-deadline-ms")
    deadline_s = THINKING_RETRY_DEADLINE_S
    if deadline_header:
        try:
            deadline_s = min(deadline_s, int(deadline_header) / 1000.0)
        except ValueError:
            pass

    sem = _get_inference_semaphore()
    async with sem:
        await ensure_model_async(model_id)

        if hasattr(_tokenizer, "apply_chat_template"):
            prompt = _tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        else:
            prompt = "\n".join(f"{m.get('role','user')}: {m.get('content','')}" for m in messages)

        from mlx_lm import generate

        effective_max_tokens = max(min(requested_max_tokens, 131072), 512)
        retry_count = 0
        gpu_time_ms = 0

        start = time.monotonic()
        raw_output = generate(_model, _tokenizer, prompt=prompt, max_tokens=effective_max_tokens)
        gpu_time_ms += int((time.monotonic() - start) * 1000)

        output, thinking_truncated = _strip_thinking(raw_output)

        elapsed = time.monotonic() - request_start
        if (
            thinking_truncated
            and retry_count < THINKING_RETRY_MAX
            and elapsed < deadline_s
            and effective_max_tokens < THINKING_RETRY_TOKEN_CAP
        ):
            retry_count += 1
            effective_max_tokens = min(effective_max_tokens * THINKING_RETRY_BUDGET_MULT, THINKING_RETRY_TOKEN_CAP)
            start = time.monotonic()
            retried_raw = generate(_model, _tokenizer, prompt=prompt, max_tokens=effective_max_tokens)
            gpu_time_ms += int((time.monotonic() - start) * 1000)
            retried_output, still_truncated = _strip_thinking(retried_raw)
            if retried_output or not still_truncated:
                output = retried_output
                thinking_truncated = still_truncated
                raw_output = retried_raw

        # OpenClaw's embedded runner treats empty assistant payloads as incomplete.
        # If stripping thought blocks removes everything, fall back to raw text.
        if not output or not output.strip():
            fallback = (raw_output or "").strip()
            output = fallback if fallback else "..."
        if output.strip().upper() == "NO_REPLY":
            output = "了解しました。"

    e2e_ms = int((time.monotonic() - request_start) * 1000)
    _request_count += 1
    _total_gpu_ms += gpu_time_ms

    _latency_buffer.append(e2e_ms)
    if len(_latency_buffer) > _LATENCY_BUFFER_SIZE:
        _latency_buffer.pop(0)

    finish_reason = "stop" if not thinking_truncated else "length"

    response_id = f"chatcmpl-{int(time.time() * 1000)}"
    created_ts = int(time.time())

    if body.get("stream", False):
        async def _event_stream():
            first = {
                "id": response_id,
                "object": "chat.completion.chunk",
                "created": created_ts,
                "model": model_alias,
                "choices": [
                    {
                        "index": 0,
                        "delta": {"role": "assistant", "content": output},
                        "finish_reason": None,
                    }
                ],
            }
            last = {
                "id": response_id,
                "object": "chat.completion.chunk",
                "created": created_ts,
                "model": model_alias,
                "choices": [{"index": 0, "delta": {}, "finish_reason": finish_reason}],
            }
            yield f"data: {json.dumps(first, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps(last, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(_event_stream(), media_type="text/event-stream")

    return JSONResponse({
        "id": response_id,
        "object": "chat.completion",
        "created": created_ts,
        "model": model_alias,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": output}, "finish_reason": finish_reason}],
        "usage": {
            "prompt_tokens": len(prompt.split()),
            "completion_tokens": len(output.split()),
            "total_tokens": len(prompt.split()) + len(output.split()),
        },
        "x_gpu_time_ms": gpu_time_ms,
        "x_e2e_ms": e2e_ms,
        "x_retry_count": retry_count,
        "x_requested_max_tokens": requested_max_tokens,
        "x_effective_max_tokens": effective_max_tokens,
        "x_thinking_truncated": thinking_truncated,
        "x_node": platform.node(),
    })


async def image_generations(request: Request) -> JSONResponse:
    global _image_pipe, _image_pipe_model, _request_count
    body = await request.json()
    model_alias = body.get("model", "wai-real")
    model_id = IMAGE_MODEL_ALIASES.get(model_alias.lower(), model_alias)
    prompt = body.get("prompt", "")
    width = int(body.get("size", "1024x1024").split("x")[0])
    height = int(body.get("size", "1024x1024").split("x")[-1])
    steps = int(body.get("num_inference_steps", 20))
    guidance = float(body.get("guidance_scale", 7.5))
    seed = body.get("seed")

    if _image_pipe_model != model_id or _image_pipe is None:
        import torch
        from diffusers import StableDiffusionXLPipeline
        loop = asyncio.get_running_loop()

        def _load_image_pipe() -> None:
            global _image_pipe, _image_pipe_model
            _image_pipe = StableDiffusionXLPipeline.from_pretrained(model_id, torch_dtype=torch.float16, use_safetensors=True)
            _image_pipe.to("mps")
            _image_pipe_model = model_id

        await loop.run_in_executor(_model_executor, _load_image_pipe)

    import torch
    generator = torch.Generator("mps").manual_seed(int(seed)) if seed else None

    start = time.monotonic()
    result = _image_pipe(prompt=prompt, width=width, height=height, num_inference_steps=steps, guidance_scale=guidance, generator=generator)
    gpu_time_ms = int((time.monotonic() - start) * 1000)

    buf = BytesIO()
    result.images[0].save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()

    _request_count += 1
    return JSONResponse({
        "created": int(time.time()),
        "model": model_alias,
        "data": [{"b64_json": b64, "revised_prompt": prompt}],
        "x_gpu_time_ms": gpu_time_ms,
        "x_node": platform.node(),
    })


async def music_generations(request: Request) -> "Response":
    from starlette.responses import Response
    global _audio_model, _audio_processor, _audio_model_id, _request_count
    body = await request.json()
    model_alias = body.get("model", "musicgen-small")
    model_id = AUDIO_MODEL_ALIASES.get(model_alias.lower(), model_alias)
    prompt = body.get("prompt", "") or body.get("style", "")
    duration_sec = int(body.get("duration_sec", body.get("durationSec", 15)))
    duration_sec = max(3, min(duration_sec, 30))
    seed = body.get("seed")
    guidance = float(body.get("guidance_scale", 3.0))

    if not prompt:
        return JSONResponse({"error": "prompt (or style) required"}, status_code=400)

    if _audio_model_id != model_id or _audio_model is None:
        from transformers import AutoProcessor, MusicgenForConditionalGeneration
        loop = asyncio.get_running_loop()

        def _load_audio() -> None:
            global _audio_model, _audio_processor, _audio_model_id
            _audio_processor = AutoProcessor.from_pretrained(model_id)
            _audio_model = MusicgenForConditionalGeneration.from_pretrained(model_id)
            try:
                import torch
                if torch.backends.mps.is_available():
                    _audio_model = _audio_model.to("mps")
            except Exception:
                pass
            _audio_model_id = model_id

        await loop.run_in_executor(_model_executor, _load_audio)

    import torch
    sr = _audio_model.config.audio_encoder.sampling_rate
    max_new_tokens = int(duration_sec * 50)

    def _generate() -> bytes:
        inputs = _audio_processor(text=[prompt], padding=True, return_tensors="pt")
        device = next(_audio_model.parameters()).device
        inputs = {k: v.to(device) for k, v in inputs.items()}
        gen_kwargs = {"max_new_tokens": max_new_tokens, "do_sample": True, "guidance_scale": guidance}
        if seed is not None:
            torch.manual_seed(int(seed))
        with torch.no_grad():
            audio = _audio_model.generate(**inputs, **gen_kwargs)
        wav = audio[0, 0].cpu().numpy()
        import io, struct
        buf = io.BytesIO()
        n_samples = len(wav)
        pcm = (wav * 32767).clip(-32768, 32767).astype("int16").tobytes()
        buf.write(b"RIFF")
        buf.write(struct.pack("<I", 36 + len(pcm)))
        buf.write(b"WAVE")
        buf.write(b"fmt ")
        buf.write(struct.pack("<IHHIIHH", 16, 1, 1, sr, sr * 2, 2, 16))
        buf.write(b"data")
        buf.write(struct.pack("<I", len(pcm)))
        buf.write(pcm)
        return buf.getvalue()

    start = time.monotonic()
    loop = asyncio.get_running_loop()
    wav_bytes = await loop.run_in_executor(_model_executor, _generate)
    inference_ms = int((time.monotonic() - start) * 1000)

    _request_count += 1
    return Response(
        content=wav_bytes,
        media_type="audio/wav",
        headers={
            "x-inference-ms": str(inference_ms),
            "x-node": platform.node(),
            "x-model": model_alias,
            "x-sample-rate": str(sr),
            "x-duration-sec": str(duration_sec),
        },
    )


async def xrpc_cluster_status(request: Request) -> JSONResponse:
    return JSONResponse({
        "totalWorkers": 1, "browserSessions": 0, "pollWorkers": 1, "idleWorkers": 1,
        "pendingTasks": 0, "activeTasks": 0, "activeLeases": 0,
        "node": platform.node(), "model": _model_id,
        "requests": _request_count, "totalGpuMs": _total_gpu_ms,
    })


async def xrpc_list_workers(request: Request) -> JSONResponse:
    return JSONResponse({
        "workers": [{
            "workerId": f"plain-{socket.gethostname()[:12]}",
            "sessionId": f"plain-session-{socket.gethostname()[:12]}",
            "nodeId": socket.gethostname()[:12],
            "hostname": platform.node(), "state": "idle", "gpuTier": "g2",
            "tasksDone": _request_count, "tasksFailed": 0,
            "lastHeartbeat": int(time.time() * 1000), "daemonVersion": VERSION,
        }],
        "total": 1,
    })


app = Starlette(routes=[
    Route("/health", health, methods=["GET"]),
    Route("/api/openai/v1/models", models, methods=["GET"]),
    Route("/v1/models", models, methods=["GET"]),
    Route("/api/openai/v1/chat/completions", chat_completions, methods=["POST"]),
    Route("/v1/chat/completions", chat_completions, methods=["POST"]),
    Route("/api/openai/v1/images/generations", image_generations, methods=["POST"]),
    Route("/v1/images/generations", image_generations, methods=["POST"]),
    Route("/api/audio/v1/music/generations", music_generations, methods=["POST"]),
    Route("/v1/audio/music/generations", music_generations, methods=["POST"]),
    Route("/xrpc/etzhayyim.murakumo.v1.MurakumoQueryService/GetClusterStatus", xrpc_cluster_status, methods=["POST"]),
    Route("/xrpc/etzhayyim.murakumo.v1.MurakumoQueryService/ListWorkers", xrpc_list_workers, methods=["POST"]),
])

if __name__ == "__main__":
    import uvicorn
    print(f"murakumo serve v{VERSION} — warming up {DEFAULT_MODEL}...")
    warmup()
    print(f"model ready: {_model_id} on {platform.node()}")
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="warning")
