#!/usr/bin/env python3
"""Check that the camera path (MediaPipe segmentation) loads and runs.

With no arguments Chromium's fake camera is used. It shows a test pattern,
not a person, so this only proves the pipeline starts and produces masks.
Pass --clip with a short .webm of a person to see real segmentation:

    python tools/camcheck.py
    python tools/camcheck.py --clip ~/Movies/me.webm --seconds 4
"""
import argparse
import asyncio
from pathlib import Path
from urllib.parse import urlparse

from playwright.async_api import async_playwright

def gl_args(angle: str) -> list[str]:
    """Chromium flags for headless WebGL. Metal is fast on a Mac; SwiftShader works anywhere."""
    args = ["--use-gl=angle", f"--use-angle={angle}", "--ignore-gpu-blocklist"]
    if angle == "swiftshader":
        args.append("--enable-unsafe-swiftshader")
    return args + [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    ]


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default="http://127.0.0.1:5182/")
    parser.add_argument("--angle", default="metal", choices=["metal", "swiftshader"], help="graphics backend")
    parser.add_argument("--clip", default="", help="a .webm file to play instead of the camera")
    parser.add_argument("--seconds", type=float, default=3.0)
    parser.add_argument("--count", type=int, default=200000)
    parser.add_argument("--shots", type=int, default=2)
    parser.add_argument("--tag", default="camera")
    parser.add_argument("--out", default=str(Path(__file__).parent / "out"))
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    query = f"?step=1&count={args.count}"
    if args.clip:
        query += "&video=/__clip.webm"

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(args=gl_args(args.angle))
        page = await browser.new_page(viewport={"width": 1080, "height": 1920})
        log: list[str] = []
        page.on("console", lambda m: log.append(f"{m.type}: {m.text}") if "ReadPixels" not in m.text else None)
        page.on("pageerror", lambda e: log.append(f"pageerror: {e}"))
        if args.clip:
            clip = Path(args.clip).expanduser()
            # Match on the path alone: the page's own address also ends in the clip name.
            await page.route(
                lambda url: urlparse(url).path == "/__clip.webm",
                lambda route: route.fulfill(path=str(clip), content_type="video/webm"),
            )
        await page.goto(args.url + query)
        try:
            await page.wait_for_function("window.__dust !== undefined", timeout=90000)
            await page.wait_for_function("window.__dust.source !== 'none'", timeout=120000)
        except Exception:
            print("the page never became ready")
            for line in log:
                print("console", line[:600])
            await browser.close()
            raise SystemExit(1)
        print("source:", await page.evaluate("window.__dust.source"))

        # Step in small slices of real time so the video keeps delivering frames.
        slices = max(1, int(args.seconds / 0.1))
        every = max(1, slices // args.shots)
        for n in range(1, slices + 1):
            await page.evaluate("() => window.__dust.advance(0.1)")
            await page.wait_for_timeout(60)
            if n % every == 0:
                path = out / f"{args.tag}-{n // every}.png"
                await page.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
                await page.screenshot(path=str(path), timeout=240000)
                print(path)
        for line in log:
            print("console", line[:600])
        if not log:
            print("console clean")
        await browser.close()


asyncio.run(main())
