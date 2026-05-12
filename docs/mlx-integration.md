# MLX Integration

MetalMind supports local inference on Apple Silicon GPUs via MLX. This document covers setup, model installation, configuration, and benchmarking.

## Prerequisites

- macOS on Apple Silicon (M1/M2/M3/M4)
- Python 3.10+
- pip

## Installation

```bash
# Install MLX and dependencies
pip install mlx-lm fastapi uvicorn

# Verify installation
python -c "import mlx.core; print('MLX ready')"
```

## Sidecar Architecture

MetalMind communicates with MLX through a Python sidecar process. The sidecar exposes an HTTP API that the TypeScript runtime calls via the `MlxProvider` adapter.

```text
TypeScript Agent Runtime
        |
        v
MlxProvider (TypeScript adapter)
        |  HTTP 127.0.0.1:8742
        v
MLX Inference Sidecar (Python + FastAPI)
        |
        v
mlx-lm
        |
        v
Apple Silicon GPU / unified memory
```

## Starting the Sidecar

```bash
# Start with default settings
python scripts/mlx-sidecar.py

# Start with a specific model pre-loaded
python scripts/mlx-sidecar.py --model mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit

# Custom host/port
python scripts/mlx-sidecar.py --host 0.0.0.0 --port 9000
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Sidecar status and loaded model info |
| GET | `/models` | List cached HuggingFace models |
| POST | `/load` | Load a model `{"model": "path"}` |
| POST | `/chat` | Chat completion with optional streaming |
| POST | `/complete` | Text completion |
| POST | `/embed` | Generate embeddings |
| POST | `/unload` | Unload current model |

## Available Models

MetalMind targets these model tiers for MLX:

| Tier | Example Models | Use Case |
|------|---------------|----------|
| Small | `mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit` | Fast local edits, classification |
| Medium | `mlx-community/Qwen2.5-Coder-7B-Instruct-4bit` | Moderate refactors, test fixes |
| Large | `mlx-community/DeepSeek-Coder-33B-Instruct-4bit` | Complex reasoning (if GPU memory allows) |

### Installing Models

Models are downloaded from HuggingFace automatically when first loaded:

```bash
# Via the sidecar API
curl -X POST http://127.0.0.1:8742/load \
  -H "Content-Type: application/json" \
  -d '{"model": "mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit"}'
```

## Configuration (metalmind.yaml)

```yaml
models:
  localMlx:
    provider: mlx
    model: mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit
    baseUrl: http://127.0.0.1:8742

routing:
  defaultLocalModel: localMlx
```

## Benchmarking

Compare MLX vs Ollama performance:

```bash
# Basic benchmark
python scripts/benchmark-mlx.py

# Custom model comparison
python scripts/benchmark-mlx.py \
  --model deepseek-coder:1.3b \
  --mlx-model mlx-community/DeepSeek-Coder-1.3B-Instruct-4bit \
  --runs 5 \
  --format json

# Output example:
# Ollama avg: 45.2 tok/s (3 runs)
# MLX avg:    52.8 tok/s (3 runs)
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `MLX chat failed: 503` | Model not loaded. POST to `/load` first |
| `Failed to load model` | Check model path exists on HuggingFace |
| Slow first inference | Model compiles on first run, subsequent calls are faster |
| Out of memory | Use a smaller quantized model (4-bit or 8-bit) |

## Limitations

- Tool calling is not supported via MLX (local models lack reliable tool-use)
- Streaming works but token-by-token latency depends on model size
- First inference is slower due to model compilation
- Only available on Apple Silicon Macs
