#!/bin/sh
# ---------------------------------------------------------------------
# Bootstraps the Ollama container by ensuring the configured default
# model is pulled once, then hands off to the standard `ollama serve`.
# Runs entirely offline after the initial pull.
# ---------------------------------------------------------------------
set -e

MODEL="${OLLAMA_MODEL:-llama3:8b}"

echo "[ollama-bootstrap] starting ollama server in background..."
ollama serve &
SERVER_PID=$!

# Wait until API responds.
until curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; do
  echo "[ollama-bootstrap] waiting for ollama api..."
  sleep 2
done

# Pull model if missing.
if ! ollama list 2>/dev/null | awk '{print $1}' | grep -qx "${MODEL}"; then
  echo "[ollama-bootstrap] pulling ${MODEL} (first-run only)..."
  ollama pull "${MODEL}" || echo "[ollama-bootstrap] pull failed; model can be pulled later"
else
  echo "[ollama-bootstrap] ${MODEL} already present"
fi

echo "[ollama-bootstrap] ready. attaching to server pid=${SERVER_PID}"
wait "${SERVER_PID}"
