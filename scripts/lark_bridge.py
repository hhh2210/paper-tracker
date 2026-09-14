#!/usr/bin/env python3
"""
PaperTracker Local Lark/Feishu Bridge
Provides a lightweight local HTTP loopback server (127.0.0.1:18288) that bridges
PaperTracker Chrome extension directly to the authenticated local `lark-cli`.
Zero external dependencies, pure Python standard library.
"""

import http.server
import json
import os
import shutil
import socketserver
import subprocess
import sys

PORT = 18288
HOST = "127.0.0.1"

# Locate lark-cli binary
LARK_CLI = shutil.which("lark-cli") or "/opt/homebrew/bin/lark-cli"

class LarkBridgeHandler(http.server.BaseHTTPRequestHandler):
    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, format, *args):
        # Silence default stderr logging, print clean timestamped log
        sys.stdout.write(f"[PaperTracker Bridge] {self.address_string()} - {format % args}\n")
        sys.stdout.flush()

    def _set_cors_headers(self, status=200):
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_GET(self):
        if self.path in ("/ping", "/health"):
            cli_exists = os.path.exists(LARK_CLI)
            self._set_cors_headers(200)
            res = {
                "ok": True,
                "status": "ready" if cli_exists else "cli_not_found",
                "lark_cli_path": LARK_CLI,
                "app_id": "cli_a926b95fa9f8dbd1"
            }
            self.wfile.write(json.dumps(res).encode("utf-8"))
        else:
            self._set_cors_headers(404)
            self.wfile.write(b'{"error": "Not Found"}')

    def do_POST(self):
        if self.path == "/send":
            try:
                content_len = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_len).decode("utf-8")
                payload = json.loads(body) if body else {}

                receiver_id = payload.get("receiverId") or "ou_162e0eaf2ed84e4421c57d0daf9de348"
                card = payload.get("card")
                markdown = payload.get("markdown")

                cmd = [LARK_CLI, "im", "+messages-send", "--as", "bot"]

                if receiver_id.startswith("oc_"):
                    cmd.extend(["--chat-id", receiver_id])
                else:
                    cmd.extend(["--user-id", receiver_id])

                if card:
                    cmd.extend(["--msg-type", "interactive", "--content", json.dumps(card, ensure_ascii=False)])
                elif markdown:
                    cmd.extend(["--markdown", markdown])
                else:
                    self._set_cors_headers(400)
                    self.wfile.write(b'{"ok": false, "error": "Missing card or markdown payload"}')
                    return

                proc = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
                if proc.returncode == 0:
                    self._set_cors_headers(200)
                    try:
                        out_json = json.loads(proc.stdout)
                        self.wfile.write(json.dumps({"ok": True, "mode": "local_cli", "data": out_json}).encode("utf-8"))
                    except Exception:
                        self.wfile.write(json.dumps({"ok": True, "mode": "local_cli", "raw": proc.stdout}).encode("utf-8"))
                else:
                    self._set_cors_headers(500)
                    err_msg = proc.stderr.strip() or proc.stdout.strip() or "lark-cli failed"
                    self.wfile.write(json.dumps({"ok": False, "error": err_msg}).encode("utf-8"))
            except Exception as e:
                self._set_cors_headers(500)
                self.wfile.write(json.dumps({"ok": False, "error": str(e)}).encode("utf-8"))
        else:
            self._set_cors_headers(404)
            self.wfile.write(b'{"error": "Not Found"}')

class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True

def main():
    with ThreadingHTTPServer((HOST, PORT), LarkBridgeHandler) as httpd:
        print(f"[PaperTracker Bridge] Listening on http://{HOST}:{PORT} (lark-cli: {LARK_CLI})")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n[PaperTracker Bridge] Stopped.")

if __name__ == "__main__":
    main()
