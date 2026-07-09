#!/bin/sh
# ---------------------------------------------------------------------
# Bootstraps the Ollama container by ensuring the configured default
# model is pulled once, then hands off to the standard `ollama serve`.
# Runs entirely offline after the initial pull.
# ---------------------------------------------------------------------
set -e

MODEL="${OLLAMA_MODEL:-qwen2.5:7b-instruct}"

echo "[ollama-bootstrap] starting ollama server in background..."
ollama serve &
SERVER_PID=$!

# Wait until API responds. NOTE: the ollama/ollama base image does not ship
# `curl` at all, so a curl-based readiness probe here (or in a Docker
# HEALTHCHECK) silently fails 100% of the time with \"command not found\" -
# the until-loop retries forever regardless of whether the server is
# actually up. Use the `ollama` CLI itself instead: it always exists in
# this image and talks to the same local API.
ATTEMPT=0
until ollama list >/dev/null 2>&1; do
  ATTEMPT=$((ATTEMPT + 1))
  echo "[ollama-bootstrap] waiting for ollama api... (attempt ${ATTEMPT})"
  if [ "${ATTEMPT}" -eq 15 ]; then
    echo "[ollama-bootstrap] still not up after 30s - is the server process still running?"
    kill -0 "${SERVER_PID}" 2>/dev/null && echo "[ollama-bootstrap] server pid ${SERVER_PID} is alive, keep waiting" \
      || echo "[ollama-bootstrap] server pid ${SERVER_PID} is DEAD"
  fi
  sleep 2
done
echo "[ollama-bootstrap] api is up."

# Pull model if missing.
if ! ollama list 2>/dev/null | awk '{print $1}' | grep -qx "${MODEL}"; then
  echo "[ollama-bootstrap] pulling ${MODEL} (first-run only)..."
  ollama pull "${MODEL}" || echo "[ollama-bootstrap] pull failed; model can be pulled later"
else
  echo "[ollama-bootstrap] ${MODEL} already present"
fi

echo "[ollama-bootstrap] ready. attaching to server pid=${SERVER_PID}"
wait "${SERVER_PID}"
