// proxy.js — Anthropic-to-NVIDIA-NIM proxy (no npm dependencies, pure Node.js)
// Translates Claude Code's Anthropic API calls → NVIDIA NIM OpenAI-compatible API

'use strict';
const http  = require('http');
const https = require('https');
const { URL } = require('url');
const fs    = require('fs');
const path  = require('path');

// ---------- Config ----------
// Auto-load .env from script directory if NVIDIA_API_KEY not already in environment
const envFile = path.join(__dirname, '.env');
if (!process.env.NVIDIA_API_KEY && fs.existsSync(envFile)) {
  const lines = fs.readFileSync(envFile, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([^#\s=]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}

const PORT               = parseInt(process.env.PROXY_PORT            || '20128', 10);
const MODEL              = process.env.MODEL                           || 'nvidia/nemotron-3-super-120b-a12b';
const RATE_LIMIT_RPM     = parseInt(process.env.PROXY_RATE_LIMIT_RPM  || '38', 10);
const REQUEST_TIMEOUT_MS = parseInt(process.env.PROXY_TIMEOUT_SECONDS || '300', 10) * 1000;

// Upstream OpenAI-compatible API — defaults to NVIDIA NIM
const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://integrate.api.nvidia.com/v1';
const LLM_API_KEY  = process.env.LLM_API_KEY  || process.env.NVIDIA_API_KEY;

if (!LLM_API_KEY) {
  console.error('ERROR: LLM_API_KEY (or NVIDIA_API_KEY) is not set. Edit proxy/.env');
  process.exit(1);
}

// Parse URL once at startup so per-request code is clean
const _llmUrl      = new URL(LLM_BASE_URL.replace(/\/$/, '') + '/chat/completions');
const LLM_HOSTNAME = _llmUrl.hostname;
const LLM_PORT     = _llmUrl.port ? parseInt(_llmUrl.port, 10) : (_llmUrl.protocol === 'https:' ? 443 : 80);
const LLM_PATH     = _llmUrl.pathname;
const LLM_HTTPS    = _llmUrl.protocol === 'https:';

// ---------- Request conversion: Anthropic → OpenAI ----------
function toOpenAI(body) {
  const messages = [];

  // System prompt
  if (body.system) {
    const text = typeof body.system === 'string'
      ? body.system
      : body.system.map(b => b.text || '').join('');
    if (text) messages.push({ role: 'system', content: text });
  }

  for (const msg of (body.messages || [])) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        messages.push({ role: 'user', content: msg.content });
      } else {
        const texts = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            texts.push(block.text);
          } else if (block.type === 'tool_result') {
            // Flush any pending text first
            if (texts.length) { messages.push({ role: 'user', content: texts.join('\n') }); texts.length = 0; }
            const rc = typeof block.content === 'string'
              ? block.content
              : (block.content || []).map(b => b.text || '').join('');
            messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: rc });
          }
        }
        if (texts.length) messages.push({ role: 'user', content: texts.join('\n') });
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        messages.push({ role: 'assistant', content: msg.content });
      } else {
        const texts = [];
        const tool_calls = [];
        for (const block of msg.content) {
          if (block.type === 'text') texts.push(block.text);
          else if (block.type === 'tool_use') {
            tool_calls.push({ id: block.id, type: 'function',
              function: { name: block.name, arguments: JSON.stringify(block.input || {}) } });
          }
        }
        const m = { role: 'assistant', content: texts.join('\n') || null };
        if (tool_calls.length) m.tool_calls = tool_calls;
        messages.push(m);
      }
    }
  }

  const out = { model: MODEL, messages, max_tokens: body.max_tokens || 8192, stream: !!body.stream };
  if (body.temperature != null) out.temperature = body.temperature;

  // Tools
  if (body.tools && body.tools.length) {
    out.tools = body.tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: t.input_schema || {} },
    }));
    out.tool_choice = body.tool_choice === 'any' ? 'required' : 'auto';
  }
  return out;
}

// ---------- Response conversion: OpenAI → Anthropic (non-streaming) ----------
let _id = 0;
function uid() { return `msg_${Date.now()}_${_id++}`; }

function toAnthropic(oaResp, model) {
  const choice = oaResp.choices?.[0] || {};
  const msg    = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of (msg.tool_calls || [])) {
    let input = {};
    try { input = JSON.parse(tc.function.arguments || '{}'); } catch {}
    content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
  }
  return {
    id: uid(), type: 'message', role: 'assistant', model: model || 'nvidia',
    content,
    stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: oaResp.usage?.prompt_tokens || 0, output_tokens: oaResp.usage?.completion_tokens || 0 },
  };
}

// ---------- Streaming conversion: OpenAI SSE → Anthropic SSE ----------
function makeStreamConverter(res, model) {
  const state = { started: false, blockIdx: 0, textOpen: false, textIdx: -1, tools: {}, msgId: uid() };

  function write(event, data) {
    if (!res.writableEnded) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  }

  return function processChunk(chunk) {
    if (!state.started) {
      state.started = true;
      write('message_start', { type: 'message_start', message: {
        id: state.msgId, type: 'message', role: 'assistant', content: [],
        model: model || 'nvidia', stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 }
      }});
      write('ping', { type: 'ping' });
    }

    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};

    if (delta.content) {
      if (!state.textOpen) {
        state.textOpen = true;
        state.textIdx  = state.blockIdx++;
        write('content_block_start', { type: 'content_block_start', index: state.textIdx, content_block: { type: 'text', text: '' } });
      }
      write('content_block_delta', { type: 'content_block_delta', index: state.textIdx, delta: { type: 'text_delta', text: delta.content } });
    }

    for (const tc of (delta.tool_calls || [])) {
      const i = tc.index;
      if (!state.tools[i]) {
        if (state.textOpen) { write('content_block_stop', { type: 'content_block_stop', index: state.textIdx }); state.textOpen = false; }
        const blockIdx = state.blockIdx++;
        state.tools[i] = { blockIdx, id: tc.id || `call_${i}`, name: tc.function?.name || '' };
        write('content_block_start', { type: 'content_block_start', index: blockIdx,
          content_block: { type: 'tool_use', id: state.tools[i].id, name: state.tools[i].name, input: {} } });
      }
      if (tc.function?.name && !state.tools[i].name) state.tools[i].name = tc.function.name;
      if (tc.function?.arguments) {
        write('content_block_delta', { type: 'content_block_delta', index: state.tools[i].blockIdx,
          delta: { type: 'input_json_delta', partial_json: tc.function.arguments } });
      }
    }

    if (choice.finish_reason) {
      if (state.textOpen)       write('content_block_stop', { type: 'content_block_stop', index: state.textIdx });
      for (const t of Object.values(state.tools)) write('content_block_stop', { type: 'content_block_stop', index: t.blockIdx });
      const sr = choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn';
      write('message_delta', { type: 'message_delta', delta: { stop_reason: sr, stop_sequence: null }, usage: { output_tokens: chunk.usage?.completion_tokens || 1 } });
      write('message_stop', { type: 'message_stop' });
    }
  };
}

// ---------- Rate limiter: sliding 60s window, configurable RPM (default 38 = buffer under 40 limit) ----------
let rateWindow = []; // array of timestamps

async function waitForRateLimit() {
  const now = Date.now();
  const windowMs = 60 * 1000;
  rateWindow = rateWindow.filter(t => now - t < windowMs);
  if (rateWindow.length >= RATE_LIMIT_RPM) {
    const oldest = rateWindow[0];
    const waitMs = windowMs - (now - oldest) + 100;
    console.log(`  [RateLimit] At ${rateWindow.length} RPM — waiting ${Math.ceil(waitMs / 1000)}s before next request...`);
    await new Promise(r => setTimeout(r, waitMs));
    const now2 = Date.now();
    rateWindow = rateWindow.filter(t => now2 - t < windowMs);
  }
  rateWindow.push(Date.now());
}

// ---------- NVIDIA NIM HTTP call ----------
function callUpstream(oaBody, stream, clientRes) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(oaBody);
    const transport = LLM_HTTPS ? https : http;
    const opts = {
      hostname: LLM_HOSTNAME,
      port: LLM_PORT,
      path: LLM_PATH,
      method: 'POST',
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LLM_API_KEY}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = transport.request(opts, apiRes => {
      if (apiRes.statusCode === 429) {
        let e = ''; apiRes.on('data', d => e += d);
        apiRes.on('end', () => {
          console.warn(`  [429] Rate limited by upstream — you have hit the API rate limit.`);
          reject(new Error(`Upstream rate limit (429): too many requests. Wait a minute and retry.`));
        });
        return;
      }
      if (apiRes.statusCode >= 400) {
        let e = ''; apiRes.on('data', d => e += d);
        apiRes.on('end', () => reject(new Error(`HTTP ${apiRes.statusCode}: ${e.slice(0, 300)}`)));
        return;
      }

      if (stream) {
        // Guard: if client disconnected before we even start writing, bail out
        if (clientRes.writableEnded) { resolve(); return; }

        clientRes.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        const convert = makeStreamConverter(clientRes, oaBody.model);
        let buf = '';

        apiRes.on('data', chunk => {
          // If client disconnected mid-stream, abort the upstream request
          if (clientRes.writableEnded) { req.destroy(); return; }
          buf += chunk.toString();
          const lines = buf.split('\n'); buf = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const d = line.slice(6).trim();
            if (d === '[DONE]') continue;
            try { convert(JSON.parse(d)); } catch {}
          }
        });

        apiRes.on('end', () => {
          if (!clientRes.writableEnded) clientRes.end();
          resolve();
        });

        apiRes.on('error', err => {
          console.error('  [Stream] Upstream connection error:', err.message);
          if (!clientRes.writableEnded) clientRes.end();
          resolve(); // Don't propagate — client may have already disconnected
        });

      } else {
        let body = ''; apiRes.on('data', d => body += d);
        apiRes.on('end', () => {
          try {
            const ar = toAnthropic(JSON.parse(body), oaBody.model);
            if (!clientRes.writableEnded) {
              clientRes.writeHead(200, { 'Content-Type': 'application/json' });
              clientRes.end(JSON.stringify(ar));
            }
            resolve();
          } catch(e) { reject(e); }
        });
        apiRes.on('error', err => {
          console.error('  [NonStream] Upstream error:', err.message);
          reject(err);
        });
      }
    });

    // Socket/connection timeout — NVIDIA took too long or connection stalled
    req.on('timeout', () => {
      console.warn(`  [Timeout] NVIDIA did not respond within ${REQUEST_TIMEOUT_MS / 1000}s — aborting request.`);
      req.destroy(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
    });

    req.on('error', err => {
      if (err.message.includes('timed out') || err.code === 'ECONNRESET' || err.code === 'ECONNABORTED') {
        console.warn('  [Connection] Request aborted or timed out:', err.message);
        // Return a retryable Anthropic-style overload error so Claude Code retries gracefully
        if (!clientRes.headersSent && !clientRes.writableEnded) {
          clientRes.writeHead(529, { 'Content-Type': 'application/json' });
          clientRes.end(JSON.stringify({
            type: 'error',
            error: { type: 'overloaded_error', message: 'Proxy: upstream timed out, please retry.' }
          }));
        }
        resolve(); // handled — don't double-reject
      } else {
        reject(err);
      }
    });

    req.write(payload);
    req.end();
  });
}

// ---------- HTTP Server ----------
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', model: MODEL }));
    return;
  }

  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

  let raw = '';
  req.on('data', d => raw += d);
  req.on('end', async () => {
    try {
      const body   = JSON.parse(raw);
      const model  = body.model;
      const oaBody = toOpenAI(body);
      console.log(`→ ${req.method} ${req.url}  model=${model}  stream=${body.stream}`);

      await waitForRateLimit();
      await callUpstream(oaBody, !!body.stream, res);

    } catch(err) {
      console.error('Proxy error:', err.message);
      if (!res.headersSent && !res.writableEnded) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'proxy_error', message: err.message } }));
      }
    }
  });

  // Handle client disconnect mid-request (Claude Code closed the connection)
  req.on('close', () => {
    if (!res.writableEnded) {
      // Client gone — just note it; callNvidia guards writableEnded internally
      console.log('  [Client] Connection closed by client.');
    }
  });
});

// Increase server keep-alive to avoid stale connections
server.keepAliveTimeout = 10 * 1000;
server.headersTimeout   = 12 * 1000;

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n✓ Anthropic→OpenAI Proxy ready on http://localhost:${PORT}`);
  console.log(`  Upstream : ${LLM_BASE_URL}`);
  console.log(`  Model    : ${MODEL}`);
  console.log(`  Rate limit: ${RATE_LIMIT_RPM} RPM (auto-queued)`);
  console.log(`  Timeout  : ${REQUEST_TIMEOUT_MS / 1000}s per request\n`);
});
