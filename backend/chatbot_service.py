# backend/chatbot_service.py
import base64
import os
import warnings
from datetime import datetime

import anthropic
import requests
from dotenv import load_dotenv
from flask import Blueprint, jsonify, request
from openai import OpenAI

load_dotenv()

chatbot_bp = Blueprint('chatbot', __name__)

ANTHROPIC_API_KEY = os.getenv('ANTHROPIC_API_KEY')
OPENAI_API_KEY = os.getenv('OPENAI_API_KEY')
OPENROUTER_API_KEY = os.getenv('REACT_APP_OPENROUTER_API_KEY')

if not any([ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY]):
    warnings.warn("No LLM API keys set — chatbot will error. "
                  "Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or REACT_APP_OPENROUTER_API_KEY in backend/.env "
                  "or enter keys directly in the chat settings panel.")

SITE_URL = "http://localhost:3000"
APP_NAME = "Trading Dashboard Assistant"

SCREENSHOT_DIR = os.path.join(os.path.dirname(__file__), 'screenshots')
os.makedirs(SCREENSHOT_DIR, exist_ok=True)

SYSTEM_PROMPT = (
    "You are a trading assistant analyzing an options trading dashboard. "
    "Answer questions about the trading data, P&L, positions, and charts shown. "
    "Be concise and data-driven."
)


def _save_screenshot(base64_image: str):
    if ',' in base64_image:
        base64_image = base64_image.split(',')[1]
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    filepath = os.path.join(SCREENSHOT_DIR, f'dashboard_{timestamp}.jpg')
    with open(filepath, 'wb') as f:
        f.write(base64.b64decode(base64_image))
    return filepath, base64_image


def _analyze_anthropic(base64_image, query, api_key=None, model=None):
    key = api_key or ANTHROPIC_API_KEY
    if not key:
        raise ValueError("No Anthropic API key — add one in the chat settings panel or set ANTHROPIC_API_KEY in backend/.env")
    client = anthropic.Anthropic(api_key=key)

    content = []
    if base64_image:
        content.append({
            "type": "image",
            "source": {"type": "base64", "media_type": "image/jpeg", "data": base64_image},
        })
    content.append({"type": "text", "text": query})

    response = client.messages.create(
        model=model or "claude-opus-4-8",
        max_tokens=1024,
        thinking={"type": "adaptive"},
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": content}],
    )
    return next(b.text for b in response.content if b.type == "text")


def _analyze_openai(base64_image, query, api_key=None, model=None):
    key = api_key or OPENAI_API_KEY
    if not key:
        raise ValueError("No OpenAI API key — add one in the chat settings panel or set OPENAI_API_KEY in backend/.env")
    client = OpenAI(api_key=key)

    content = []
    if base64_image:
        content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{base64_image}"}})
    content.append({"type": "text", "text": query})

    response = client.chat.completions.create(
        model=model or "gpt-4o",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": content},
        ],
        max_tokens=1024,
    )
    return response.choices[0].message.content


def _analyze_openrouter(base64_image, query, api_key=None, model=None):
    key = api_key or OPENROUTER_API_KEY
    if not key:
        raise ValueError("No OpenRouter API key — add one in the chat settings panel or set REACT_APP_OPENROUTER_API_KEY in backend/.env")

    content = [{"type": "text", "text": query}]
    if base64_image:
        content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{base64_image}"}})

    payload = {
        "model": model or "meta-llama/llama-3.2-11b-vision-instruct:free",
        "messages": [{"role": "user", "content": content}],
    }
    headers = {
        "Authorization": f"Bearer {key}",
        "HTTP-Referer": SITE_URL,
        "X-Title": APP_NAME,
        "Content-Type": "application/json",
    }
    response = requests.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers=headers, json=payload, timeout=30,
    )
    if response.status_code != 200:
        raise Exception(f"OpenRouter {response.status_code}: {response.text[:200]}")
    return response.json()['choices'][0]['message']['content']


_PROVIDERS = {
    "anthropic": _analyze_anthropic,
    "openai": _analyze_openai,
    "openrouter": _analyze_openrouter,
}

def _default_provider():
    if ANTHROPIC_API_KEY: return "anthropic"
    if OPENAI_API_KEY:    return "openai"
    if OPENROUTER_API_KEY: return "openrouter"
    return "anthropic"


@chatbot_bp.route('/api/chat', methods=['POST'])
def analyze_dashboard():
    data = request.json
    query    = data.get('query', "What can you tell me about this trading dashboard?")
    screenshot = data.get('screenshot')
    provider = data.get('provider', _default_provider())
    model    = data.get('model') or None      # frontend-selected model
    api_key  = data.get('api_key') or None    # user-entered key from UI

    if provider not in _PROVIDERS:
        return jsonify({"success": False, "response": f"Unknown provider '{provider}'."}), 400

    base64_image = None
    if screenshot:
        _, base64_image = _save_screenshot(screenshot)

    try:
        analysis = _PROVIDERS[provider](base64_image, query, api_key=api_key, model=model)
        return jsonify({"success": True, "response": analysis, "provider": provider})
    except Exception as e:
        return jsonify({"success": False, "response": str(e), "provider": provider}), 500


@chatbot_bp.route('/api/chat/providers', methods=['GET'])
def list_providers():
    available = []
    if ANTHROPIC_API_KEY:
        available.append({"id": "anthropic", "name": "Claude (Anthropic)", "model": "claude-opus-4-8"})
    if OPENAI_API_KEY:
        available.append({"id": "openai", "name": "GPT-4o (OpenAI)", "model": "gpt-4o"})
    if OPENROUTER_API_KEY:
        available.append({"id": "openrouter", "name": "Llama (OpenRouter)", "model": "llama-3.2-11b-vision"})

    # always return all three so user can pick and enter their own key
    all_providers = [
        {"id": "anthropic", "name": "Claude (Anthropic)"},
        {"id": "openai",    "name": "GPT-4o (OpenAI)"},
        {"id": "openrouter","name": "Llama (OpenRouter)"},
    ]
    return jsonify({"providers": all_providers, "configured": available, "default": _default_provider()})
