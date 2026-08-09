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

# Weight loading takes tens of seconds for a 9B model, and it can fail (wrong
# path, an architecture this mlx-lm is too old to know). Both states have to be
# reportable over HTTP: the client needs to tell "warming up" from "broken" from
# "absent", and previously it could tell none of them apart -- see main().
loading_model = None
load_error = None


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    stream: bool = False
    max_tokens: int = 2048
    temperature: float = 0.7
    top_p: float = 0.9
    # OpenAI-shaped tool definitions. Passed to the tokenizer's chat template,
    # which is what teaches the model the tool-call syntax it should emit; the
    # client parses the calls back out of the generated text.
    tools: list[dict] | None = None


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
    global loaded_model, loaded_tokenizer, model_name, loading_model, load_error
    loading_model = model_path
    load_error = None
    try:
        from mlx_lm import load

        try:
            loaded_model, loaded_tokenizer = load(
                model_path, trust_remote_code=trust_remote_code
            )
        except TypeError as e:
            # mlx-lm >= 0.30 dropped the trust_remote_code kwarg from load();
            # remote code is now opted into through tokenizer_config. Retry the
            # new way rather than failing on a purely cosmetic signature change.
            if "trust_remote_code" not in str(e):
                raise
            kwargs = (
                {"tokenizer_config": {"trust_remote_code": True}}
                if trust_remote_code
                else {}
            )
            loaded_model, loaded_tokenizer = load(model_path, **kwargs)
        model_name = model_path
        return {"status": "loaded", "model": model_path}
    except Exception as e:
        load_error = str(e)
        raise HTTPException(status_code=500, detail=f"Failed to load model: {str(e)}")
    finally:
        loading_model = None


def reasoning_is_open(prompt: str) -> bool:
    """True when the rendered prompt leaves a <think> block unclosed.

    Qwen3-family templates (Ornith among them) append a bare "<think>" after the
    generation marker, so the model's first tokens are chain-of-thought with no
    opening tag of their own. Only the side that rendered the prompt can know
    this; without it the client would have to guess, and guessing wrong either
    leaks reasoning into the answer or swallows an answer as reasoning.
    """
    opened = prompt.rfind("<think>")
    if opened == -1:
        return False
    return prompt.rfind("</think>") < opened


def iter_text(prompt, max_tokens: int, temperature: float):
    """Yield generated text chunks for a prompt.

    Wraps mlx-lm's stream_generate, which is the stable public API: it takes a
    string prompt and yields GenerationResponse objects carrying decoded .text.
    The previous code reached for the internal generate_step instead and got
    three things wrong that no version of mlx-lm accepted -- it passed the
    tokenizer into a keyword-only slot positionally, passed a `temp` argument
    that is now expressed as a sampler, and concatenated the yielded values as
    if they were strings when they are token-id arrays.
    """
    from mlx_lm import stream_generate
    from mlx_lm.sample_utils import make_sampler

    sampler = make_sampler(temp=temperature)
    for chunk in stream_generate(
        loaded_model,
        loaded_tokenizer,
        prompt,
        max_tokens=max_tokens,
        sampler=sampler,
    ):
        if chunk.text:
            yield chunk.text


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model_loaded": loaded_model is not None,
        "model": model_name,
        "platform": sys.platform,
        # "loading" lets a client wait instead of routing around a tier that is
        # seconds from being ready; "error" lets it say WHY tier 1 is dead
        # instead of silently falling through to the cloud.
        "loading": loading_model,
        "load_error": load_error,
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
        # A model whose chat template understands `tools` renders them into the
        # prompt itself. Templates that don't accept the kwarg raise TypeError —
        # fall back to a plain prompt so an older model still answers instead of
        # failing the whole request.
        template_kwargs = {"tokenize": False, "add_generation_prompt": True}
        tools_applied = False
        if req.tools:
            try:
                prompt = loaded_tokenizer.apply_chat_template(
                    messages, tools=req.tools, **template_kwargs
                )
                tools_applied = True
            except (TypeError, ValueError):
                prompt = loaded_tokenizer.apply_chat_template(messages, **template_kwargs)
        else:
            prompt = loaded_tokenizer.apply_chat_template(messages, **template_kwargs)

        reasoning_open = reasoning_is_open(prompt if isinstance(prompt, str) else "")

        if req.stream:
            from fastapi.responses import StreamingResponse

            async def stream_gen():
                response = ""
                # Preamble: tells the client how to classify the first tokens.
                yield json.dumps({"reasoning_open": reasoning_open}) + "\n"
                for text in iter_text(prompt, req.max_tokens, req.temperature):
                    response += text
                    yield json.dumps({"message": {"content": text}}) + "\n"
                yield json.dumps({
                    "message": {"content": ""},
                    "done": True,
                    "usage": {"duration_ms": (time.time() - start) * 1000},
                }) + "\n"

            return StreamingResponse(stream_gen(), media_type="application/x-ndjson")

        response = "".join(iter_text(prompt, req.max_tokens, req.temperature))

        duration_ms = (time.time() - start) * 1000
        return {
            "message": {"role": "assistant", "content": response},
            # Tells the client whether the chat template actually rendered the
            # tool definitions. Without it the client cannot distinguish "the
            # model chose not to call a tool" from "this model never saw them".
            "tools_applied": tools_applied,
            "reasoning_open": reasoning_open,
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
        response = "".join(iter_text(req.prompt, req.max_tokens, req.temperature))

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
        # Load on a background thread so the HTTP server binds immediately.
        # Loading inline meant nothing answered on the port for the whole load
        # (a minute or more for a 9B), so a client probing /health saw a closed
        # port and concluded the sidecar was absent -- and if the load raised,
        # the exception propagated out of main() and killed the process before
        # uvicorn ever started, turning a bad --model into a silently missing
        # tier 1 with no way to ask what went wrong.
        print(f"Loading model: {args.model}")

        def _load():
            try:
                load_model(args.model)
                print(f"Model loaded: {args.model}")
            except Exception as e:  # already recorded in load_error for /health
                print(f"Model load failed: {e}", file=sys.stderr)

        threading.Thread(target=_load, daemon=True).start()

    print(f"MLX sidecar starting on {args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
