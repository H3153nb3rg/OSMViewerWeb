#!/usr/bin/env python3
"""Static file server for OSMViewer Web (alternative to serve.mjs).
Sets the JavaScript MIME type explicitly: on Windows the registry often maps
.js to text/plain, which makes browsers refuse ES modules."""
import http.server, os, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8137
os.chdir(os.path.dirname(os.path.abspath(__file__)))

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
                      '.gpx': 'application/gpx+xml', '.kml': 'application/vnd.google-earth.kml+xml'}
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()
    def log_message(self, *args):
        pass

print(f'OSMViewer Web: http://localhost:{PORT}/  (Strg+C beendet)')
http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
