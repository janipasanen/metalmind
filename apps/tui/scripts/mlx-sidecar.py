#!/usr/bin/env python3
"""
MLX Inference Sidecar for Metalmind.
Exposes Apple Silicon-accelerated local LLM inference via HTTP.
Requires: pip install mlx-lm fastapi uvicorn
"""

import json
import sys
import time
import os
import argparse
import threading
from typing import Optional, AsyncGenerator

try:
    from fastapi import FastAPI, HTTPException
    from pydantic import BaseModel
    import uvicorn
except ImportError:
    print(
        json.dumps({
            "error": "Missing dependencies. Install with: pip install mlx-lm fastapi uvicorn"
        })
    )
    sys.exit(1)

app = FastAPI(title="Metalmind MLX Sidecar")

loaded_model = None
loaded_tokenizer = None
model_name = None


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    stream: bool = False
    max_tokens: int = 2048
    temperature: float = 0.7
    top_p: float = 0.9


class CompleteRequest(BaseModel):
    prompt: str
    max_tokens: int = 256
    temperature: float = 0.7


class EmbedRequest(BaseModel):
    texts: list[str]


class LoadModelRequest(BaseModel):
    model: str
    trust_remote_code: bool = False


def load_model(model_path: str, trust_remote_code: bool = False):
    global loaded_model, loaded_tokenizer, model_name
    try:
        from mlx_lm import load

        loaded_model, loaded_tokenizer = load(model_path)
        model_name = model_path
        return {"status": "loaded", "model": model_path}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load model: {str(e)}")


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model_loaded": loaded_model is not None,
        "model": model_name,
        "platform": sys.platform,
    }


@app.get("/models")
async def list_models():
    """List locally cached MLX models."""
    cache_dir = os.path.expanduser("~/.cache/huggingface/hub")
    models = []
    if os.path.isdir(cache_dir):
        for entry in os.listdir(cache_dir):
            full = os.path.join(cache_dir, entry)
            if os.path.isdir(full) and entry.startswith("models--"):
                name = entry.replace("models--", "").replace("--", "/")
                models.append({"name": name})
    return {"models": models}


@app.post("/load")
async def load_model_endpoint(req: LoadModelRequest):
    return load_model(req.model, req.trust_remote_code)


@app.post("/chat")
async def chat(req: ChatRequest):
    if loaded_model is None:
        raise HTTPException(status_code=503, detail="No model loaded. POST /load first.")

    messages = [{"role": m.role, "content": m.content} for m in req.messages]

    start = time.time()
    try:
        from mlx_lm.utils import generate_step
        import mlx.core as mx

        prompt = loaded_tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )

        if req.stream:
            from fastapi.responses import StreamingResponse

            async def stream_gen():
                response = ""
                for token, _ in zip(
                    generate_step(
                        prompt,
                        loaded_model,
                        loaded_tokenizer,
                        max_tokens=req.max_tokens,
                        temp=req.temperature,
                    ),
                    range(req.max_tokens),
                ):
                    response += token
                    yield json.dumps({"message": {"content": token}}) + "\n"
                yield json.dumps({
                    "message": {"content": ""},
                    "done": True,
                    "usage": {"duration_ms": (time.time() - start) * 1000},
                }) + "\n"

            return StreamingResponse(stream_gen(), media_type="application/x-ndjson")

        response = ""
        for token, _ in zip(
            generate_step(
                prompt,
                loaded_model,
                loaded_tokenizer,
                max_tokens=req.max_tokens,
                temp=req.temperature,
            ),
            range(req.max_tokens),
        ):
            response += token

        duration_ms = (time.time() - start) * 1000
        return {
            "message": {"role": "assistant", "content": response},
            "usage": {
                "prompt_tokens": len(prompt) // 4,
                "completion_tokens": len(response) // 4,
                "duration_ms": duration_ms,
            },
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/complete")
async def complete(req: CompleteRequest):
    if loaded_model is None:
        raise HTTPException(status_code=503, detail="No model loaded. POST /load first.")

    start = time.time()
    try:
        from mlx_lm.utils import generate_step

        response = ""
        for token, _ in zip(
            generate_step(
                req.prompt,
                loaded_model,
                loaded_tokenizer,
                max_tokens=req.max_tokens,
                temp=req.temperature,
            ),
            range(req.max_tokens),
        ):
            response += token

        duration_ms = (time.time() - start) * 1000
        return {
            "text": response,
            "usage": {
                "prompt_tokens": len(req.prompt) // 4,
                "completion_tokens": len(response) // 4,
                "duration_ms": duration_ms,
            },
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/embed")
async def embed(req: EmbedRequest):
    if loaded_model is None:
        raise HTTPException(status_code=503, detail="No model loaded.")

    try:
        import mlx.core as mx

        embeddings = []
        for text in req.texts:
            tokens = loaded_tokenizer.encode(text)
            input_ids = mx.array([tokens])
            output = loaded_model(input_ids)
            if hasattr(output, "last_hidden_state"):
                vec = output.last_hidden_state.mean(axis=1).squeeze()
            else:
                vec = output[0].mean(axis=1).squeeze() if isinstance(output, tuple) else output
            if hasattr(vec, "tolist"):
                vec = vec.tolist()
            embeddings.append(vec)

        return {"embeddings": embeddings}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/unload")
async def unload():
    global loaded_model, loaded_tokenizer, model_name
    loaded_model = None
    loaded_tokenizer = None
    model_name = None
    return {"status": "unloaded"}


def main():
    parser = argparse.ArgumentParser(description="Metalmind MLX Inference Sidecar")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind to")
    parser.add_argument("--port", type=int, default=8742, help="Port to bind to")
    parser.add_argument("--model", default=None, help="Model to load on startup")
    args = parser.parse_args()

    if args.model:
        # Load model in background so the HTTP server starts immediately.
        # Chat requests return 503 while loading; the agent escalates to cloud in that window.
        def _load():
            print(f"[MLX] Loading {args.model} in background…")
            load_model(args.model)
            print(f"[MLX] Model ready")
        threading.Thread(target=_load, daemon=True).start()

    print(f"[MLX] Sidecar listening on {args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
