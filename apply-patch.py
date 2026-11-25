#!/usr/bin/env python3
"""
Attach the external ASKIIES upgrade modules to any upstream ASKIIES.html:
  - mp-client.js (self-hosted online: accounts, multiplayer rooms, cloud saves) in <head>,
    so window.claude exists before the game script runs;
  - terrain-engine.js & plane-engine.js right before </body>.

Usage:
    python apply-patch.py                  # patches ASKIIES.html in-place
    python apply-patch.py path/to/file.html
"""
import sys
from pathlib import Path

TAGS = [
    '<script src="terrain-engine.js"></script>',
    '<script src="plane-engine.js"></script>',
]


HEAD_TAG = '<script src="mp-client.js"></script>'


def patch_file(path: Path) -> int:
    text = path.read_text(encoding="utf-8")
    if HEAD_TAG not in text:
        h = text.find("<head>")
        if h < 0:
            print(f"Error: <head> not found in {path}", file=sys.stderr)
            return 1
        text = text[:h + 6] + HEAD_TAG + text[h + 6:]
        print(f"Patched {path} <head> with: {HEAD_TAG}")
        path.write_text(text, encoding="utf-8")
    missing = [tag for tag in TAGS if tag not in text]
    if not missing:
        print(f"Already patched: {path}")
        return 0
    idx = text.rfind("</body>")
    if idx < 0:
        print(f"Error: </body> not found in {path}", file=sys.stderr)
        return 1
    patched = text[:idx] + "".join(missing) + text[idx:]
    path.write_text(patched, encoding="utf-8")
    print(f"Patched {path} with: {' '.join(missing)}")
    return 0


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("ASKIIES.html")
    sys.exit(patch_file(target))
