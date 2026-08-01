"""Prometheus exporter that probes Ollama AI engines and exposes metrics."""
import time, threading, urllib.request, json, sys
from http.server import HTTPServer, BaseHTTPRequestHandler

ENGINES = [
    {"name": "ai-pc2", "url": "http://192.168.10.81:11434"},
    {"name": "ai-pc3", "url": "http://192.168.10.67:11434"},
    {"name": "ai-pc4", "url": "http://192.168.10.42:11434"},
    {"name": "ai-local", "url": "http://host.docker.internal:11434"},
]

RESULTS = {}
LOCK = threading.Lock()

def probe_engine(engine):
    name, url = engine["name"], engine["url"]
    start = time.time()
    try:
        req = urllib.request.Request(f"{url}/api/tags")
        resp = urllib.request.urlopen(req, timeout=10)
        data = json.loads(resp.read())
        latency = time.time() - start
        models = [m["name"] for m in data.get("models", [])]
        with LOCK:
            RESULTS[name] = {
                "up": 1,
                "latency": latency,
                "models": models,
                "model_count": len(models),
                "error": "",
            }
    except Exception as e:
        latency = time.time() - start
        with LOCK:
            RESULTS[name] = {
                "up": 0,
                "latency": latency,
                "models": [],
                "model_count": 0,
                "error": str(e)[:100],
            }

def probe_loop():
    while True:
        threads = []
        for engine in ENGINES:
            t = threading.Thread(target=probe_engine, args=(engine,), daemon=True)
            t.start()
            threads.append(t)
        for t in threads:
            t.join(timeout=15)
        time.sleep(15)

class MetricsHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/metrics":
            self.send_response(404)
            self.end_headers()
            return
        lines = []
        lines.append("# HELP ollama_engine_up Whether the Ollama engine is reachable (1=up, 0=down).")
        lines.append("# TYPE ollama_engine_up gauge")
        lines.append("# HELP ollama_engine_latency_seconds Response time of /api/tags probe.")
        lines.append("# TYPE ollama_engine_latency_seconds gauge")
        lines.append("# HELP ollama_engine_model_count Number of models on the engine.")
        lines.append("# TYPE ollama_engine_model_count gauge")
        lines.append("# HELP ollama_total_requests_total Total requests routed through AI load balancer.")
        lines.append("# TYPE ollama_total_requests_total counter")
        with LOCK:
            for name in [e["name"] for e in ENGINES]:
                r = RESULTS.get(name, {"up": 0, "latency": 0, "model_count": 0, "error": "not yet probed"})
                lines.append(f'ollama_engine_up{{engine="{name}"}} {r["up"]}')
                lines.append(f'ollama_engine_latency_seconds{{engine="{name}"}} {r["latency"]:.4f}')
                lines.append(f'ollama_engine_model_count{{engine="{name}"}} {r["model_count"]}')
        body = "\n".join(lines) + "\n"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4")
        self.end_headers()
        self.wfile.write(body.encode())

    def log_message(self, format, *args):
        pass

if __name__ == "__main__":
    t = threading.Thread(target=probe_loop, daemon=True)
    t.start()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9320
    print(f"Ollama exporter listening on :{port}/metrics")
    HTTPServer(("", port), MetricsHandler).serve_forever()
