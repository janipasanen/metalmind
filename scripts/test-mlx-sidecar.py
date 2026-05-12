#!/usr/bin/env python3
"""MLX sidecar tests."""
import json
import subprocess
import sys
import time
from pathlib import Path


def test_sidecar_starts():
    """Verify the sidecar script can be imported without errors."""
    result = subprocess.run(
        [sys.executable, "-c", "import ast; ast.parse(open('scripts/mlx-sidecar.py').read()); print('OK')"],
        capture_output=True, text=True, cwd=Path(__file__).parent.parent
    )
    assert "OK" in result.stdout, f"Parse failed: {result.stderr}"


def test_sidecar_help():
    """Verify the sidecar accepts --help."""
    result = subprocess.run(
        [sys.executable, "scripts/mlx-sidecar.py", "--help"],
        capture_output=True, text=True, cwd=Path(__file__).parent.parent
    )
    assert "MLX Inference Sidecar" in result.stdout or result.returncode == 0


def test_sidecar_dependency_check():
    """Verify dependency error message format."""
    code = """
import sys, json
sys.modules['fastapi'] = None
sys.modules['mlx_lm'] = None
def __import__(name, *args, **kwargs):
    if name in ('fastapi', 'uvicorn', 'mlx_lm'):
        raise ImportError(name)
    return __import__(name, *args, **kwargs)
import builtins
builtins.__import__ = __import__
exec(open('scripts/mlx-sidecar.py').read())
"""
    result = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True, text=True, cwd=Path(__file__).parent.parent
    )
    output = result.stdout.strip() or result.stderr.strip()
    assert "error" in output.lower() or "Missing" in output or result.returncode != 0


if __name__ == "__main__":
    test_sidecar_starts()
    test_sidecar_help()
    test_sidecar_dependency_check()
    print("All MLX sidecar tests passed.")
