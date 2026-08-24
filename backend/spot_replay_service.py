# backend/spot_replay_service.py
"""
Spot Replay — the agent pipeline behind the dynamic options-analysis dashboard.

This is the backend counterpart to src/SpotReplay.js. Instead of regenerating a
static HTML report per position (see files/crwd_analysis_report.html), the user
submits a position once and this service streams an agent run:

    POST /api/spot-replay/analyze   (SSE — stage events, then one `result` event)
    POST /api/spot-replay/parse     (instant text→position parsing for form prefill)

Pipeline stages (each streamed as an SSE event so the UI shows live progress):

    1. parse     — structured fields OR markdown-ish free text ("Ticker: CRWD
                   Option: Put Strike: $190 ...") → normalized position dict
    2. data      — daily OHLCV via yfinance (6mo) with Alpaca fallback; cached
    3. research  — web search via SearchAPI.io's DuckDuckGo engine (key in
                   SEARCHAPI_API_KEY / ~/duckduckgokey), falling back to the
                   local `ddgs` package; LLM may request follow-up queries
    4. quant     — the 8-stage model engine in spot_analysis.py
    5. synthesis — provider LLM (reuses chatbot_service providers) writes the
                   analyst narrative from quant JSON + research, with a
                   self-critique pass; optional VLM read of a chart screenshot

LLM/VLM connectivity is deliberately *not* reimplemented here — it imports the
provider registry from chatbot_service so settings, retries, timeouts, vision
fallbacks etc. stay identical across both surfaces.
"""

import base64
import json
import os
import re
from datetime import datetime, timedelta

import pandas as pd
import requests
import spot_analysis
import yfinance as yf
from dotenv import load_dotenv
from flask import Blueprint, Response, jsonify, request

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

spot_bp = Blueprint("spot_replay", __name__)

# ── SearchAPI.io DuckDuckGo ──────────────────────────────────────────────────
# Primary search path per design (files/spot-replay-design.md). The key lives in
# backend/.env (SEARCHAPI_API_KEY); ~/duckduckgokey is accepted as a fallback
# source since that's where the key was provisioned.
SEARCHAPI_KEY = os.getenv("SEARCHAPI_API_KEY", "")
_SEARCHAPI_URL = "https://www.searchapi.io/api/v1/search"

if not SEARCHAPI_KEY:
    for _candidate in (
        os.path.expanduser("~/duckduckgokey"),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "duckduckgokey"),
    ):
        if os.path.exists(_candidate):
            try:
                with open(_candidate) as fh:
                    SEARCHAPI_KEY = fh.read().strip()
                break
            except OSError:
                pass


def _search_duckduckgo(query: str, max_results: int = 5) -> list:
    """Search via SearchAPI.io's DDG engine; fall back to the ddgs package.

    Both return a normalized list of {title, url, snippet} dicts so callers
    don't care which path served the results."""
    if SEARCHAPI_KEY:
        try:
            resp = requests.get(
                _SEARCHAPI_URL,
                params={"engine": "duckduckgo", "q": query, "api_key": SEARCHAPI_KEY},
                timeout=15,
            )
            if resp.status_code == 200:
                organic = resp.json().get("organic_results") or []
                out = []
                for r in organic[:max_results]:
                    out.append({
                        "title": r.get("title", ""),
                        "url": r.get("link") or r.get("url", ""),
                        "snippet": r.get("snippet", ""),
                    })
                if out:
                    return out
        except requests.RequestException:
            pass  # fall through to the local package
    # Fallback: direct DuckDuckGo scraping via ddgs (no API key needed).
    try:
        from ddgs import DDGS
        raw = DDGS().text(query, max_results=max_results)
        return [
            {"title": r.get("title", ""), "url": r.get("href") or r.get("url", ""), "snippet": r.get("body", "")}
            for r in raw
        ]
    except Exception as e:
        return [{"error": f"Search failed: {e}"}]


# ── Stage 1: position parsing ────────────────────────────────────────────────

_MONTHS = {m.lower(): i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], start=1)}


def _money(val_str):
    """'$1,234.56' / '0.69' / '1234' → float."""
    if val_str is None:
        return None
    cleaned = re.sub(r"[$,\s]", "", str(val_str))
    try:
        return float(cleaned)
    except ValueError:
        return None


def parse_position_text(text: str) -> dict:
    """Parse the paste-friendly position block into a normalized position dict.

    Tolerant of: '$' prefixes, thousands separators, 'Aug 21' / '2026-08-21' /
    '08/21/2026' expiry formats, case-insensitive keys, missing purchase date.

    Returns {"ok": bool, "position": {...}, "missing": [field...], "warnings": [...]}.
    """
    pos = {}
    warnings_out = []
    lines = [l.strip() for l in (text or "").splitlines() if l.strip()]
    joined = "\n".join(lines)

    def grab(pattern):
        m = re.search(pattern, joined, re.IGNORECASE)
        return m.group(1).strip() if m else None

    ticker = grab(r"\b(?:ticker|symbol)\s*[:=]\s*([A-Za-z.\-]{1,10})\b")
    option_type = grab(r"\boption\s*(?:type)?\s*[:=]\s*\$?\b(put|call)\b")
    strike = _money(grab(r"\bstrike\s*[:=]\s*\$?([\d,.]+)"))
    avg_cost = _money(grab(r"\b(?:average\s*cost|avg\.?\s*cost|cost)\s*[:=]\s*\$?([\d,.]+)"))
    contracts = grab(r"\bcontracts?\s*[:=]\s*(\d+)")
    opt_price = _money(grab(r"\bcurrent\s+(?:option\s+)?price\s*[:=]\s*\$?([\d,.]+)"))
    expiry_raw = grab(r"\bexpiry(?:\s*date)?\s*[:=]\s*([^\n]+)")
    purchase_raw = grab(r"\bpurchase\s*date\s*[:=]\s*([^\n]+)")

    if ticker:
        pos["ticker"] = ticker.upper()
    if option_type:
        pos["option_type"] = option_type.capitalize()
    if strike is not None:
        pos["strike"] = strike
    if avg_cost is not None:
        pos["avg_cost"] = avg_cost
    if contracts:
        pos["contracts"] = int(contracts)
    if opt_price is not None:
        pos["current_option_price"] = opt_price

    def parse_date(raw):
        if not raw:
            return None
        raw = raw.strip()
        for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%d-%m-%Y"):
            try:
                return datetime.strptime(raw.split()[0], fmt).strftime("%Y-%m-%d")
            except ValueError:
                continue
        m = re.match(r"(?:([A-Za-z]{3,9})\s*)?(\d{1,2})?,?\s*(\d{4})", raw)  # "Aug 21 2026"
        if m:
            mon, day, year = m.group(1), m.group(2) or "1", m.group(3)
            mi = _MONTHS.get(mon.lower()[:3]) if mon else None
            if mi:
                try:
                    return datetime(int(year), mi, int(day)).strftime("%Y-%m-%d")
                except ValueError:
                    pass
        return None

    exp = parse_date(expiry_raw)
    pur = parse_date(purchase_raw)
    if exp:
        pos["expiry"] = exp
    if pur:
        pos["purchase_date"] = pur

    required = ["ticker", "option_type", "strike", "expiry", "avg_cost",
                "contracts", "current_option_price"]
    missing = [f for f in required if f not in pos]
    if not missing and pos.get("avg_cost") == 0:
        warnings_out.append("Average cost is $0 — verify that's intentional.")
    return {"ok": len(missing) == 0, "position": pos, "missing": missing,
            "warnings": warnings_out}


# ── Stage 2: OHLCV acquisition (yfinance → Alpaca fallback, cached) ─────────

def fetch_daily_ohlcv(ticker: str) -> tuple[pd.DataFrame, str]:
    """Daily bars, most recent last. Returns (df, provider).

    yfinance first (zero-config); Alpaca IEX daily bars as the fallback when
    yfinance returns nothing usable (delistings, rate limits). Alpaca creds are
    reused from app.py so the same env/UI keys serve both features."""
    end = datetime.now() + timedelta(days=1)
    start = end - timedelta(days=200)

    try:
        raw = yf.download(ticker, period="6mo", interval="1d", progress=False, auto_adjust=False)
        if raw is not None and not raw.empty:
            df = raw.copy()
            # yfinance sometimes returns MultiIndex columns (ticker level).
            if isinstance(df.columns, pd.MultiIndex):
                df.columns = df.columns.get_level_values(0)
            rename = {"Open": "open", "High": "high", "Low": "low", "Close": "close", "Volume": "volume"}
            df = df.rename(columns=rename)
            need = {"open", "high", "low", "close"}
            if need.issubset(set(c.lower() for c in df.columns)):
                df.columns = [c.lower() for c in df.columns]
                df.index = pd.to_datetime(df.index)
                if len(df) >= 30:
                    return df[["open", "high", "low", "close", "volume"]], "yfinance"
    except Exception as e:
        print(f"[spot-replay] yfinance failed for {ticker}: {e}")

    # Fallback: reuse app.py's Alpaca fetcher (deferred import avoids the
    # circular app ↔ blueprint import at module load time).
    try:
        from app import _fetch_alpaca
        bars = _fetch_alpaca(
            ticker, start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d"), "1d")
        if bars is not None and not bars.empty:
            df = bars.rename(columns={
                "datetime": "date", "Open": "open", "High": "high",
                "Low": "low", "Close": "close", "Volume": "volume"})
            df["date"] = pd.to_datetime(df["date"]).dt.tz_localize(None)
            df = df.set_index("date").sort_index()
            return df[["open", "high", "low", "close", "volume"]], "alpaca"
    except Exception as e:
        print(f"[spot-replay] alpaca failed for {ticker}: {e}")

    raise ValueError(f"No price data available for {ticker} (tried yfinance and Alpaca)")


# ── Stage 3: research agent ──────────────────────────────────────────────────

def _base_queries(ticker: str) -> list:
    year = datetime.now().year
    return [
        f"{ticker} stock news today {year}",
        f"{ticker} earnings date {year}",
        f"{ticker} analyst price target",
        f"{ticker} short interest insider selling",
    ]


def run_research(ticker: str, emit, llm_call=None, max_followups: int = 2) -> list:
    """Agent loop over web search.

    Deterministic base queries always run; then, when an LLM is configured, it
    gets one round to request up to `max_followups` targeted queries based on
    what came back (capped — runaway loops are worse than slightly less depth).
    Returns the flattened, deduplicated findings list.
    """
    findings = []
    seen_urls = set()

    def run_batch(queries):
        for q in queries:
            emit("research", f'Searching: "{q}"')
            for r in _search_duckduckgo(q):
                url = r.get("url") or ""
                if url and url not in seen_urls:
                    seen_urls.add(url)
                    findings.append({"query": q, **r})

    run_batch(_base_queries(ticker))

    if llm_call and findings:
        snippet_digest = "\n".join(
            f"- [{f['title']}] {f['snippet'][:160]}" for f in findings[:12])
        ask = (
            f"I'm analyzing an options position on {ticker}. Initial web search found:\n"
            f"{snippet_digest}\n\n"
            f"Suggest up to {max_followups} additional specific search queries that would "
            f"surface decision-critical catalysts NOT covered above (binary events, insider "
            f"activity, sector moves). Reply with ONLY the queries, one per line, no numbering."
        )
        try:
            reply = llm_call(ask)["content"]
            # The model was told: queries only, one per line. Take what looks
            # like a query line, cap at max_followups.
            followups = [l.strip("-•0123456789. ").strip() for l in reply.splitlines()]
            followups = [q for q in followups if 5 < len(q) < 120][:max_followups]
            if followups:
                emit("research", f"Agent follow-up searches: {len(followups)}")
                run_batch(followups)
        except Exception as e:
            emit("research", f"Follow-up generation skipped ({str(e)[:80]})")

    return findings


# ── Stage 5: synthesis (LLM narrative + optional VLM chart read) ────────────

_SYNTHESIS_PROMPT = (
    "You are a senior options analyst writing the final narrative section of a quantitative "
    "report. You are given the full quant-model output as JSON and web-research findings. Write:\n"
    "1. **Verdict** — one paragraph: HOLD or SELL with the single strongest reason.\n"
    "2. **Model read** — which models agree/disagree and what that implies about conviction.\n"
    "3. **Catalysts** — tie the research findings to the probability picture; call out any "
    "binary event before expiry the models can't see.\n"
    "4. **Risk check** — the strongest argument AGAINST your verdict.\n"
    "Be concise and data-driven; cite concrete numbers from the JSON. Use markdown. "
    "End with the line: 'This is quantitative analysis, not financial advice.'\n\n"
    "Then do a self-critique pass under '**Self-check**': challenge your own verdict as if a "
    "skeptical PM asked \"are you sure this is the best analysis you can do?\" — fix anything "
    "you find, or state why it holds."
)


def build_synthesis_query(result: dict, research: list) -> str:
    """Assembles the quant-JSON + research digest prompt for the synthesis call."""
    slim_result = {k: v for k, v in result.items() if k != "chart"}  # chart series are bulky & visual-only
    research_digest = "\n".join(
        f"- [{f.get('title','')}]({f.get('url','')}) {f.get('snippet','')[:220]}"
        for f in research[:14] if not f.get("error")
    )
    return (
        f"{_SYNTHESIS_PROMPT}\n\n"
        f"## Quant model output\n```json\n{json.dumps(slim_result, default=str)[:9000]}\n```\n\n"
        f"## Web research findings\n{research_digest or '(no findings)'}"
    )


# ── Routes ───────────────────────────────────────────────────────────────────

@spot_bp.route("/api/spot-replay/parse", methods=["POST"])
def parse_position():
    """Instant text→position parse for prefilling the form (no agent run)."""
    data = request.json or {}
    parsed = parse_position_text(data.get("text") or "")
    return jsonify(parsed)


@spot_bp.route("/api/spot-replay/analyze", methods=["POST"])
def analyze():
    """Full agent pipeline, streamed as Server-Sent Events.

    Body: either {text: "<paste block>"} or a structured position object,
    plus optional {provider, api_key, model, timeout, image (dataURL)} —
    same provider-settings shape the chat assistant sends.
    """
    data = request.json or {}

    def sse(event_type, payload):
        return f"data: {json.dumps({'type': event_type, **payload})}\n\n"

    def generate():
        # Stage events are buffered and drained after each pipeline step so the
        # nested emit() closure can append without fighting generator scopes.
        buf = []

        def emit(stage, message):
            print(f"[spot-replay][{stage}] {message}")  # backend log visibility
            buf.append(sse("stage", {"stage": stage, "message": message}))

        def flush():
            out = "".join(buf)
            buf.clear()
            return out

        try:
            # ── 1. parse ─────────────────────────────────────────────────────
            if data.get("text"):
                parsed = parse_position_text(data["text"])
            else:
                # Structured form input — normalize into the same shape.
                p = {k: data.get(k) for k in
                     ("ticker", "option_type", "strike", "expiry", "avg_cost",
                      "contracts", "current_option_price", "purchase_date")}
                p = {k: v for k, v in p.items() if v not in (None, "")}
                missing = [k for k in ("ticker", "option_type", "strike", "expiry",
                                       "avg_cost", "contracts", "current_option_price") if k not in p]
                parsed = {"ok": not missing, "position": p, "missing": missing, "warnings": []}
            yield flush()
            if not parsed["ok"]:
                yield sse("error", {"stage": "parse", "message":
                                    f"Missing required inputs: {', '.join(parsed['missing'])}"})
                return
            position = parsed["position"]
            position.setdefault("contracts", 1)
            position["strike"] = float(position["strike"])
            position["avg_cost"] = float(position.get("avg_cost") or 0)
            position["contracts"] = int(position.get("contracts") or 1)
            position["current_option_price"] = float(position["current_option_price"])
            position["expiry_dt"] = datetime.strptime(position["expiry"], "%Y-%m-%d")
            yield sse("parsed", {"position": {k: v for k, v in position.items() if k != "expiry_dt"}})

            # ── 2. data ──────────────────────────────────────────────────────
            emit("data", f"Fetching daily OHLCV for {position['ticker']}…")
            yield flush()
            df, ohlcv_provider = fetch_daily_ohlcv(position["ticker"])
            emit("data", f"{len(df)} daily bars loaded via {ohlcv_provider}")
            yield flush()

            # ── 4. quant (runs before research so the LLM sees real numbers) ─
            emit("quant", "Running 8-stage quant pipeline (indicators, vol regimes, MC, ARIMA, GB+RF)…")
            yield flush()
            result = spot_analysis.run_analysis(df, position)
            emit("quant", f"P(ITM)={result['monte_carlo']['ensemble_prob_itm_pct']:.1f}% "
                          f"| EV hold ${result['decision']['ev_hold']:.2f} vs sell "
                          f"${result['decision']['ev_sell']:.2f} → {result['decision']['recommendation']}")
            yield flush()

            # ── 3. research (agent loop) ─────────────────────────────────────
            llm_call = None
            provider = data.get("provider")
            api_key = data.get("api_key") or None
            if provider:
                try:
                    import chatbot_service as cs
                    analyze_fn = cs._PROVIDERS.get(provider)
                    if analyze_fn:
                        def llm_call(prompt, _fn=analyze_fn):
                            img = data.get("image")  # optional VLM chart screenshot
                            b64 = img.split(",", 1)[1] if (img and "," in img) else (img or None)
                            kwargs = {
                                "api_key": api_key,
                                "model": data.get("model") or None,
                                "timeout": _clamp_timeout(data.get("timeout")),
                            }
                            # The custom/local provider needs its user-supplied base URL.
                            if provider == "custom":
                                kwargs["base_url"] = data.get("base_url")
                            return _fn(b64, prompt, **kwargs)
                except Exception as e:
                    emit("llm", f"LLM unavailable ({str(e)[:60]}); continuing without it.")
                    llm_call = None
            yield flush()

            findings = []
            if data.get("enable_research", True):
                emit("research", "Starting web research (DuckDuckGo)…")
                yield flush()
                findings = run_research(position["ticker"], emit, llm_call=llm_call)
                emit("research", f"{len(findings)} unique sources gathered")
                yield flush()
            else:
                emit("research", "Research disabled — skipping.")

            # ── 5. synthesis ─────────────────────────────────────────────────
            narrative = None
            if llm_call:
                emit("llm", "Writing analyst narrative + self-critique pass…")
                yield flush()
                try:
                    synth = llm_call(build_synthesis_query(result, findings))
                    narrative = {"content": synth["content"], "reasoning": synth.get("reasoning")}
                    emit("llm", "Narrative complete.")
                except Exception as e:
                    emit("llm", f"Synthesis failed: {str(e)[:120]}")
                yield flush()
            else:
                emit("llm", "No LLM provider configured — showing models + tables only.")
                yield flush()

            yield sse("result", {
                "analysis": result,
                "research": findings,
                "narrative": narrative,
                "data_provider": ohlcv_provider,
                "summary": spot_analysis.summarize_analysis(result),
            })
        except Exception as e:
            import traceback
            traceback.print_exc()
            yield sse("error", {"stage": "pipeline", "message": str(e)})
        yield sse("done", {})

    return Response(generate(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _clamp_timeout(timeout):
    """Same bounds as chatbot_service — imported lazily to keep startup order free."""
    try:
        import chatbot_service as cs
        return cs._clamp_timeout(timeout)
    except Exception:
        try:
            t = float(timeout) if timeout is not None else 60
        except (TypeError, ValueError):
            t = 60
        return max(5, min(t, 600))
