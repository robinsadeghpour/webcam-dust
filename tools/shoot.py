#!/usr/bin/env python3
"""Step the demo figure to chosen moments and save a still of each.

The page is opened with ?demo=1&step=1, where nothing animates on its own:
this script advances the simulation in fixed steps, so the same arguments
always give the same pictures, however slow software rendering is.

    python tools/shoot.py --times 2.4,3.9,6.0,7.8,8.8,13 --tag gold
    python tools/shoot.py --palette 3 --count 200000 --view split
"""
import argparse
import asyncio
import time
from pathlib import Path

from playwright.async_api import async_playwright

def gl_args(angle: str) -> list[str]:
    """Chromium flags for headless WebGL. Metal is fast on a Mac; SwiftShader works anywhere."""
    args = ["--use-gl=angle", f"--use-angle={angle}", "--ignore-gpu-blocklist"]
    if angle == "swiftshader":
        args.append("--enable-unsafe-swiftshader")
    return args + [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    ]


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default="http://127.0.0.1:5182/")
    parser.add_argument("--angle", default="metal", choices=["metal", "swiftshader"], help="graphics backend")
    parser.add_argument("--times", default="2.4,3.9,6.0,7.8,8.8,13", help="demo times in seconds")
    parser.add_argument("--count", type=int, default=410000, help="number of grains")
    parser.add_argument("--palette", type=int, default=1)
    parser.add_argument("--view", default="split", choices=["split", "pip", "solo"])
    parser.add_argument("--aspect", default="", choices=["", "portrait", "landscape", "fill"], help="stage shape; by default the page decides from the window")
    parser.add_argument("--keys", default="", help="keys to press before shooting, e.g. 'h'")
    parser.add_argument("--burst-at", type=float, default=-1, help="press space at this demo time")
    parser.add_argument("--width", type=int, default=1080)
    parser.add_argument("--height", type=int, default=1920)
    parser.add_argument("--extra", default="", help="extra query string, e.g. 'scale=0.5'")
    parser.add_argument("--tag", default="shot")
    parser.add_argument("--out", default=str(Path(__file__).parent / "out"))
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    times = sorted(float(t) for t in args.times.split(",") if t)
    query = f"?demo=1&step=1&count={args.count}&palette={args.palette}&view={args.view}"
    if args.aspect:
        query += f"&aspect={args.aspect}"
    if args.extra:
        query += "&" + args.extra

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(args=gl_args(args.angle))
        page = await browser.new_page(viewport={"width": args.width, "height": args.height})
        problems: list[str] = []

        def on_console(message) -> None:
            # Software GL grumbles about readback stalls; that is not our bug.
            if message.type in ("error", "warning") and "GPU stall due to ReadPixels" not in message.text:
                problems.append(f"{message.type}: {message.text}")

        page.on("console", on_console)
        page.on("pageerror", lambda e: problems.append(f"pageerror: {e}"))
        await page.goto(args.url + query)
        try:
            await page.wait_for_function("window.__dust !== undefined", timeout=90000)
        except Exception:
            print("the page never became ready")
            for line in problems:
                print("console", line[:1500])
            await browser.close()
            raise SystemExit(1)
        for key in args.keys:
            await page.evaluate("k => window.__dust.key(k)", key)

        now = 0.0
        burst_done = args.burst_at < 0
        for moment in times:
            started = time.time()
            if not burst_done and args.burst_at <= moment:
                await page.evaluate("s => window.__dust.advance(s)", max(args.burst_at - now, 1 / 60))
                await page.evaluate("() => window.__dust.key(' ')")
                now = args.burst_at
                burst_done = True
            if moment > now:
                await page.evaluate("s => window.__dust.advance(s)", moment - now)
                now = moment
            # Let the compositor present the frame that was just drawn.
            await page.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
            path = out / f"{args.tag}-{moment:05.2f}.png"
            await page.screenshot(path=str(path), timeout=240000)
            print(f"{path}  ({time.time() - started:.1f}s)")
        for line in problems:
            print("console", line)
        if not problems:
            print("console clean")
        await browser.close()


asyncio.run(main())
