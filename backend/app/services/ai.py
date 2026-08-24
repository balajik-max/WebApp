"""
Ollama-backed grounded RAG service.

* Uses the official `ollama` Python client, pointed at `OLLAMA_BASE_URL`
  which resolves to the `ai_engine` container in the compose network.
* Targets `OLLAMA_MODEL` (defaults to `qwen2.5:7b-instruct`).
* The system prompt is hard-coded and forbids the model from drawing on
  its own pre-trained knowledge — every answer must cite ONLY the
  serialized database context we pass in.
* All calls are executed in a worker thread (`asyncio.to_thread`) so
  the FastAPI event loop is never blocked on model latency.
* If the context has zero rows, the caller returns a canonical
  "insufficient data" response WITHOUT touching Ollama.  This is a
  structural guarantee against hallucination.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

import httpx
import ollama

from app.core.config import get_settings

log = logging.getLogger("davangere.ai")

INSUFFICIENT_ANSWER = (
    "Sufficient local survey data is not available to answer this question."
)
AI_DISCLAIMER = "*AI recommendation — requires engineer approval*"

SYSTEM_PROMPT_TEMPLATE = (
    "You are an expert civic engineering assistant for Davangere City. "
    "You must answer the user's prompt using ONLY the following verified "
    "database context:\n\n"
    "===== DATABASE CONTEXT =====\n"
    "{context}\n"
    "===== END CONTEXT =====\n\n"
    "If the data is insufficient to formulate an answer, state clearly: "
    "'Sufficient local survey data is not available to answer this question.' "
    "Do not make up any facts, metrics, or trends. Never draw on general "
    "world knowledge. Every claim in your response must map directly to a "
    "row in the context above. Respond in clean GitHub-flavored Markdown "
    "with short section headers and bullet lists where helpful."
)


@dataclass(slots=True)
class LlmReply:
    text: str
    model: str
    prompt_tokens_hint: int


def _client() -> ollama.Client:
    """A fresh Ollama client per call.

    This used to be a process-wide singleton for connection reuse, but a
    single interrupted/cancelled request (a client closing its browser tab
    mid-generation, a request timeout) could leave the shared client's
    underlying connection in a broken state — every subsequent call through
    that same client then hung indefinitely waiting on a dead socket, with no
    way to recover short of restarting the backend process. Each of this
    module's call sites already does exactly one blocking chat/embed call in
    its own worker thread, so there is no real connection-reuse benefit being
    given up — a fresh client is cheap (no handshake happens at construction
    time) and can never inherit another call's broken connection state.
    """
    s = get_settings()
    # 5 min timeout so large context summarization calls never truncate early.
    return ollama.Client(host=s.ollama_base_url, timeout=300)


def _blocking_chat(*, model: str, system: str, user: str, num_ctx: int = 4096, num_predict: int = 1024) -> str:
    """Non-streaming version for backward compatibility."""
    resp = _client().chat(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        options={
            "temperature": 0.1,  # Lower temperature for faster, more focused generation
            "top_p": 0.85,  # Tighter sampling for faster decode
            "num_ctx": num_ctx,
            "num_predict": num_predict,
        },
    )
    # ollama-python returns a dict-like response with a `message.content` key.
    if hasattr(resp, "message"):
        return (resp.message.content or "").strip()
    if isinstance(resp, dict):
        return (resp.get("message", {}).get("content") or "").strip()
    return str(resp)


def _blocking_chat_stream(*, model: str, system: str, user: str, num_ctx: int = 4096, num_predict: int = 1024):
    """Streaming version that yields chunks as they arrive - keeps connection alive."""
    stream = _client().chat(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        options={
            "temperature": 0.1,
            "top_p": 0.85,
            "num_ctx": num_ctx,
            "num_predict": num_predict,
        },
        stream=True,
    )
    for chunk in stream:
        if hasattr(chunk, "message"):
            content = chunk.message.content or ""
        elif isinstance(chunk, dict):
            content = chunk.get("message", {}).get("content") or ""
        else:
            content = str(chunk)
        if content:
            yield content


def _blocking_embed(*, model: str, texts: list[str]) -> list[list[float]]:
    resp = _client().embed(model=model, input=texts)
    embeddings = resp.embeddings if hasattr(resp, "embeddings") else resp.get("embeddings")
    return [list(vec) for vec in embeddings]


async def embed_texts(texts: list[str]) -> list[list[float]]:
    """Embed one or more strings with the local embedding model (nomic-embed-text
    by default). Used ONLY for semantic category-name matching (e.g. resolving
    "solar_light_pole" to the canonical Illumination_Asset class) — never for
    geometric/spatial reasoning, which stays deterministic PostGIS/Python math.
    """
    if not texts:
        return []
    settings = get_settings()

    def _do() -> list[list[float]]:
        return _blocking_embed(model=settings.ollama_embed_model, texts=texts)

    try:
        return await asyncio.to_thread(_do)
    except Exception as exc:  # noqa: BLE001
        log.exception("Ollama embedding call failed")
        raise RuntimeError(f"ollama_embed_error: {exc}") from exc


GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


async def _gemini_chat(*, system: str, user: str, model: str, api_key: str, num_predict: int) -> str:
    """Single-shot Gemini call. Raises on any error/empty/blocked response so
    the caller's except-and-fallback-to-Ollama logic is the only place that
    has to reason about "did the fast path work"."""
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            GEMINI_URL.format(model=model),
            params={"key": api_key},
            json={
                "systemInstruction": {"parts": [{"text": system}]},
                "contents": [{"role": "user", "parts": [{"text": user}]}],
                "generationConfig": {
                    "temperature": 0.1,
                    "topP": 0.85,
                    "maxOutputTokens": num_predict,
                },
            },
        )
        resp.raise_for_status()
        data = resp.json()

    candidates = data.get("candidates") or []
    parts = candidates[0].get("content", {}).get("parts", []) if candidates else []
    text = "".join(p.get("text", "") for p in parts).strip()
    if not text:
        raise RuntimeError(f"gemini_empty_response: {data.get('promptFeedback')}")
    return text


async def run_grounded_completion(
    *,
    context: str,
    user_prompt: str,
    num_predict: int = 1024,
    num_ctx: int | None = None,
) -> LlmReply:
    settings = get_settings()
    system = SYSTEM_PROMPT_TEMPLATE.format(context=context)

    # num_ctx is the model's TOTAL context window (prompt + completion), so
    # a caller requesting a large num_predict (e.g. a multi-section report)
    # must also raise num_ctx or the completion gets starved of room to
    # actually write in. Default to the configured cap; long-form callers
    # pass an explicit, larger value.
    num_ctx = min(num_ctx or settings.ai_max_context_tokens, 8192)
    # Cheap approximation for the token count — good enough for observability.
    approx_tokens = int(len(system) / 4) + int(len(user_prompt) / 4)

    if settings.gemini_api_key:
        try:
            text_out = await _gemini_chat(
                system=system,
                user=user_prompt,
                model=settings.gemini_model,
                api_key=settings.gemini_api_key,
                num_predict=num_predict,
            )
            return LlmReply(text=text_out, model=settings.gemini_model, prompt_tokens_hint=approx_tokens)
        except Exception:  # noqa: BLE001
            log.warning("Gemini call failed, falling back to local Ollama", exc_info=True)

    def _do() -> str:
        return _blocking_chat(
            model=settings.ollama_model, system=system, user=user_prompt, num_ctx=num_ctx, num_predict=num_predict
        )

    try:
        text_out = await asyncio.to_thread(_do)
    except Exception as exc:  # noqa: BLE001
        log.exception("Ollama call failed")
        raise RuntimeError(f"ollama_error: {exc}") from exc

    return LlmReply(
        text=text_out or INSUFFICIENT_ANSWER,
        model=settings.ollama_model,
        prompt_tokens_hint=approx_tokens,
    )
