#!/usr/bin/env python3
"""
Embedding HTTP Service — bge-base-zh-v1.5
独立进程，不走vLLM。供 infinite-date-v2 记忆检索使用。

POST /embed
  Body: {"texts": ["text1", "text2", ...]}
  Resp: {"embeddings": [[0.01, -0.02, ...], ...], "dim": 768}

GET /health
  Resp: {"status": "ok", "model": "bge-base-zh-v1.5", "dim": 768}
"""
import json
import os
import sys
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

import numpy as np
from sentence_transformers import SentenceTransformer

MODEL_PATH = "/output/huggingface/hub/models--BAAI--bge-base-zh-v1.5/snapshots/f03589ceff5aac7111bd60cfc7d497ca17ecac65"
PORT = int(os.environ.get("EMBEDDING_PORT", "8001"))

print(f"[embedding] Loading bge-base-zh-v1.5 from {MODEL_PATH} ...", flush=True)
t0 = time.time()
model = SentenceTransformer(MODEL_PATH, device="cuda")
DIM = model.get_sentence_embedding_dimension()
print(f"[embedding] Model loaded in {time.time()-t0:.1f}s, dim={DIM}", flush=True)


class EmbeddingHandler(BaseHTTPRequestHandler):
    def _json(self, code: int, data: dict):
        body = json.dumps(data).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"status": "ok", "model": "bge-base-zh-v1.5", "dim": DIM})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/embed":
            self._json(404, {"error": "not found"})
            return

        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length)
            payload = json.loads(raw)
        except Exception as e:
            self._json(400, {"error": f"bad request: {e}"})
            return

        texts = payload.get("texts", [])
        if not texts:
            self._json(200, {"embeddings": [], "dim": DIM})
            return

        try:
            # bge recommends "query: " prefix for queries, but for symmetric search
            # (matching memories to conversation context) we use raw text for both
            vecs = model.encode(
                texts,
                batch_size=32,
                normalize_embeddings=True,  # normalized → dot product = cosine sim
                show_progress_bar=False,
            )
            embeddings = vecs.astype(np.float32).tolist()
            self._json(200, {"embeddings": embeddings, "dim": DIM})
        except Exception as e:
            self._json(500, {"error": f"encoding failed: {e}"})

    def log_message(self, fmt, *args):
        # suppress default access logs, keep stderr clean
        pass


if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", PORT), EmbeddingHandler)
    print(f"[embedding] Listening on http://127.0.0.1:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[embedding] Shutting down.", flush=True)
        server.shutdown()
