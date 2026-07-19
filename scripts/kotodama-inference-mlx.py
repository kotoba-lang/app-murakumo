#!/usr/bin/env python3
"""kotodama-inference MLX wrapper — drop-in replacement for models unsupported by native binary.

Accepts same CLI interface as kotodama-inference (--model, --prompt, --temperature, --max-tokens)
and outputs SSE format compatible with daemon.rs parse logic.
"""
import argparse
import json
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--temperature", type=float, default=0.7)
    parser.add_argument("--max-tokens", type=int, default=256)
    parser.add_argument("--probe-cpu", action="store_true")
    args = parser.parse_args()

    if args.probe_cpu:
        print("ok")
        return

    print(f"model={args.model} max_tokens={args.max_tokens} temperature={args.temperature}", file=sys.stderr)

    import mlx.core as mx
    from mlx_lm import load
    from mlx_lm.generate import generate_step
    from mlx_lm.sample_utils import make_sampler

    model, tokenizer = load(args.model)

    prompt_tokens = mx.array(tokenizer.encode(args.prompt))
    sampler = make_sampler(args.temperature)

    tokens = []
    for result in generate_step(prompt_tokens, model, max_tokens=args.max_tokens, sampler=sampler):
        if isinstance(result, tuple):
            token = result[0]
        else:
            token = result
        if hasattr(token, 'item'):
            tokens.append(token.item())
        else:
            tokens.append(int(token))
        if len(tokens) >= args.max_tokens:
            break

    response = tokenizer.decode(tokens)

    # Output SSE format expected by daemon.rs
    chunk = {
        "choices": [{"delta": {"content": response}, "index": 0, "finish_reason": "stop"}],
        "model": args.model,
    }
    print(f"data: {json.dumps(chunk)}")
    print("data: [DONE]")


if __name__ == "__main__":
    main()
