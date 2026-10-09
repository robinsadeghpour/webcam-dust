#!/usr/bin/env python3
"""Serve the built site the three ways it gets hosted, to check that every
URL in it is relative.

    npm run build
    python tools/serve.py            # then open one of the addresses it prints

    /                 at the root of a domain
    /webcam-dust/     under a project path, as on GitHub Pages
    /lab/dust         under a path with no trailing slash, as behind a rewrite
"""
import argparse
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".js")

PREFIXES = ["/webcam-dust", "/lab/dust"]


def make_handler(root: Path):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            parts = urlsplit(self.path)
            path = parts.path
            for prefix in PREFIXES:
                if path == prefix or path.startswith(prefix + "/"):
                    # GitHub Pages redirects the bare project path to the slash form.
                    if prefix == "/webcam-dust" and path == prefix:
                        self.send_response(301)
                        self.send_header("Location", prefix + "/" + ("?" + parts.query if parts.query else ""))
                        self.end_headers()
                        return
                    path = path[len(prefix):] or "/"
                    break
            if path in ("", "/") or path.endswith("/"):
                target = root / "index.html"
            else:
                target = (root / path.lstrip("/")).resolve()
            inside = root == target.parent or root in target.parents
            if not inside or not target.is_file():
                self.send_error(404)
                return
            body = target.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(target.name)[0] or "application/octet-stream")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args) -> None:  # keep the terminal quiet
            pass

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dir", default=str(Path(__file__).parent.parent / "dist"), help="the built site")
    parser.add_argument("--port", type=int, default=5183)
    args = parser.parse_args()
    root = Path(args.dir).resolve()
    if not (root / "index.html").is_file():
        raise SystemExit(f"no index.html in {root}; run `npm run build` first")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(root))
    for path in ["/", "/webcam-dust/", "/lab/dust"]:
        print(f"http://127.0.0.1:{args.port}{path}")
    server.serve_forever()


main()
