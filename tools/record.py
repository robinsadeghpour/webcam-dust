#!/usr/bin/env python3
"""Press R in the running page, record for a few seconds, press R again,
and check the clip the page hands back.

    python tools/record.py --seconds 4

Prints the container, codec, frame size and duration reported by ffprobe.
The clip is MP4 where the browser can encode H.264 and WebM otherwise.
"""
import argparse
import asyncio
import json
import subprocess
from pathlib import Path

from playwright.async_api import async_playwright

def gl_args(angle: str) -> list[str]:
    """Chromium flags for headless WebGL. Metal is fast on a Mac; SwiftShader works anywhere."""
    args = ["--use-gl=angle", f"--use-angle={angle}", "--ignore-gpu-blocklist"]
    if angle == "swiftshader":
        args.append("--enable-unsafe-swiftshader")
    return args


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default="http://127.0.0.1:5182/")
    parser.add_argument("--angle", default="metal", choices=["metal", "swiftshader"], help="graphics backend")
    parser.add_argument("--seconds", type=float, default=4.0)
    parser.add_argument("--count", type=int, default=410000, help="number of grains")
    parser.add_argument("--width", type=int, default=540, help="window width")
    parser.add_argument("--height", type=int, default=960, help="window height")
    parser.add_argument("--extra", default="", help="extra query string, e.g. 'aspect=landscape&reel=1'")
    parser.add_argument("--out", default=str(Path(__file__).parent / "out"))
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    query = f"?demo=1&count={args.count}" + (f"&{args.extra}" if args.extra else "")

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(args=gl_args(args.angle))
        page = await browser.new_page(viewport={"width": args.width, "height": args.height}, accept_downloads=True)
        problems: list[str] = []

        def on_console(message) -> None:
            # Software GL grumbles about readback stalls; that is not our bug.
            if message.type in ("error", "warning") and "GPU stall due to ReadPixels" not in message.text:
                problems.append(f"{message.type}: {message.text[:300]}")

        page.on("console", on_console)
        page.on("pageerror", lambda e: problems.append(f"pageerror: {e}"))
        await page.goto(args.url + query)
        await page.wait_for_timeout(4000)
        await page.keyboard.press("r")
        await page.wait_for_timeout(int(args.seconds * 1000))
        light = await page.evaluate("document.querySelector('#rec').hidden === false")
        async with page.expect_download(timeout=120000) as pending:
            await page.keyboard.press("r")
        download = await pending.value
        path = out / download.suggested_filename
        await download.save_as(str(path))
        await browser.close()

    print(f"{path}  ({path.stat().st_size / 1e6:.2f} MB)  recording light shown: {light}")
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
         "-show_entries", "stream=codec_name,width,height,nb_read_frames:format=format_name",
         "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    )
    info = json.loads(probe.stdout)
    stream = info["streams"][0]
    print(f"container {info['format']['format_name']}, codec {stream['codec_name']}, "
          f"{stream['width']}x{stream['height']}, {stream.get('nb_read_frames', '?')} frames")
    for line in problems:
        print("console", line)
    if not problems:
        print("console clean")


asyncio.run(main())
