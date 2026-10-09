#!/usr/bin/env python3
"""Tile stills side by side so several moments can be compared at a glance.

    python tools/sheet.py tools/out/sheet.jpg tools/out/gold-*.png
"""
import subprocess
import sys

out, shots = sys.argv[1], sys.argv[2:]
if not shots:
    sys.exit("no stills given")
inputs = [arg for shot in shots for arg in ("-i", shot)]
scaled = "".join(f"[{n}:v]scale=-2:1200[s{n}];" for n in range(len(shots)))
row = "".join(f"[s{n}]" for n in range(len(shots))) + f"hstack=inputs={len(shots)}"
graph = scaled + row if len(shots) > 1 else "[0:v]scale=-2:1200"
subprocess.run(["ffmpeg", "-loglevel", "error", "-y", *inputs, "-filter_complex", graph, "-q:v", "3", out], check=True)
print(out)
