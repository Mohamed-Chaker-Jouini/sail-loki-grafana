"""
run-tests.py
============
Cross-platform test runner.
- Creates a venv in .venv/ if it doesn't exist
- Installs requirements-test.txt
- Runs pytest with any extra args you pass

Usage:
    python run-tests.py
    python run-tests.py -v
    python run-tests.py -k TestHistory -v
"""

import os
import subprocess
import sys
from pathlib import Path

ROOT     = Path(__file__).parent
VENV_DIR = ROOT / ".venv"

# ── Resolve OS-specific paths inside the venv ────────────────────────────────
if sys.platform == "win32":
    PYTHON  = VENV_DIR / "Scripts" / "python.exe"
    PIP     = VENV_DIR / "Scripts" / "pip.exe"
    PYTEST  = VENV_DIR / "Scripts" / "pytest.exe"
else:
    PYTHON  = VENV_DIR / "bin" / "python"
    PIP     = VENV_DIR / "bin" / "pip"
    PYTEST  = VENV_DIR / "bin" / "pytest"


def run(cmd: list, **kwargs) -> None:
    """Run a command, stream output live, abort on failure."""
    print(f"\n► {' '.join(str(c) for c in cmd)}\n{'─'*60}")
    result = subprocess.run(cmd, **kwargs)
    if result.returncode != 0:
        sys.exit(result.returncode)


def main() -> None:
    # 1. Create venv if missing
    if not PYTHON.exists():
        print("Creating virtual environment in .venv/ ...")
        run([sys.executable, "-m", "venv", str(VENV_DIR)])

    # 2. Upgrade pip silently
    run([str(PYTHON), "-m", "pip", "install", "--quiet", "--upgrade", "pip"])

    # 3. Install test dependencies
    req = ROOT / "requirements-test.txt"
    if req.exists():
        run([str(PIP), "install", "--quiet", "-r", str(req)])
    else:
        print(f"[WARN] {req} not found — skipping dependency install")

    # 4. Run pytest, forwarding any CLI args (e.g. -v, -k TestFoo)
    extra = sys.argv[1:]
    run([str(PYTEST), *extra])


if __name__ == "__main__":
    main()