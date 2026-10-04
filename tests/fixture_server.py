#!/usr/bin/env python3
"""Local HTTP fixture for extension smoke tests.

The server intentionally exposes fake token-like query values. Tests can verify
that the extension detects the requests while keeping those values out of its
diagnostic UI and persistent storage.
"""

from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


INDEX_HTML = b"""<!doctype html>
<html lang="pl">
<head>
  <meta charset="utf-8">
  <link rel="icon" href="data:,">
  <title>MPV Redirector fixture</title>
</head>
<body>
  <h1>MPV Redirector fixture</h1>
  <p id="state">loading</p>
  <button id="refresh-token" type="button">Refresh token</button>
  <script src="/fixture.js"></script>
</body>
</html>
"""

FIXTURE_JS = b"""(() => {
  const state = document.getElementById('state');

  async function requestFixtures(token) {
    const expired = Math.floor(Date.now() / 1000) - 60;
    const paths = [
      `/media/MasterCase.M3U8?token=${token}`,
      `/opaque/live?id=${token}`,
      `/video/direct?id=${token}`,
      `/video/movie-1080p.mp4?token=${token}`,
      `/video/movie-720p.mp4?token=${token}`,
      `/video/movie-2160p.mp4?validto=${expired}&token=${token}`,
      `/segments/seg-001.ts?token=${token}`
    ];
    const results = await Promise.allSettled(paths.map((path) => fetch(path).then((response) => response.arrayBuffer())));
    state.textContent = results.every((result) => result.status === 'fulfilled') ? 'ready' : 'partial';
  }

  document.getElementById('refresh-token').addEventListener('click', () => requestFixtures('second-secret'));
  requestFixtures('first-secret');
})();
"""

MASTER_PLAYLIST = b"""#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720
/media/variant.m3u8
"""

VARIANT_PLAYLIST = b"""#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:2.0,
/segments/seg-001.ts
#EXT-X-ENDLIST
"""


class FixtureHandler(BaseHTTPRequestHandler):
    server_version = "MPVRedirectorFixture/1.0"

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        path = urlsplit(self.path).path
        if path == "/":
            self._send("text/html; charset=utf-8", INDEX_HTML)
        elif path == "/fixture.js":
            self._send("text/javascript; charset=utf-8", FIXTURE_JS)
        elif path == "/media/MasterCase.M3U8":
            self._send("application/vnd.apple.mpegurl", MASTER_PLAYLIST)
        elif path == "/media/variant.m3u8":
            self._send("application/vnd.apple.mpegurl", VARIANT_PLAYLIST)
        elif path == "/opaque/live":
            self._send("application/x-mpegURL", MASTER_PLAYLIST)
        elif path in {
            "/video/direct",
            "/video/movie-1080p.mp4",
            "/video/movie-720p.mp4",
            "/video/movie-2160p.mp4",
        }:
            self._send("video/mp4", b"not-a-real-media-file")
        elif path == "/segments/seg-001.ts":
            self._send("video/mp2t", b"not-a-real-segment")
        else:
            self._send("text/plain; charset=utf-8", b"not found", status=404)

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def _send(self, content_type: str, body: bytes, *, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), FixtureHandler)
    host, port = server.server_address[:2]
    print(json.dumps({"host": host, "port": port}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
