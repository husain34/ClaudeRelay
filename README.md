# Anthropic → OpenAI Proxy

A lightweight, zero-dependency Node.js proxy that translates **Anthropic API format** (used by Claude Code and the Anthropic SDK) into **OpenAI-compatible format**, letting you point Claude Code at **any OpenAI-compatible LLM provider** — NVIDIA NIM, Together AI, Groq, OpenRouter, local Ollama, LM Studio, and more.

```
Claude Code  ──Anthropic format──►  proxy.js :20128  ──OpenAI format──►  NVIDIA NIM / Groq / Ollama / ...
```

Works on **Windows, Linux, and macOS**.

---

## Requirements

- **Node.js >= 18** — no npm install needed (zero external dependencies)
- An API key from your chosen LLM provider

Check your Node version:
```bash
node --version
```

---

## Quick Start

**1. Copy and fill in your config:**

```bash
# Linux / macOS
cp .env.example .env
# then edit .env with your API key and provider URL

# Windows (PowerShell / CMD)
copy .env.example .env
```

**2. Start the proxy:**

| Platform | Method | Command |
|----------|--------|---------|
| **Any** | npm | `npm start` |
| **Any** | Node directly | `node proxy.js` |
| **Linux / macOS** | Shell script | `./linux-mac/start-proxy.sh` |
| **Windows** | Double-click | `windows\start-proxy.bat` |
| **Windows** | PowerShell / CMD | `.\windows\start-proxy.bat` |

**3. Point Claude Code at the proxy:**

```bash
# Linux / macOS
export ANTHROPIC_BASE_URL="http://localhost:20128"
export ANTHROPIC_API_KEY="proxy"
claude
```

```powershell
# Windows
$env:ANTHROPIC_BASE_URL = "http://localhost:20128"
$env:ANTHROPIC_API_KEY  = "proxy"
claude
```

---

## Configuration (`.env`)

All settings live in `.env` — no code edits ever needed.

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_BASE_URL` | `https://integrate.api.nvidia.com/v1` | Upstream OpenAI-compatible API URL |
| `LLM_API_KEY` | *(required)* | API key for the upstream provider |
| `MODEL` | `nvidia/nemotron-3-super-120b-a12b` | Model name sent to the upstream API |
| `ANTHROPIC_BASE_URL` | `http://localhost:20128` | Where your Anthropic clients should connect |
| `ANTHROPIC_API_KEY` | `proxy` | Fake key for the proxy (any string works) |
| `PROXY_PORT` | `20128` | Port the proxy listens on |
| `PROXY_RATE_LIMIT_RPM` | `38` | Max upstream requests per minute |
| `PROXY_TIMEOUT_SECONDS` | `300` | Upstream request timeout (seconds) |

---

## Switching Providers

Change `LLM_BASE_URL`, `LLM_API_KEY`, and `MODEL` in `.env`, then restart.

| Provider | `LLM_BASE_URL` | Example `MODEL` |
|----------|---------------|-----------------|
| **NVIDIA NIM** (default) | `https://integrate.api.nvidia.com/v1` | `nvidia/nemotron-3-super-120b-a12b` |
| **Together AI** | `https://api.together.xyz/v1` | `meta-llama/Llama-3-70b-chat-hf` |
| **Groq** | `https://api.groq.com/openai/v1` | `llama3-70b-8192` |
| **OpenRouter** | `https://openrouter.ai/api/v1` | `anthropic/claude-3-haiku` |
| **Ollama** (local) | `http://localhost:11434/v1` | `llama3` |
| **LM Studio** (local) | `http://localhost:1234/v1` | `llama3` |

For local providers (Ollama, LM Studio) set `LLM_API_KEY=local` — any non-empty string works.

---

## Using with Other Anthropic Clients

### Claude Code CLI

```bash
# Linux / macOS
export ANTHROPIC_BASE_URL="http://localhost:20128"
export ANTHROPIC_API_KEY="proxy"
claude

# Windows (PowerShell)
$env:ANTHROPIC_BASE_URL = "http://localhost:20128"
$env:ANTHROPIC_API_KEY  = "proxy"
claude
```

### Python Anthropic SDK
```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:20128",
    api_key="proxy",
)

message = client.messages.create(
    model="any-string",   # model is controlled by MODEL in .env
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)
print(message.content[0].text)
```

### curl
```bash
curl http://localhost:20128/v1/messages \
  -H "x-api-key: proxy" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "any-string",
    "max_tokens": 128,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/messages` | `POST` | Main chat endpoint (Anthropic format, streaming supported) |
| `/health` | `GET` | Health check — returns `{"status":"ok","model":"..."}` |

---

## Running Tests

The proxy must **not** be running when you use the runner scripts — they start and stop it automatically.

### Linux / macOS
```bash
chmod +x tests/run-tests.sh
./tests/run-tests.sh
```

### Windows
```bat
tests\run-tests.bat
```

### npm (any platform — proxy must already be running)
```bash
npm test              # core suite only  (31 assertions)
npm run test:limits   # boundary suite   (40 assertions)
npm run test:all      # both suites back-to-back
```

The test suite covers 7 scenarios (31 assertions):

| Test | What it checks |
|------|---------------|
| Health check | `/health` returns 200 + model name |
| Non-streaming | Full Anthropic response shape, usage tokens, stop_reason |
| Streaming SSE | All 7 Anthropic SSE event types, text reconstruction |
| Tool use | Model calls tools correctly, stop_reason `tool_use` |
| Rate-limit queue | 3 burst requests complete without crash |
| Malformed input | Empty body, bad JSON, wrong method — server survives all |
| Client disconnect | Mid-stream kill handled; server stays alive |

---

## How It Works

```
1. Claude Code sends POST /v1/messages  (Anthropic JSON format)
2. proxy.js converts it to OpenAI chat/completions format
3. proxy.js forwards to your upstream LLM (LLM_BASE_URL)
4. Response (streaming or not) is converted back to Anthropic format
5. Claude Code receives it as if it came from Anthropic's servers
```

**Features:**
- ✅ Streaming (SSE) and non-streaming responses
- ✅ Tool / function calling
- ✅ System prompts, multi-turn conversations
- ✅ Per-minute rate limiting with automatic queue (no 429 crashes)
- ✅ Request timeout with graceful 529 response (Claude Code retries automatically)
- ✅ Client disconnect handled — no server crash, no restart needed
- ✅ HTTP and HTTPS upstream (auto-detected from `LLM_BASE_URL`)
- ✅ Zero npm dependencies — pure Node.js built-ins only
- ✅ Works on Windows, Linux, and macOS

---

## File Reference

```
ClaudeRelay/
├── proxy.js              Main proxy server (cross-platform)
├── .env                  Your config (API key, model, URLs) — don't commit!
├── .env.example          Config template with docs and provider examples
├── package.json          npm start / npm test scripts
├── requirements.txt      System requirements (Node >= 18, no pip/npm packages)
│
├── linux-mac/
│   └── start-proxy.sh    Linux/macOS: run the proxy
│
├── windows/
│   └── start-proxy.bat   Windows: double-click to start
│
└── tests/
    ├── run-tests.sh      Linux/macOS: start proxy + run all tests + stop proxy
    ├── run-tests.bat     Windows:     start proxy + run all tests + stop proxy
    ├── test-proxy.js     Core suite   (31 assertions)
    └── limits-test.js    Boundary suite (40 assertions)
```
