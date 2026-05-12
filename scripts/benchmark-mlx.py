#!/usr/bin/env python3
"""
Benchmark local MLX models against Ollama.
Measures tokens/sec, memory usage, and latency.
Usage: python scripts/benchmark-mlx.py [--model MODEL] [--prompt PROMPT]
"""
import json
import subprocess
import sys
import time
import argparse
from pathlib import Path


def run_benchmark(model: str, prompt: str, provider: str = "ollama", base_url: str = "http://127.0.0.1:11434") -> dict:
    """Run a single benchmark against a provider."""
    messages = [{"role": "user", "content": prompt}]

    if provider == "ollama":
        import urllib.request

        body = json.dumps({"model": model, "messages": messages, "stream": False})
        req = urllib.request.Request(
            f"{base_url}/api/chat",
            data=body.encode(),
            headers={"Content-Type": "application/json"},
        )
        start = time.time()
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.loads(resp.read())
        elapsed = time.time() - start

        content = result.get("message", {}).get("content", "")
        output_tokens = len(content) // 4
        return {
            "provider": "ollama",
            "model": model,
            "duration_ms": elapsed * 1000,
            "output_tokens": output_tokens,
            "tokens_per_second": output_tokens / elapsed if elapsed > 0 else 0,
        }

    elif provider == "mlx":
        import urllib.request

        load_body = json.dumps({"model": model})
        req = urllib.request.Request(
            f"{base_url}/load",
            data=load_body.encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            json.loads(resp.read())

        chat_body = json.dumps({"messages": messages, "stream": False, "max_tokens": 512})
        req = urllib.request.Request(
            f"{base_url}/chat",
            data=chat_body.encode(),
            headers={"Content-Type": "application/json"},
        )
        start = time.time()
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.loads(resp.read())
        elapsed = time.time() - start

        usage = result.get("usage", {})
        return {
            "provider": "mlx",
            "model": model,
            "duration_ms": elapsed * 1000,
            "output_tokens": usage.get("completion_tokens", 0),
            "tokens_per_second": (usage.get("completion_tokens", 0) / elapsed) if elapsed > 0 else 0,
        }

    return {"error": f"Unknown provider: {provider}"}


def main():
    parser = argparse.ArgumentParser(description="Benchmark local MLX and Ollama models")
    parser.add_argument("--model", default="deepseek-coder:1.3b", help="Model to benchmark")
    parser.add_argument("--mlx-model", default="mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit",
                        help="MLX model path for comparison")
    parser.add_argument("--prompt", default="Write a TypeScript function that checks if a number is prime.",
                        help="Prompt to use for benchmarking")
    parser.add_argument("--runs", type=int, default=3, help="Number of runs per provider")
    parser.add_argument("--format", choices=["json", "text"], default="text")
    args = parser.parse_args()

    results = []

    # Benchmark Ollama
    for i in range(args.runs):
        print(f"Ollama run {i+1}/{args.runs}...", end=" ", flush=True)
        try:
            result = run_benchmark(args.model, args.prompt, "ollama")
            result["run"] = i + 1
            results.append(result)
            print(f"{result.get('tokens_per_second', 0):.1f} tok/s")
        except Exception as e:
            print(f"ERROR: {e}")

    # Benchmark MLX
    for i in range(args.runs):
        print(f"MLX run {i+1}/{args.runs}...", end=" ", flush=True)
        try:
            result = run_benchmark(
                args.mlx_model, args.prompt, "mlx", base_url="http://127.0.0.1:8742"
            )
            result["run"] = i + 1
            results.append(result)
            print(f"{result.get('tokens_per_second', 0):.1f} tok/s")
        except Exception as e:
            print(f"ERROR: {e}")

    # Summary
    ollama_runs = [r for r in results if r.get("provider") == "ollama"]
    mlx_runs = [r for r in results if r.get("provider") == "mlx"]

    if args.format == "json":
        print(json.dumps({"results": results, "summary": {
            "ollama_avg_tokens_per_second": sum(r.get("tokens_per_second", 0) for r in ollama_runs) / len(ollama_runs) if ollama_runs else 0,
            "mlx_avg_tokens_per_second": sum(r.get("tokens_per_second", 0) for r in mlx_runs) / len(mlx_runs) if mlx_runs else 0,
        }}, indent=2))
    else:
        if ollama_runs:
            avg = sum(r["tokens_per_second"] for r in ollama_runs) / len(ollama_runs)
            print(f"\nOllama avg: {avg:.1f} tok/s ({len(ollama_runs)} runs)")
        if mlx_runs:
            avg = sum(r["tokens_per_second"] for r in mlx_runs) / len(mlx_runs)
            print(f"MLX avg:    {avg:.1f} tok/s ({len(mlx_runs)} runs)")


if __name__ == "__main__":
    main()
