import http.server
from functools import partial
from pathlib import Path
from urllib.parse import unquote, urlsplit

PORT = 8746
APP_ROOT = Path(__file__).resolve().parent
PUBLIC_FILES = {
    "/", "/index.html", "/login.html", "/style.css", "/app.js",
    "/lib/supabase.js", "/lib/html2canvas.min.js",
}

class NoCacheHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        path = unquote(urlsplit(self.path).path)
        if path not in PUBLIC_FILES:
            self.send_error(404)
            return None
        return super().send_head()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

if __name__ == "__main__":
    handler = partial(NoCacheHTTPRequestHandler, directory=str(APP_ROOT))
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler) as httpd:
        print(f"Open http://localhost:{PORT}/login.html")
        httpd.serve_forever()
