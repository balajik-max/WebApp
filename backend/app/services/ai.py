"""
Ollama-backed grounded RAG service.

* Uses the official `ollama` Python client, pointed at `OLLAMA_BASE_URL`
  which resolves to the `ai_engine` container in the compose network.
* Targets `OLLAMA_MODEL` (defaults to `llama3:8b`).
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
    s = get_settings()
    # `ollama.Client` accepts a `host=` arg which becomes the base URL.
    return ollama.Client(host=s.ollama_base_url, timeout=120)


def _blocking_chat(*, model: str, system: str, user: str) -> str:
    resp = _client().chat(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        options={
            "temperature": 0.2,
            "top_p": 0.9,
            "num_ctx": 4096,
        },
    )
    # ollama-python returns a dict-like response with a `message.content` key.
    if hasattr(resp, "message"):
        return (resp.message.content or "").strip()
    if isinstance(resp, dict):
        return (resp.get("message", {}).get("content") or "").strip()
    return str(resp)


async def run_grounded_completion(
    *,
    context: str,
    user_prompt: str,
) -> LlmReply:
    settings = get_settings()
    system = SYSTEM_PROMPT_TEMPLATE.format(context=context)

    def _do() -> str:
        return _blocking_chat(model=settings.ollama_model, system=system, user=user_prompt)

    try:
        text_out = await asyncio.to_thread(_do)
    except Exception as exc:  # noqa: BLE001
        log.exception("Ollama call failed")
        raise RuntimeError(f"ollama_error: {exc}") from exc

    # Cheap approximation for the token count — good enough for observability.
    approx_tokens = int(len(system) / 4) + int(len(user_prompt) / 4)
    return LlmReply(
        text=text_out or INSUFFICIENT_ANSWER,
        model=settings.ollama_model,
        prompt_tokens_hint=approx_tokens,
    )
