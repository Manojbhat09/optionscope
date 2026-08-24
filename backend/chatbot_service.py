# backend/chatbot_service.py
import base64
import io
import json
import os
import re
import time
import warnings
from datetime import datetime

import anthropic
import requests
from dotenv import load_dotenv
from flask import Blueprint, Response, jsonify, request
from openai import OpenAI
from PIL import Image

load_dotenv()

chatbot_bp = Blueprint('chatbot', __name__)

ANTHROPIC_API_KEY = os.getenv('ANTHROPIC_API_KEY')
OPENAI_API_KEY = os.getenv('OPENAI_API_KEY')
OPENROUTER_API_KEY = os.getenv('REACT_APP_OPENROUTER_API_KEY')
INFERX_API_KEY = os.getenv('INFERX_API_KEY')
INFERX_BASE_URL = os.getenv('INFERX_BASE_URL', 'https://model.inferx.net/endpoints/v1')
ZAI_API_KEY = os.getenv('ZAI_API_KEY')
# Z.ai's coding-plan (flat-subscription) endpoint — NOT their pay-per-token
# /api/paas/v4 endpoint, and no /v1 suffix (a common integration mistake per
# Z.ai's own docs — this base URL already is the versioned root).
ZAI_BASE_URL = os.getenv('ZAI_BASE_URL', 'https://api.z.ai/api/coding/paas/v4')
COMMANDCODE_API_KEY = os.getenv('COMMANDCODE_API_KEY')
# CommandCode Provider API (https://commandcode.ai/docs/provider) — OpenAI-
# compatible /provider/v1 surface. NOTE: per their docs the Go plan is the only
# plan WITHOUT API access (403 upgrade_required); GOAT/Pro/Max/Team/Provider all
# work against these endpoints.
COMMANDCODE_BASE_URL = os.getenv('COMMANDCODE_BASE_URL', 'https://api.commandcode.ai/provider/v1')

if not any([ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, INFERX_API_KEY, ZAI_API_KEY, COMMANDCODE_API_KEY]):
    warnings.warn("No LLM API keys set — chatbot will error. "
                  "Set ANTHROPIC_API_KEY, OPENAI_API_KEY, REACT_APP_OPENROUTER_API_KEY, INFERX_API_KEY, "
                  "ZAI_API_KEY, or COMMANDCODE_API_KEY in backend/.env or enter keys directly in the chat settings panel.")

SITE_URL = "http://localhost:3000"
APP_NAME = "Trading Dashboard Assistant"

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), 'screenshots')
os.makedirs(SCREENSHOT_DIR, exist_ok=True)

# User-configurable per-request timeout (frontend settings panel). Bounded so
# a typo or an abusive value can't hold a backend worker thread open forever.
DEFAULT_TIMEOUT_SEC = 60
MAX_TIMEOUT_SEC = 600


def _clamp_timeout(timeout):
    try:
        t = float(timeout) if timeout is not None else DEFAULT_TIMEOUT_SEC
    except (TypeError, ValueError):
        t = DEFAULT_TIMEOUT_SEC
    return max(5, min(t, MAX_TIMEOUT_SEC))

SYSTEM_PROMPT = (
    "You are a trading assistant analyzing an options trading dashboard. "
    "Answer questions about the trading data, P&L, positions, and charts shown. "
    "Be concise and data-driven. When a 'Dashboard context' JSON block is provided, "
    "treat its numbers as ground truth (they are the app's own computed values) — use "
    "the screenshot for visual layout and anything the JSON doesn't cover, but never "
    "guess a figure from the image when the same figure is already in the JSON."
)


def _build_query_with_context(query: str, context: dict | None) -> str:
    """Prefix the user's question with a structured JSON snapshot of what's
    currently on screen (P&L totals, visible trades, active filters). A
    screenshot alone forces the model to visually estimate numbers from a
    (possibly downscaled — see _shrink_image_b64) chart image; this gives it
    the exact values the dashboard itself already computed."""
    if not context:
        return query
    try:
        context_json = json.dumps(context, indent=2)
    except (TypeError, ValueError):
        return query
    return f"Dashboard context (JSON — treat as ground truth):\n```json\n{context_json}\n```\n\nQuestion: {query}"


# Prior turns are capped client-side (MAX_HISTORY_TURNS in Chatbot.js) but
# re-validated here too — never trust payload shape from the network.
MAX_HISTORY_MESSAGES = 24


def _normalize_history(history) -> list[dict]:
    """Only final answers are ever sent as history, never reasoning traces
    (see task #17: reasoning is provider-specific and often stale against a
    differently-phrased follow-up — replaying it tends to bias rather than
    help). Each entry becomes a plain {"role", "content"} turn, prepended
    ahead of the current question in every provider's messages array."""
    if not isinstance(history, list):
        return []
    out = []
    for turn in history[-MAX_HISTORY_MESSAGES:]:
        if not isinstance(turn, dict):
            continue
        role = turn.get('role')
        content = turn.get('content')
        if role in ('user', 'assistant') and isinstance(content, str) and content.strip():
            out.append({"role": role, "content": content})
    return out


# ── web search tool ─────────────────────────────────────────────────────────
# DuckDuckGo via the `ddgs` package directly, rather than an MCP subprocess —
# a plain HTML page/backend has no way to speak MCP's stdio protocol to a
# subprocess it doesn't own, and DuckDuckGo needs no API key either way, so
# a direct HTTP call is simpler and more stable than managing an MCP server
# process (see task #18 research).
MAX_TOOL_ROUNDS = 3  # initial answer attempt + up to 2 tool round-trips, caps runaway tool-call loops

# Sampling overrides from Settings → Preferences (assistant defaults). Set per
# request by the /api/chat routes; None = use each provider SDK's default.
# Safe to read without a lock: CPython assignment is atomic and these are
# write-once-per-request scalars for a single-user local app.
_GEN = {"temperature": None, "max_tokens": None}
WEB_SEARCH_MAX_RESULTS = 5

WEB_SEARCH_TOOL_OPENAI = {
    "type": "function",
    "function": {
        "name": "web_search",
        "description": (
            "Search the public web for current information — news, prices, recent events, "
            "or anything else not already covered by the dashboard context JSON. "
            "Do not use this for questions answerable from the dashboard data already provided."
        ),
        "parameters": {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "The search query"}},
            "required": ["query"],
        },
    },
}

WEB_SEARCH_TOOL_ANTHROPIC = {
    "name": "web_search",
    "description": WEB_SEARCH_TOOL_OPENAI["function"]["description"],
    "input_schema": WEB_SEARCH_TOOL_OPENAI["function"]["parameters"],
}


def _web_search(query: str, max_results: int = WEB_SEARCH_MAX_RESULTS) -> list[dict]:
    from ddgs import DDGS
    try:
        raw = DDGS().text(query, max_results=max_results)
    except Exception as e:
        return [{"error": f"Web search failed: {e}"}]
    return [
        {"title": r.get("title", ""), "url": r.get("href") or r.get("url", ""), "snippet": r.get("body", "")}
        for r in raw
    ]


def _save_screenshot(base64_image: str):
    if ',' in base64_image:
        base64_image = base64_image.split(',')[1]
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    filepath = os.path.join(SCREENSHOT_DIR, f'dashboard_{timestamp}.jpg')
    with open(filepath, 'wb') as f:
        f.write(base64.b64decode(base64_image))
    return filepath, base64_image


def _shrink_image_b64(base64_image: str, max_dim=1280, max_bytes=180_000):
    """Downscale/recompress a screenshot so it fits the small request-body
    windows some hosted endpoints enforce (see _post_with_retry docstring).
    Full-page html2canvas screenshots easily land in the 500KB-3MB range,
    which is far past what a slow/rate-limited endpoint can accept before
    it drops the connection — shrinking here fixes the cause, not just the
    symptom that retries alone would keep re-triggering."""
    raw = base64.b64decode(base64_image)
    img = Image.open(io.BytesIO(raw)).convert('RGB')

    if max(img.size) > max_dim:
        ratio = max_dim / max(img.size)
        img = img.resize((max(1, int(img.width * ratio)), max(1, int(img.height * ratio))), Image.LANCZOS)

    for quality in (75, 60, 45, 30):
        buf = io.BytesIO()
        img.save(buf, format='JPEG', quality=quality)
        encoded = base64.b64encode(buf.getvalue()).decode()
        if len(encoded) <= max_bytes:
            return encoded
    return encoded  # smallest attempt, even if still over budget


def _post_with_retry(url, headers, payload, timeout=45, max_retries=3, stream=False):
    """POST with exponential backoff for transient network failures.
    Some hosted inference gateways (e.g. shared/free-tier endpoints) enforce
    a short connection window and kill the socket mid-upload rather than
    returning a clean HTTP error — this surfaces to requests as SSLError
    (SSLEOFError) or ConnectionError, not as a retryable status code, so it
    has to be caught and retried at this level.
    With stream=True, retries only cover establishing the connection —
    once the caller starts reading the response body, a mid-stream drop
    surfaces to it directly rather than silently restarting the stream."""
    last_exc = None
    for attempt in range(max_retries):
        try:
            return requests.post(url, headers=headers, json=payload, timeout=timeout, stream=stream)
        except (requests.exceptions.SSLError, requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
            last_exc = e
            if attempt < max_retries - 1:
                time.sleep(2 ** attempt)  # 1s, 2s, 4s
    raise last_exc


def _anthropic_content(base64_image, query):
    content = []
    if base64_image:
        content.append({
            "type": "image",
            "source": {"type": "base64", "media_type": "image/jpeg", "data": base64_image},
        })
    content.append({"type": "text", "text": query})
    return content


def _anthropic_tool_use_blocks(response):
    return [b for b in response.content if getattr(b, 'type', None) == 'tool_use' and b.name == 'web_search']


def _anthropic_assistant_replay(response):
    """Reconstructs the assistant turn as plain content-block dicts so it can
    be fed back in `messages` for the next round of a tool-calling loop.
    Thinking blocks are deliberately dropped here (same call as task #17's
    multi-turn history: reasoning isn't replayed across turns) — only the
    text and tool_use blocks the next round needs are kept."""
    blocks = []
    for b in response.content:
        btype = getattr(b, 'type', None)
        if btype == 'text':
            blocks.append({"type": "text", "text": b.text})
        elif btype == 'tool_use':
            blocks.append({"type": "tool_use", "id": b.id, "name": b.name, "input": b.input})
    return blocks


def _analyze_anthropic(base64_image, query, api_key=None, model=None, timeout=None, history=None, enable_search=False, **_ignored):
    key = api_key or ANTHROPIC_API_KEY
    if not key:
        raise ValueError("No Anthropic API key — add one in the chat settings panel or set ANTHROPIC_API_KEY in backend/.env")
    client = anthropic.Anthropic(api_key=key, timeout=_clamp_timeout(timeout))

    messages = [*(history or []), {"role": "user", "content": _anthropic_content(base64_image, query)}]
    tool_kwargs = {"tools": [WEB_SEARCH_TOOL_ANTHROPIC]} if enable_search else {}
    tool_trace = []

    for _round in range(MAX_TOOL_ROUNDS):
        response = client.messages.create(
            model=model or "claude-opus-4-8", max_tokens=_GEN["max_tokens"] or 1024,
            temperature=_GEN["temperature"],
            thinking={"type": "adaptive"}, system=SYSTEM_PROMPT, messages=messages, **tool_kwargs,
        )
        tool_use_blocks = _anthropic_tool_use_blocks(response)
        if not tool_use_blocks:
            # Extended thinking blocks (type "thinking") carry the reasoning trace
            # separately from the final answer (type "text") — surface both rather
            # than discarding the thinking content as the old code did.
            reasoning = "\n".join(b.thinking for b in response.content if getattr(b, 'type', None) == 'thinking')
            text = "\n".join(b.text for b in response.content if getattr(b, 'type', None) == 'text')
            return {"content": text, "reasoning": reasoning or None, "tool_calls": tool_trace or None}

        tool_results = []
        for b in tool_use_blocks:
            search_query = (b.input or {}).get('query', '')
            results = _web_search(search_query)
            tool_trace.append({"query": search_query, "results": results})
            tool_results.append({"type": "tool_result", "tool_use_id": b.id, "content": json.dumps(results)})
        messages = [*messages, {"role": "assistant", "content": _anthropic_assistant_replay(response)}, {"role": "user", "content": tool_results}]

    return {"content": "⚠ The assistant kept requesting searches without answering — try rephrasing.", "reasoning": None, "tool_calls": tool_trace or None}


def _stream_anthropic(base64_image, query, api_key=None, model=None, timeout=None, history=None, enable_search=False, **_ignored):
    key = api_key or ANTHROPIC_API_KEY
    if not key:
        raise ValueError("No Anthropic API key — add one in the chat settings panel or set ANTHROPIC_API_KEY in backend/.env")
    client = anthropic.Anthropic(api_key=key, timeout=_clamp_timeout(timeout))

    messages = [*(history or []), {"role": "user", "content": _anthropic_content(base64_image, query)}]
    tool_kwargs = {"tools": [WEB_SEARCH_TOOL_ANTHROPIC]} if enable_search else {}

    for _round in range(MAX_TOOL_ROUNDS):
        with client.messages.stream(
            model=model or "claude-opus-4-8",
            max_tokens=_GEN["max_tokens"] or 1024,
            temperature=_GEN["temperature"],
            thinking={"type": "adaptive"},
            system=SYSTEM_PROMPT,
            messages=messages,
            **tool_kwargs,
        ) as stream:
            for event in stream:
                if event.type != "content_block_delta":
                    continue
                delta = event.delta
                delta_type = getattr(delta, 'type', None)
                if delta_type == 'thinking_delta':
                    yield {"type": "reasoning", "delta": delta.thinking}
                elif delta_type == 'text_delta':
                    yield {"type": "content", "delta": delta.text}
            response = stream.get_final_message()

        tool_use_blocks = _anthropic_tool_use_blocks(response)
        if not tool_use_blocks:
            return  # normal completion — final content already streamed above

        tool_results = []
        for b in tool_use_blocks:
            search_query = (b.input or {}).get('query', '')
            yield {"type": "tool_call", "name": "web_search", "args": {"query": search_query}}
            results = _web_search(search_query)
            yield {"type": "tool_result", "name": "web_search", "results": results}
            tool_results.append({"type": "tool_result", "tool_use_id": b.id, "content": json.dumps(results)})
        messages = [
            *messages,
            {"role": "assistant", "content": _anthropic_assistant_replay(response)},
            {"role": "user", "content": tool_results},
        ]
        # loop continues — next round streams the follow-up answer that uses these results


def _openai_content(base64_image, query):
    content = []
    if base64_image:
        content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{base64_image}"}})
    content.append({"type": "text", "text": query})
    return content


def _analyze_openai(base64_image, query, api_key=None, model=None, timeout=None, history=None, enable_search=False, **_ignored):
    key = api_key or OPENAI_API_KEY
    if not key:
        raise ValueError("No OpenAI API key — add one in the chat settings panel or set OPENAI_API_KEY in backend/.env")
    client = OpenAI(api_key=key, timeout=_clamp_timeout(timeout))

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        *(history or []),
        {"role": "user", "content": _openai_content(base64_image, query)},
    ]
    tool_kwargs = {"tools": [WEB_SEARCH_TOOL_OPENAI], "tool_choice": "auto"} if enable_search else {}
    tool_trace = []

    for _round in range(MAX_TOOL_ROUNDS):
        response = client.chat.completions.create(model=model or "gpt-4o", messages=messages, max_tokens=_GEN["max_tokens"] or 1024,
                                   temperature=_GEN["temperature"], **tool_kwargs)
        message = response.choices[0].message
        web_search_calls = [tc for tc in (message.tool_calls or []) if tc.function.name == 'web_search']
        if not web_search_calls:
            # Real OpenAI models don't expose reasoning via chat/completions, but some
            # OpenAI-compatible proxies do — pick it up if present rather than assume it never is.
            reasoning = getattr(message, 'reasoning_content', None) or getattr(message, 'reasoning', None)
            return {"content": message.content, "reasoning": reasoning, "tool_calls": tool_trace or None}

        assistant_tool_calls = [
            {"id": tc.id, "type": "function", "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
            for tc in web_search_calls
        ]
        executed = []
        for tc in web_search_calls:
            try:
                args = json.loads(tc.function.arguments or '{}')
            except json.JSONDecodeError:
                args = {}
            search_query = args.get('query', '')
            results = _web_search(search_query)
            executed.append(results)
            tool_trace.append({"query": search_query, "results": results})
        messages = [*messages, *_openai_tool_result_messages(assistant_tool_calls, executed)]

    return {"content": "⚠ The assistant kept requesting searches without answering — try rephrasing.", "reasoning": None, "tool_calls": tool_trace or None}


def _stream_openai(base64_image, query, api_key=None, model=None, timeout=None, history=None, enable_search=False, **_ignored):
    key = api_key or OPENAI_API_KEY
    if not key:
        raise ValueError("No OpenAI API key — add one in the chat settings panel or set OPENAI_API_KEY in backend/.env")
    client = OpenAI(api_key=key, timeout=_clamp_timeout(timeout))

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        *(history or []),
        {"role": "user", "content": _openai_content(base64_image, query)},
    ]
    tool_kwargs = {"tools": [WEB_SEARCH_TOOL_OPENAI], "tool_choice": "auto"} if enable_search else {}

    for _round in range(MAX_TOOL_ROUNDS):
        stream = client.chat.completions.create(model=model or "gpt-4o", messages=messages, max_tokens=_GEN["max_tokens"] or 1024, stream=True,
                                   temperature=_GEN["temperature"], **tool_kwargs)
        tool_call_acc = {}
        for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            reasoning_delta = getattr(delta, 'reasoning_content', None) or getattr(delta, 'reasoning', None)
            if reasoning_delta:
                yield {"type": "reasoning", "delta": reasoning_delta}
            if delta.content:
                yield {"type": "content", "delta": delta.content}
            for tc in (delta.tool_calls or []):
                acc = tool_call_acc.setdefault(tc.index, {"id": None, "name": None, "arguments": ""})
                if tc.id:
                    acc['id'] = tc.id
                if tc.function and tc.function.name:
                    acc['name'] = tc.function.name
                if tc.function and tc.function.arguments:
                    acc['arguments'] += tc.function.arguments

        web_search_calls = [c for c in tool_call_acc.values() if c['name'] == 'web_search']
        if not web_search_calls:
            return

        assistant_tool_calls = [
            {"id": c['id'] or f"call_{i}", "type": "function", "function": {"name": c['name'], "arguments": c['arguments']}}
            for i, c in enumerate(web_search_calls)
        ]
        executed = []
        for tc in assistant_tool_calls:
            try:
                args = json.loads(tc['function']['arguments'] or '{}')
            except json.JSONDecodeError:
                args = {}
            search_query = args.get('query', '')
            yield {"type": "tool_call", "name": "web_search", "args": {"query": search_query}}
            results = _web_search(search_query)
            yield {"type": "tool_result", "name": "web_search", "results": results}
            executed.append(results)
        messages = [*messages, *_openai_tool_result_messages(assistant_tool_calls, executed)]
        # loop continues — next round streams the follow-up answer that uses these results


_THINK_TAG_RE = re.compile(r'<think>(.*?)</think>', re.DOTALL)


def _split_inline_think_tags(text):
    """DeepSeek-R1 and similar open reasoning models — when served through
    Ollama/LM Studio/vLLM rather than a hosted API — emit their reasoning
    inline as a <think>...</think> block inside `content` rather than a
    separate reasoning_content field. Split it out so it renders in the
    same collapsible "Thinking" section as providers that do use a
    dedicated field. Returns (content_without_think, reasoning_or_None)."""
    match = _THINK_TAG_RE.search(text)
    if match:
        reasoning = match.group(1).strip()
        content = (text[:match.start()] + text[match.end():]).strip()
        return content, (reasoning or None)
    # Some deployments (e.g. Qwen3 served with its chat template's forced
    # `<think>\n` turn-prefix) never echo the opening tag back over the API —
    # the model's own generated text starts mid-think and only the closing
    # </think> is visible. Treat a lone closing tag as proof everything
    # before it was reasoning, rather than dumping it all into `content`.
    close_idx = text.find('</think>')
    if close_idx != -1:
        reasoning = text[:close_idx].strip()
        content = text[close_idx + len('</think>'):].strip()
        return content, (reasoning or None)
    return text, None


# Model names known to force a "<think>\n" turn-prefix that their own chat
# template adds to the prompt rather than the model generating it — so a raw
# passthrough API stream never shows the opening tag, only the closing one
# (see _split_inline_think_tags / _ThinkTagStreamRouter). Matched
# case-insensitively as a substring of the model id. Deliberately narrow and
# opt-in only for well-documented cases (Qwen3's `enable_thinking` chat
# template) — false-positive matching here would actively corrupt output
# (the literal "<think>" tag leaking into the visible reasoning text) for
# any model that DOES emit the opening tag explicitly, e.g. DeepSeek-R1 via
# Ollama (verified elsewhere in this codebase) — so err on the side of
# leaving a model unlisted rather than guessing.
_IMPLICIT_THINK_MODEL_PATTERNS = ('qwen3',)


def _model_uses_implicit_think(model: str) -> bool:
    model = (model or '').lower()
    return any(pattern in model for pattern in _IMPLICIT_THINK_MODEL_PATTERNS)


class _ThinkTagStreamRouter:
    """Streaming counterpart of _split_inline_think_tags: routes a sequence
    of raw content deltas into "reasoning" vs "content" events, buffering
    enough to detect a <think>/</think> tag even when it's split across two
    chunk boundaries (e.g. one chunk ends "...<thi" and the next starts
    "nk>..."). For models known to start implicitly inside a think block
    (see _IMPLICIT_THINK_MODEL_PATTERNS), starts in reasoning mode directly
    instead of waiting for an opening tag that will never arrive."""
    OPEN, CLOSE = '<think>', '</think>'

    def __init__(self, model: str = None):
        self.in_think = _model_uses_implicit_think(model)
        self.buffer = ''

    def feed(self, text):
        self.buffer += text
        events = []
        while True:
            tag = self.CLOSE if self.in_think else self.OPEN
            idx = self.buffer.find(tag)
            if idx == -1:
                # No complete tag yet — hold back a tail short enough to
                # still be a partial tag match, release everything before it.
                safe_len = max(0, len(self.buffer) - (len(tag) - 1))
                if safe_len:
                    chunk, self.buffer = self.buffer[:safe_len], self.buffer[safe_len:]
                    if chunk:
                        events.append({'type': 'reasoning' if self.in_think else 'content', 'delta': chunk})
                break
            before, self.buffer = self.buffer[:idx], self.buffer[idx + len(tag):]
            if before:
                events.append({'type': 'reasoning' if self.in_think else 'content', 'delta': before})
            self.in_think = not self.in_think
        return events

    def flush(self):
        if not self.buffer:
            return []
        events = [{'type': 'reasoning' if self.in_think else 'content', 'delta': self.buffer}]
        self.buffer = ''
        return events


def _payload_has_image(payload):
    for msg in payload.get('messages', []):
        content = msg.get('content')
        if isinstance(content, list) and any(c.get('type') == 'image_url' for c in content):
            return True
    return False


def _strip_images_from_payload(payload):
    """Drop image_url blocks from every message. Used as a fallback when a
    model rejects a request purely because it isn't multimodal — InferX (and
    presumably other aggregators serving many different base models) has no
    per-model capability metadata in its /models listing to detect this
    ahead of time, so a real Devstral/coding-model 400 is how we find out."""
    new_messages = []
    for msg in payload.get('messages', []):
        content = msg.get('content')
        if isinstance(content, list):
            content = [c for c in content if c.get('type') != 'image_url']
            if len(content) == 1 and content[0].get('type') == 'text':
                content = content[0]['text']  # collapse to a plain string when text is all that's left
        new_messages.append({**msg, 'content': content})
    return {**payload, 'messages': new_messages}


def _openai_tool_result_messages(tool_calls, executed):
    """Builds the {"role": "assistant", "tool_calls": [...]} + one
    {"role": "tool", ...} message per call that the OpenAI-compatible
    chat/completions convention requires to continue a tool-calling turn."""
    assistant_msg = {"role": "assistant", "content": None, "tool_calls": tool_calls}
    tool_msgs = [
        {"role": "tool", "tool_call_id": tc["id"], "content": json.dumps(result)}
        for tc, result in zip(tool_calls, executed)
    ]
    return [assistant_msg, *tool_msgs]


def _raw_chat_request(url, headers, payload, timeout, max_retries, unreachable_label, enable_search=False):
    """Non-streaming call to any OpenAI-compatible chat/completions endpoint.
    Shared by OpenRouter, InferX, and the custom/local provider — they only
    differ in URL, auth header, and default model, not in how the response
    is parsed. When enable_search is set, runs the standard OpenAI function-
    calling loop for the web_search tool (see MAX_TOOL_ROUNDS)."""
    if enable_search:
        payload = {**payload, "tools": [WEB_SEARCH_TOOL_OPENAI], "tool_choice": "auto"}
    tool_trace = []

    for _round in range(MAX_TOOL_ROUNDS):
        try:
            response = _post_with_retry(url, headers, payload, timeout=timeout, max_retries=max_retries)
        except (requests.exceptions.SSLError, requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
            raise Exception(f"{unreachable_label} unreachable after retries: {e}")
        if response.status_code == 400 and _payload_has_image(payload):
            # Most likely cause: the selected model isn't multimodal and rejects
            # any request carrying an image, rather than a request-shape problem
            # we could otherwise fix — retry once as text-only before giving up.
            try:
                response = _post_with_retry(url, headers, _strip_images_from_payload(payload), timeout=timeout, max_retries=1)
            except (requests.exceptions.SSLError, requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
                raise Exception(f"{unreachable_label} unreachable after retries: {e}")
            payload = _strip_images_from_payload(payload)
        if response.status_code != 200:
            raise Exception(f"{unreachable_label} {response.status_code}: {response.text[:200]}")
        message = response.json()['choices'][0]['message']
        tool_calls = [tc for tc in (message.get('tool_calls') or []) if tc.get('function', {}).get('name') == 'web_search']
        if not tool_calls:
            content, inline_reasoning = _split_inline_think_tags(message.get('content', '') or '')
            reasoning = message.get('reasoning_content') or message.get('reasoning') or inline_reasoning
            return {"content": content, "reasoning": reasoning, "tool_calls": tool_trace or None}

        executed = []
        for tc in tool_calls:
            try:
                args = json.loads(tc['function'].get('arguments') or '{}')
            except json.JSONDecodeError:
                args = {}
            search_query = args.get('query', '')
            results = _web_search(search_query)
            executed.append(results)
            tool_trace.append({"query": search_query, "results": results})
        payload = {**payload, "messages": [*payload["messages"], *_openai_tool_result_messages(tool_calls, executed)]}

    # Exhausted MAX_TOOL_ROUNDS without a final (non-tool-call) answer.
    return {"content": "⚠ The assistant kept requesting searches without answering — try rephrasing.", "reasoning": None, "tool_calls": tool_trace or None}


def _raw_chat_stream(url, headers, payload, timeout, max_retries, unreachable_label, enable_search=False):
    """Streaming (SSE) call to any OpenAI-compatible chat/completions
    endpoint — the `stream: true` + `data: {...}` / `data: [DONE]` format
    used uniformly by OpenRouter, InferX, Ollama, LM Studio, and vLLM. When
    enable_search is set, a round that ends in a web_search tool call is
    executed and followed by another streamed round (up to MAX_TOOL_ROUNDS),
    emitting "tool_call"/"tool_result" events in between so the frontend can
    show a "Searching the web…" trace."""
    if enable_search:
        payload = {**payload, "tools": [WEB_SEARCH_TOOL_OPENAI], "tool_choice": "auto"}

    for _round in range(MAX_TOOL_ROUNDS):
        stream_payload = {**payload, "stream": True}
        try:
            response = _post_with_retry(url, headers, stream_payload, timeout=timeout, max_retries=max_retries, stream=True)
        except (requests.exceptions.SSLError, requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
            raise Exception(f"{unreachable_label} unreachable after retries: {e}")
        if response.status_code == 400 and _payload_has_image(stream_payload):
            # Same non-multimodal-model fallback as the non-streaming path — the
            # first response's body hasn't been read yet, so it's safe to
            # discard and retry here without having leaked any content already.
            try:
                stream_payload = _strip_images_from_payload(stream_payload)
                response = _post_with_retry(url, headers, stream_payload, timeout=timeout, max_retries=1, stream=True)
            except (requests.exceptions.SSLError, requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
                raise Exception(f"{unreachable_label} unreachable after retries: {e}")
            payload = _strip_images_from_payload(payload)
        if response.status_code != 200:
            raise Exception(f"{unreachable_label} {response.status_code}: {response.text[:200]}")

        think_router = _ThinkTagStreamRouter(model=payload.get('model'))
        tool_call_acc = {}  # index -> {id, name, arguments} — OpenAI streams tool calls as incremental fragments
        # decode_unicode=True lets requests guess the encoding from the response
        # headers, which falls back to Latin-1 when a server (e.g. Ollama) omits
        # a charset — silently mojibake-ing multibyte UTF-8 text (curly quotes,
        # em dashes). SSE payloads are UTF-8 by convention; decode as bytes
        # ourselves instead of trusting the guess.
        for raw_bytes in response.iter_lines(decode_unicode=False):
            if not raw_bytes:
                continue
            raw_line = raw_bytes.decode('utf-8', errors='replace')
            if not raw_line.startswith('data:'):
                continue
            data = raw_line[len('data:'):].strip()
            if data == '[DONE]':
                break
            try:
                chunk = json.loads(data)
            except json.JSONDecodeError:
                continue
            choices = chunk.get('choices') or []
            if not choices:
                continue
            delta = choices[0].get('delta') or {}
            reasoning_delta = delta.get('reasoning_content') or delta.get('reasoning')
            if reasoning_delta:
                yield {"type": "reasoning", "delta": reasoning_delta}
            content_delta = delta.get('content')
            if content_delta:
                yield from think_router.feed(content_delta)
            for tc in delta.get('tool_calls') or []:
                acc = tool_call_acc.setdefault(tc.get('index', 0), {"id": None, "name": None, "arguments": ""})
                if tc.get('id'):
                    acc['id'] = tc['id']
                fn = tc.get('function') or {}
                if fn.get('name'):
                    acc['name'] = fn['name']
                if fn.get('arguments'):
                    acc['arguments'] += fn['arguments']
        yield from think_router.flush()

        web_search_calls = [c for c in tool_call_acc.values() if c['name'] == 'web_search']
        if not web_search_calls:
            return  # normal completion — final content already streamed above

        tool_calls = [
            {"id": c['id'] or f"call_{i}", "type": "function", "function": {"name": c['name'], "arguments": c['arguments']}}
            for i, c in enumerate(web_search_calls)
        ]
        executed = []
        for tc in tool_calls:
            try:
                args = json.loads(tc['function']['arguments'] or '{}')
            except json.JSONDecodeError:
                args = {}
            search_query = args.get('query', '')
            yield {"type": "tool_call", "name": "web_search", "args": {"query": search_query}}
            results = _web_search(search_query)
            yield {"type": "tool_result", "name": "web_search", "results": results}
            executed.append(results)
        payload = {**payload, "messages": [*payload["messages"], *_openai_tool_result_messages(tool_calls, executed)]}
        # loop continues — next round streams the follow-up answer that uses these results


def _openrouter_request_args(base64_image, query, api_key, model, history=None):
    key = api_key or OPENROUTER_API_KEY
    if not key:
        raise ValueError("No OpenRouter API key — add one in the chat settings panel or set REACT_APP_OPENROUTER_API_KEY in backend/.env")
    content = [{"type": "text", "text": query}]
    if base64_image:
        content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{base64_image}"}})
    payload = {
        "model": model or "meta-llama/llama-3.2-11b-vision-instruct:free",
        "messages": [*(history or []), {"role": "user", "content": content}],
    }
    headers = {
        "Authorization": f"Bearer {key}",
        "HTTP-Referer": SITE_URL,
        "X-Title": APP_NAME,
        "Content-Type": "application/json",
    }
    return "https://openrouter.ai/api/v1/chat/completions", headers, payload


def _analyze_openrouter(base64_image, query, api_key=None, model=None, timeout=None, history=None, enable_search=False, **_ignored):
    url, headers, payload = _openrouter_request_args(base64_image, query, api_key, model, history)
    return _raw_chat_request(url, headers, payload, _clamp_timeout(timeout), 3, "OpenRouter", enable_search=enable_search)


def _stream_openrouter(base64_image, query, api_key=None, model=None, timeout=None, history=None, enable_search=False, **_ignored):
    url, headers, payload = _openrouter_request_args(base64_image, query, api_key, model, history)
    yield from _raw_chat_stream(url, headers, payload, _clamp_timeout(timeout), 3, "OpenRouter", enable_search=enable_search)


def _inferx_request_args(base64_image, query, api_key, model, history=None):
    key = api_key or INFERX_API_KEY
    if not key:
        raise ValueError("No InferX API key — add one in the chat settings panel or set INFERX_API_KEY in backend/.env")
    content = [{"type": "text", "text": query}]
    if base64_image:
        small_image = _shrink_image_b64(base64_image)
        content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{small_image}"}})
    payload = {
        "model": model or "deepseek-v4-flash-0731",
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            *(history or []),
            {"role": "user", "content": content},
        ],
    }
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    return f"{INFERX_BASE_URL}/chat/completions", headers, payload


def _analyze_inferx(base64_image, query, api_key=None, model=None, timeout=None, history=None, enable_search=False, **_ignored):
    url, headers, payload = _inferx_request_args(base64_image, query, api_key, model, history)
    return _raw_chat_request(url, headers, payload, _clamp_timeout(timeout), 3, "InferX", enable_search=enable_search)


def _stream_inferx(base64_image, query, api_key=None, model=None, timeout=None, history=None, enable_search=False, **_ignored):
    url, headers, payload = _inferx_request_args(base64_image, query, api_key, model, history)
    yield from _raw_chat_stream(url, headers, payload, _clamp_timeout(timeout), 3, "InferX", enable_search=enable_search)


def _zai_request_args(base64_image, query, api_key, model, history=None):
    key = api_key or ZAI_API_KEY
    if not key:
        raise ValueError("No Z.ai API key — add one in the chat settings panel or set ZAI_API_KEY in backend/.env")
    content = [{"type": "text", "text": query}]
    if base64_image:
        small_image = _shrink_image_b64(base64_image)
        content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{small_image}"}})
    payload = {
        "model": model or "glm-4.6",
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            *(history or []),
            {"role": "user", "content": content},
        ],
    }
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    return f"{ZAI_BASE_URL}/chat/completions", headers, payload


def _analyze_zai(base64_image, query, api_key=None, model=None, timeout=None, history=None, enable_search=False, **_ignored):
    url, headers, payload = _zai_request_args(base64_image, query, api_key, model, history)
    return _raw_chat_request(url, headers, payload, _clamp_timeout(timeout), 3, "Z.ai", enable_search=enable_search)


def _stream_zai(base64_image, query, api_key=None, model=None, timeout=None, history=None, enable_search=False, **_ignored):
    url, headers, payload = _zai_request_args(base64_image, query, api_key, model, history)
    yield from _raw_chat_stream(url, headers, payload, _clamp_timeout(timeout), 3, "Z.ai", enable_search=enable_search)


def _list_zai_models(api_key):
    """Z.ai's /models endpoint exists (confirmed live — 401 without a key,
    not 404) but its response shape isn't documented publicly; parse it the
    same defensive way as InferX/OpenRouter (OpenAI-style {"data": [...]})
    and fail soft (empty list) if that assumption turns out wrong for a
    given account, rather than raise a confusing error."""
    if not api_key:
        return []
    headers = {"Authorization": f"Bearer {api_key}"}
    response = requests.get(f"{ZAI_BASE_URL}/models", headers=headers, timeout=10)
    response.raise_for_status()
    payload = response.json()
    entries = payload.get('data', payload if isinstance(payload, list) else [])
    return [{"id": m['id'], "vision": None} for m in entries if isinstance(m, dict) and m.get('id')]


def _commandcode_request_args(base64_image, query, api_key, model, history=None):
    """CommandCode Provider API (https://commandcode.ai/docs/provider).

    Standard OpenAI Chat Completions shape at {base}/chat/completions with
    Bearer auth — so it flows through the same shared raw-HTTP helpers as
    OpenRouter/InferX/Z.ai and inherits streaming, retries, history,
    think-tag routing, and the non-multimodal strip-image fallback for free.
    Their docs: text and image parts accepted; audio/file/document rejected.
    Claude-family models must go to their Anthropic-shaped /messages endpoint —
    a 400 pointing there is expected if one is sent here."""
    key = api_key or COMMANDCODE_API_KEY
    if not key:
        raise ValueError("No CommandCode API key — add one in the chat settings panel or set COMMANDCODE_API_KEY in backend/.env")
    content = [{"type": "text", "text": query}]
    if base64_image:
        small_image = _shrink_image_b64(base64_image)
        content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{small_image}"}})
    payload = {
        # No fixed default model — the catalog is fetched live from /models;
        # fall back to a current known-good open model if none was selected.
        "model": model or "deepseek/deepseek-v4-flash",
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            *(history or []),
            {"role": "user", "content": content},
        ],
    }
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    return f"{COMMANDCODE_BASE_URL}/chat/completions", headers, payload


def _analyze_commandcode(base64_image, query, api_key=None, model=None, timeout=None, history=None, enable_search=False, **_ignored):
    url, headers, payload = _commandcode_request_args(base64_image, query, api_key, model, history)
    return _raw_chat_request(url, headers, payload, _clamp_timeout(timeout), 3, "CommandCode", enable_search=enable_search)


def _stream_commandcode(base64_image, query, api_key=None, model=None, timeout=None, history=None, enable_search=False, **_ignored):
    url, headers, payload = _commandcode_request_args(base64_image, query, api_key, model, history)
    yield from _raw_chat_stream(url, headers, payload, _clamp_timeout(timeout), 3, "CommandCode", enable_search=enable_search)


def _list_commandcode_models(api_key):
    """CommandCode exposes a standard GET /models on the same /provider/v1 root
    (documented). Same defensive parse as InferX/OpenRouter; fail soft to an
    empty list so the frontend falls back to its static catalog."""
    if not api_key:
        return []
    headers = {"Authorization": f"Bearer {api_key}"}
    response = requests.get(f"{COMMANDCODE_BASE_URL}/models", headers=headers, timeout=10)
    response.raise_for_status()
    payload = response.json()
    entries = payload.get('data', payload if isinstance(payload, list) else [])
    models = []
    for m in entries:
        if not isinstance(m, dict) or not m.get('id'):
            continue
        # Some catalogs carry architecture.input_modalities like OpenRouter's —
        # use it when present so vision-capable models get the 👁 marker.
        modalities = ((m.get('architecture') or {}).get('input_modalities')) if isinstance(m.get('architecture'), dict) else None
        models.append({"id": m['id'], "vision": ('image' in modalities) if modalities else None})
    return models


def _custom_request_args(base64_image, query, api_key, model, base_url, history=None):
    """Any OpenAI-compatible chat/completions endpoint — local inference
    servers (Ollama, LM Studio, vLLM, llama.cpp's server mode) or a hosted
    provider not built in above. Base URL and model are user-supplied since
    there's no fixed catalog for an arbitrary endpoint; API key is optional
    since most local servers don't require one."""
    if not base_url:
        raise ValueError("No base URL configured for the custom endpoint — set one in the chat settings panel.")
    if not model:
        raise ValueError("No model name configured for the custom endpoint — set one in the chat settings panel.")
    content = [{"type": "text", "text": query}]
    if base64_image:
        small_image = _shrink_image_b64(base64_image)
        content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{small_image}"}})
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            *(history or []),
            {"role": "user", "content": content},
        ],
    }
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    base = base_url.rstrip('/')
    url = base if base.endswith('/chat/completions') else f"{base}/chat/completions"
    return url, headers, payload


def _analyze_custom(base64_image, query, api_key=None, model=None, base_url=None, timeout=None, history=None, enable_search=False, **_ignored):
    url, headers, payload = _custom_request_args(base64_image, query, api_key, model, base_url, history)
    # Local inference can be far slower than a hosted API (CPU offload, a big
    # model on modest hardware) — fewer retries (if a local server is down,
    # retrying won't help) but the user's timeout setting still applies in full.
    return _raw_chat_request(url, headers, payload, _clamp_timeout(timeout), 2, "Custom endpoint", enable_search=enable_search)


def _stream_custom(base64_image, query, api_key=None, model=None, base_url=None, timeout=None, history=None, enable_search=False, **_ignored):
    url, headers, payload = _custom_request_args(base64_image, query, api_key, model, base_url, history)
    yield from _raw_chat_stream(url, headers, payload, _clamp_timeout(timeout), 2, "Custom endpoint", enable_search=enable_search)


_PROVIDERS = {
    "anthropic": _analyze_anthropic,
    "openai": _analyze_openai,
    "openrouter": _analyze_openrouter,
    "inferx": _analyze_inferx,
    "zai": _analyze_zai,
    "commandcode": _analyze_commandcode,
    "custom": _analyze_custom,
}

_STREAM_PROVIDERS = {
    "anthropic": _stream_anthropic,
    "openai": _stream_openai,
    "openrouter": _stream_openrouter,
    "inferx": _stream_inferx,
    "zai": _stream_zai,
    "commandcode": _stream_commandcode,
    "custom": _stream_custom,
}

def _default_provider():
    if ANTHROPIC_API_KEY: return "anthropic"
    if OPENAI_API_KEY:    return "openai"
    if OPENROUTER_API_KEY: return "openrouter"
    if INFERX_API_KEY:    return "inferx"
    if ZAI_API_KEY:       return "zai"
    if COMMANDCODE_API_KEY: return "commandcode"
    return "anthropic"


def _request_kwargs(data, provider):
    kwargs = {
        "api_key": data.get('api_key') or None,
        "model": data.get('model') or None,
        "timeout": data.get('timeout'),
        "history": _normalize_history(data.get('history')),
        "enable_search": bool(data.get('enable_search')),
    }
    if provider == "custom":
        kwargs["base_url"] = data.get("base_url")
    return kwargs


@chatbot_bp.route('/api/chat', methods=['POST'])
def analyze_dashboard():
    data = request.json
    _GEN["temperature"] = data.get("temperature")
    _GEN["max_tokens"] = data.get("max_tokens")
    query      = data.get('query', "What can you tell me about this trading dashboard?")
    screenshot = data.get('screenshot')
    context    = data.get('context') or None  # structured dashboard state — see _build_query_with_context
    provider   = data.get('provider', _default_provider())

    if provider not in _PROVIDERS:
        return jsonify({"success": False, "response": f"Unknown provider '{provider}'."}), 400

    base64_image = None
    if screenshot:
        _, base64_image = _save_screenshot(screenshot)

    full_query = _build_query_with_context(query, context)

    try:
        result = _PROVIDERS[provider](base64_image, full_query, **_request_kwargs(data, provider))
        return jsonify({
            "success": True, "response": result["content"], "reasoning": result.get("reasoning"),
            "tool_calls": result.get("tool_calls"), "provider": provider,
        })
    except Exception as e:
        return jsonify({"success": False, "response": str(e), "provider": provider}), 500


@chatbot_bp.route('/api/chat/stream', methods=['POST'])
def analyze_dashboard_stream():
    data = request.json
    _GEN["temperature"] = data.get("temperature")
    _GEN["max_tokens"] = data.get("max_tokens")
    query      = data.get('query', "What can you tell me about this trading dashboard?")
    screenshot = data.get('screenshot')
    context    = data.get('context') or None
    provider   = data.get('provider', _default_provider())

    if provider not in _STREAM_PROVIDERS:
        return jsonify({"success": False, "response": f"Unknown provider '{provider}'."}), 400

    base64_image = None
    if screenshot:
        _, base64_image = _save_screenshot(screenshot)

    full_query = _build_query_with_context(query, context)
    kwargs = _request_kwargs(data, provider)

    def generate():
        try:
            for event in _STREAM_PROVIDERS[provider](base64_image, full_query, **kwargs):
                yield f"data: {json.dumps(event)}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
        yield f"data: {json.dumps({'type': 'done'})}\n\n"

    return Response(generate(), mimetype='text/event-stream', headers={
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',  # disable any reverse-proxy buffering, so chunks aren't held back
    })


def _list_inferx_models(api_key):
    """Query InferX's OpenAI-compatible /models endpoint for the account's
    actual available models, instead of hardcoding a list that goes stale
    the moment InferX adds or retires an endpoint. No per-model capability
    metadata is exposed (just id/created/owned_by), so vision support can't
    be known ahead of time here — see the 400-retry-without-image fallback
    in _raw_chat_request/_raw_chat_stream for how that's actually handled."""
    headers = {"Authorization": f"Bearer {api_key}"}
    response = requests.get(f"{INFERX_BASE_URL}/models", headers=headers, timeout=10)
    response.raise_for_status()
    payload = response.json()
    entries = payload.get('data', payload if isinstance(payload, list) else [])
    return [{"id": m['id'], "vision": None} for m in entries if isinstance(m, dict) and m.get('id')]


def _list_openrouter_models(api_key=None):
    """OpenRouter's /models endpoint is public (no key required) and, unlike
    InferX's, carries real per-model capability metadata — architecture.
    input_modalities tells us which models actually accept image input, so
    the frontend can show that instead of only discovering it by trial and
    error."""
    response = requests.get("https://openrouter.ai/api/v1/models", timeout=10)
    response.raise_for_status()
    entries = response.json().get('data', [])
    models = []
    for m in entries:
        if not isinstance(m, dict) or not m.get('id'):
            continue
        modalities = ((m.get('architecture') or {}).get('input_modalities')) or []
        models.append({"id": m['id'], "vision": 'image' in modalities})
    return models


# One dynamic-catalog endpoint shared by every provider that has a /models
# API, instead of a bespoke route per provider (the InferX-only version this
# replaced didn't generalize to OpenRouter — or to whatever's added next).
_MODEL_LISTERS = {
    "inferx": lambda api_key: _list_inferx_models(api_key or INFERX_API_KEY),
    "openrouter": lambda api_key: _list_openrouter_models(api_key),
    "zai": lambda api_key: _list_zai_models(api_key or ZAI_API_KEY),
    "commandcode": lambda api_key: _list_commandcode_models(api_key or COMMANDCODE_API_KEY),
}


@chatbot_bp.route('/api/chat/models', methods=['POST'])
def list_models():
    data = request.json or {}
    provider = data.get('provider')
    lister = _MODEL_LISTERS.get(provider)
    if not lister:
        return jsonify({"models": []})
    api_key = data.get('api_key') or None
    if provider == 'inferx' and not (api_key or INFERX_API_KEY):
        return jsonify({"models": []})
    try:
        return jsonify({"models": lister(api_key)})
    except Exception as e:
        # Not fatal — the frontend falls back to its static model list.
        return jsonify({"models": [], "error": str(e)})


@chatbot_bp.route('/api/chat/providers', methods=['GET'])
def list_providers():
    available = []
    if ANTHROPIC_API_KEY:
        available.append({"id": "anthropic", "name": "Claude (Anthropic)", "model": "claude-opus-4-8"})
    if OPENAI_API_KEY:
        available.append({"id": "openai", "name": "GPT-4o (OpenAI)", "model": "gpt-4o"})
    if OPENROUTER_API_KEY:
        available.append({"id": "openrouter", "name": "OpenRouter", "model": "google/gemma-4-26b-a4b-it:free"})
    if INFERX_API_KEY:
        available.append({"id": "inferx", "name": "InferX", "model": "deepseek-v4-flash-0731"})
    if ZAI_API_KEY:
        available.append({"id": "zai", "name": "Z.ai", "model": "glm-4.6"})
    if COMMANDCODE_API_KEY:
        available.append({"id": "commandcode", "name": "CommandCode", "model": "deepseek/deepseek-v4-flash"})

    # always return every provider so the user can pick one and enter their own key
    all_providers = [
        {"id": "anthropic", "name": "Claude (Anthropic)"},
        {"id": "openai",    "name": "GPT-4o (OpenAI)"},
        {"id": "openrouter","name": "OpenRouter"},
        {"id": "inferx",    "name": "InferX"},
        {"id": "zai",       "name": "Z.ai"},
        {"id": "commandcode", "name": "CommandCode"},
        {"id": "custom",    "name": "Custom / Local"},
    ]
    return jsonify({"providers": all_providers, "configured": available, "default": _default_provider()})
