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
const MODEL_MAX_TOKENS   = parseInt(process.env.MODEL_MAX_TOKENS      || '32768', 10);
const REQUEST_TIMEOUT_MS = parseInt(process.env.PROXY_TIMEOUT_SECONDS || '900', 10) * 1000;

// Upstream OpenAI-compatible API — defaults to NVIDIA NIM
const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://integrate.api.nvidia.com/v1';
const LLM_API_KEY  = process.env.LLM_API_KEY  || process.env.NVIDIA_API_KEY;

if (!LLM_API_KEY) {
  console.error('\x1b[31mERROR: LLM_API_KEY (or NVIDIA_API_KEY) is not set. Edit proxy/.env\x1b[0m');
  process.exit(1);
}

// Parse URL once at startup so per-request code is clean
const _llmUrl      = new URL(LLM_BASE_URL.replace(/\/$/, '') + '/chat/completions');
const LLM_HOSTNAME = _llmUrl.hostname;
const LLM_PORT     = _llmUrl.port ? parseInt(_llmUrl.port, 10) : (_llmUrl.protocol === 'https:' ? 443 : 80);
const LLM_PATH     = _llmUrl.pathname;
const LLM_HTTPS    = _llmUrl.protocol === 'https:';

// Vision API Config
const VISION_MODEL    = process.env.VISION_MODEL    || MODEL;
const VISION_BASE_URL = process.env.VISION_BASE_URL || LLM_BASE_URL;
const VISION_API_KEY  = process.env.VISION_API_KEY  || LLM_API_KEY;
const VISION_CHAINING = process.env.VISION_CHAINING !== 'false' && VISION_MODEL !== MODEL;

const _visUrl      = new URL(VISION_BASE_URL.replace(/\/$/, '') + '/chat/completions');
const VIS_HOSTNAME = _visUrl.hostname;
const VIS_PORT     = _visUrl.port ? parseInt(_visUrl.port, 10) : (_visUrl.protocol === 'https:' ? 443 : 80);
const VIS_PATH     = _visUrl.pathname;
const VIS_HTTPS    = _visUrl.protocol === 'https:';

// ---------- Request conversion: Anthropic → OpenAI ----------
function toOpenAI(body) {
  const messages = [];
  let hasImage = false;

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
        const blocks = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            blocks.push({ type: 'text', text: block.text });
          } else if (block.type === 'image') {
            hasImage = true;
            let mt = block.source?.media_type || 'image/jpeg';
            let dt = block.source?.data || '';
            blocks.push({ type: 'image_url', image_url: { url: `data:${mt};base64,${dt}` } });
          } else if (block.type === 'tool_result') {
            if (blocks.length) { messages.push({ role: 'user', content: [...blocks] }); blocks.length = 0; }
            const rc = typeof block.content === 'string'
              ? block.content
              : (block.content || []).map(b => b.text || '').join('');
            messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: rc });
          }
        }
        if (blocks.length) messages.push({ role: 'user', content: [...blocks] });
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

  let maxTokens = body.max_tokens || 8192;
  if (maxTokens > MODEL_MAX_TOKENS) maxTokens = MODEL_MAX_TOKENS;
  const out = { model: MODEL, messages, max_tokens: maxTokens, stream: !!body.stream };
  if (body.temperature != null) out.temperature = body.temperature;

  // Tools
  if (body.tools && body.tools.length) {
    out.tools = body.tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: t.input_schema || {} },
    }));
    out.tool_choice = body.tool_choice === 'any' ? 'required' : 'auto';
  }
  return { hasImage, oaBody: out };
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
    let name = tc.function.name;
    if (['bash', 'read', 'write', 'edit', 'grep', 'glob', 'replace', 'str_replace'].includes(name)) {
      name = name.charAt(0).toUpperCase() + name.slice(1);
    }
    content.push({ type: 'tool_use', id: tc.id, name, input });
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
  const state = {
    started: false,
    blockIdx: 0,
    textOpen: false,
    textIdx: -1,
    tools: {},
    msgId: uid(),
    finished: false,
    lastActivity: Date.now(),
    pingInterval: null
  };

  function write(event, data) {
    if (!res.writableEnded) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      state.lastActivity = Date.now();
    }
  }

  const convert = function processChunk(chunk) {
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
      if (tc.function?.name && !state.tools[i].name) {
        let name = tc.function.name;
        if (['bash', 'read', 'write', 'edit', 'grep', 'glob', 'replace', 'str_replace'].includes(name)) {
          name = name.charAt(0).toUpperCase() + name.slice(1);
        }
        state.tools[i].name = name;
      }
      if (tc.function?.arguments) {
        write('content_block_delta', { type: 'content_block_delta', index: state.tools[i].blockIdx,
          delta: { type: 'input_json_delta', partial_json: tc.function.arguments } });
      }
    }

    if (choice.finish_reason) {
      finishStream(choice.finish_reason, chunk.usage?.completion_tokens || 1);
    }
  };

  function finishStream(reason, tokens = 1) {
    if (state.finished) return;
    state.finished = true;
    // Clear ping interval
    if (state.pingInterval) {
      clearInterval(state.pingInterval);
      state.pingInterval = null;
    }
    if (state.textOpen) {
      write('content_block_stop', { type: 'content_block_stop', index: state.textIdx });
      state.textOpen = false;
    }
    for (const t of Object.values(state.tools)) {
      if (!t.stopped) {
        write('content_block_stop', { type: 'content_block_stop', index: t.blockIdx });
        t.stopped = true;
      }
    }
    const sr = reason === 'tool_calls' ? 'tool_use' : 'end_turn';
    write('message_delta', { type: 'message_delta', delta: { stop_reason: sr, stop_sequence: null }, usage: { output_tokens: tokens } });
    write('message_stop', { type: 'message_stop' });
  }

  // Set up ping interval to keep connection alive if no data for 15 seconds
  state.pingInterval = setInterval(() => {
    const now = Date.now();
    if (now - state.lastActivity > 15 * 1000) { // 15 seconds
      write('ping', { type: 'ping' });
      state.lastActivity = now;
    }
  }, 15 * 1000); // check every 15 seconds

  convert.finish = finishStream;
  return { convert, state };
}

// ---------- Upstream HTTP call ----------
function callUpstream(oaBody, stream, clientRes, target) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(oaBody);
    const transport = target.https ? https : http;
    const opts = {
      hostname: target.host,
      port: target.port,
      path: target.path,
      method: 'POST',
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${target.key}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    console.log(`\n\x1b[1m\x1b[34m[Upstream Request]\x1b[0m → \x1b[33mSending to ${target.host}...\x1b[0m`);
    const startTime = Date.now();

    const req = transport.request(opts, apiRes => {
      const latency = Date.now() - startTime;
      const statusColor = apiRes.statusCode >= 400 ? '\x1b[31m' : '\x1b[32m';
      console.log(`\x1b[1m\x1b[32m[Upstream Response]\x1b[0m ← ${statusColor}HTTP ${apiRes.statusCode}\x1b[0m \x1b[90m(${latency}ms)\x1b[0m`);

      if (apiRes.statusCode === 429) {
        let e = ''; apiRes.on('data', d => e += d);
        apiRes.on('end', () => {
          console.warn(`  \x1b[33m[429] Rate limited by upstream — you have hit the API rate limit.\x1b[0m`);
          reject(new Error(`Upstream rate limit (429): too many requests. Please retry later.`));
        });
        return;
      }
      if (apiRes.statusCode >= 400) {
        let e = ''; apiRes.on('data', d => e += d);
        apiRes.on('end', () => reject(new Error(`Upstream server error: ${apiRes.statusCode}`)));
        return;
      }

      if (stream) {
        // Guard: if client disconnected before we even start writing, bail out
        if (clientRes.writableEnded || clientRes.destroyed) { req.destroy(); resolve(); return; }

        clientRes.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        console.log(`  \x1b[90m├─\x1b[0m \x1b[32mStreaming started...\x1b[0m`);
        const { convert, state } = makeStreamConverter(clientRes, oaBody.model);
        let buf = '';
        let chunkCount = 0;

        apiRes.on('data', chunk => {
          chunkCount++;
          // If client disconnected mid-stream, abort the upstream request
          if (clientRes.writableEnded || clientRes.destroyed) { req.destroy(); return; }
          buf += chunk.toString();
          const lines = buf.split('\n'); buf = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const d = line.slice(6).trim();
            if (d === '[DONE]') {
              convert.finish('stop');
              continue;
            }
            try { convert(JSON.parse(d)); } catch {}
          }
        });

        apiRes.on('end', () => {
          convert.finish('stop');
          const duration = Date.now() - startTime;
          console.log(`  \x1b[90m└─\x1b[0m \x1b[32mStream completed successfully!\x1b[0m \x1b[90m(${chunkCount} chunks, ${duration}ms)\x1b[0m`);
          if (!clientRes.writableEnded && !clientRes.destroyed) clientRes.end();
          resolve();
        });

        apiRes.on('error', err => {
          console.error('  \x1b[31m[Stream] Upstream connection error:\x1b[0m', err.message);
          if (!clientRes.writableEnded && !clientRes.destroyed) clientRes.end();
          resolve(); // Don't propagate — client may have already disconnected
        });

      } else {
        console.log(`  \x1b[90m├─\x1b[0m \x1b[32mReceiving complete response...\x1b[0m`);
        let body = ''; apiRes.on('data', d => body += d);
        apiRes.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            const duration = Date.now() - startTime;
            const inTokens = parsed.usage?.prompt_tokens || 0;
            const outTokens = parsed.usage?.completion_tokens || 0;
            console.log(`  \x1b[90m└─\x1b[0m \x1b[32mResponse parsed successfully!\x1b[0m \x1b[90m(${inTokens} in | ${outTokens} out, ${duration}ms)\x1b[0m`);
            
            const ar = toAnthropic(parsed, oaBody.model);
            if (!clientRes.writableEnded && !clientRes.destroyed) {
              clientRes.writeHead(200, { 'Content-Type': 'application/json' });
              clientRes.end(JSON.stringify(ar));
            }
            resolve();
          } catch(e) { reject(e); }
        });
        apiRes.on('error', err => {
          console.error('  \x1b[31m[NonStream] Upstream error:\x1b[0m', err.message);
          reject(new Error('Upstream server error'));
        });
      }
    });

    // Socket/connection timeout — NVIDIA took too long or connection stalled
    req.on('timeout', () => {
      console.warn(`  \x1b[33m[Timeout] NVIDIA did not respond within ${REQUEST_TIMEOUT_MS / 1000}s — aborting request.\x1b[0m`);
      req.destroy(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
    });

    req.on('error', err => {
      if (err.message.includes('timed out') || err.code === 'ECONNRESET' || err.code === 'ECONNABORTED') {
        console.warn('  \x1b[33m[Connection] Request aborted or timed out:\x1b[0m', err.message);
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
        reject(new Error('Upstream connection error'));
      }
    });

    req.write(payload);
    req.end();

    // Attach to clientRes so we can abort it if the client drops the connection
    clientRes.upstreamReq = req;
  });
}

// ---------- Vision Chaining Helper ----------
function getVisionDescription(images, userPrompt, target) {
  return new Promise((resolve, reject) => {
    console.log(`\n\x1b[1m\x1b[35m[Vision Step]\x1b[0m → \x1b[33mAsking ${VISION_MODEL} to describe the image...\x1b[0m`);
    const vBody = {
      model: VISION_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: `Please describe these images in detail. Pay special attention to information relevant to this user query: ${userPrompt.slice(-500)}` },
          ...images.map(url => ({ type: 'image_url', image_url: { url } }))
        ]
      }],
      max_tokens: 4096,
      stream: false
    };
    const payload = JSON.stringify(vBody);
    const transport = target.https ? https : http;
    const req = transport.request({
      hostname: target.host, port: target.port, path: target.path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${target.key}` }
    }, res => {
      let body = ''; res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode >= 400) return reject(new Error(parsed.error?.message || JSON.stringify(parsed)));
          const desc = parsed.choices?.[0]?.message?.content || 'No description provided.';
          console.log(`  \x1b[90m└─\x1b[0m \x1b[1m\x1b[32m[Vision Step]\x1b[0m ← \x1b[32mDescription received!\x1b[0m`);
          resolve(desc);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ---------- HTTP Server ----------
const server = http.createServer(async (req, res) => {
  // Restrict CORS to localhost only for security
  const origin = req.headers.origin;
  if (origin && (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:3000'); // fallback
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', model: MODEL }));
    return;
  }

  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

  // Proxy authentication
  if (req.headers['x-api-key'] !== 'proxy') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'auth_error', message: 'Invalid API key' } }));
    return;
  }

  let raw = '';
  req.on('data', d => raw += d);
  req.on('end', async () => {
    try {
      const body   = JSON.parse(raw);
      const { hasImage, oaBody } = toOpenAI(body);
      
      const visTarget = { host: VIS_HOSTNAME, port: VIS_PORT, path: VIS_PATH, https: VIS_HTTPS, key: VISION_API_KEY };
      const baseTarget = { host: LLM_HOSTNAME, port: LLM_PORT, path: LLM_PATH, https: LLM_HTTPS, key: LLM_API_KEY };
      
      let target = hasImage && !VISION_CHAINING ? visTarget : baseTarget;
      
      if (hasImage && VISION_CHAINING) {
        let images = [];
        let userPrompt = "";
        
        for (let msg of oaBody.messages) {
          if (Array.isArray(msg.content)) {
            for (let i = 0; i < msg.content.length; i++) {
              let block = msg.content[i];
              if (block.type === 'text') userPrompt += block.text + " ";
              if (block.type === 'image_url') {
                images.push(block.image_url.url);
                msg.content[i] = { type: 'text', text: '[IMAGE_PLACEHOLDER]' };
              }
            }
          } else if (msg.role === 'user' && typeof msg.content === 'string') {
            userPrompt += msg.content + " ";
          }
        }
        
        const description = await getVisionDescription(images, userPrompt, visTarget);
        
        for (let msg of oaBody.messages) {
          if (Array.isArray(msg.content)) {
            for (let block of msg.content) {
              if (block.type === 'text' && block.text === '[IMAGE_PLACEHOLDER]') {
                block.text = `[Attached Image Description from Vision System: ${description}]\n\n`;
              }
            }
          }
        }
        oaBody.model = MODEL;
      } else if (hasImage && !VISION_CHAINING) {
        oaBody.model = VISION_MODEL;
      }
      
      const model  = oaBody.model;
      const numMsgs = body.messages ? body.messages.length : 0;
      const numTools = body.tools ? body.tools.length : 0;
      
      console.log(`\n\x1b[1m\x1b[36m[Incoming Request]\x1b[0m → \x1b[33m${req.method} ${req.url}\x1b[0m`);
      console.log(`  \x1b[90m├─\x1b[0m \x1b[37mModel:\x1b[0m ${model}`);
      console.log(`  \x1b[90m├─\x1b[0m \x1b[37mMessages:\x1b[0m ${numMsgs} | \x1b[37mTools:\x1b[0m ${numTools}`);
      console.log(`  \x1b[90m└─\x1b[0m \x1b[37mStream:\x1b[0m ${body.stream ? 'Yes' : 'No'}`);
      
      // If client disconnected before request started, skip upstream request
      if (res.destroyed) {
        console.log('  \x1b[33m[Abort] Client disconnected before request started. Skipping upstream.\x1b[0m');
        return;
      }

      await callUpstream(oaBody, !!body.stream, res, target);

    } catch(err) {
      console.error('\n\x1b[1m\x1b[31m[Proxy Error]\x1b[0m \x1b[31m' + err.message + '\x1b[0m');
      if (err.stack) console.error(`  \x1b[90m${err.stack.split('\n')[1].trim()}\x1b[0m`);
      if (!res.headersSent && !res.writableEnded) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'proxy_error', message: err.message } }));
      }
    }
  });

  // Handle client disconnect mid-request (Claude Code closed the connection)
  res.on('close', () => {
    if (!res.writableEnded) {
      console.log('  \x1b[36m[Client] Connection closed by client prematurely.\x1b[0m');
      if (res.upstreamReq && !res.upstreamReq.destroyed) {
        res.upstreamReq.destroy();
      }
    }
  });
});

// Increase server keep-alive to avoid stale connections
// Increased from 10s/12s to 5min/6min to accommodate long streaming sessions
server.keepAliveTimeout = 5 * 60 * 1000;
server.headersTimeout   = 6 * 60 * 1000;

server.listen(PORT, '127.0.0.1', () => {
  const orange = '\x1b[38;5;208m';  // Claude Terracotta/Orange
  const bold = '\x1b[1m';
  const dim = '\x1b[2;37m';
  const green = '\x1b[32m';
  const cyan = '\x1b[36m';
  const yellow = '\x1b[33m';
  const reset = '\x1b[0m';

  // 1. Column Dimensions
  const termWidth = process.stdout.columns || 100;
  const leftWidth = 26;                                         // Left column width
  const rightWidth = Math.min(termWidth - leftWidth - 10, 58);  // Right column width
  
  // Total Outer Width = left (26) + right (58) + borders/padding (7) = 91 chars
  const totalBoxWidth = leftWidth + rightWidth + 7;

  // 2. Visible Character Length Helper
  const getVisibleWidth = (str) => {
    let clean = str.replace(/\x1b\[[0-9;]*m/g, ''); // Strip ANSI colors
    clean = clean.replace(/\\\\/g, '\\');           // Handle escaped backslashes
    clean = clean.replace(/[\uFE00-\uFE0F]/g, '');  // Strip zero-width selectors
    return Array.from(clean).length;                // Accurate character count
  };

  // 3. Padding Helper
  const pad = (str, targetWidth, align = 'left') => {
    const vLen = getVisibleWidth(str);
    if (vLen >= targetWidth) return str;
    const diff = targetWidth - vLen;
    if (align === 'center') {
      const left = Math.floor(diff / 2);
      return ' '.repeat(left) + str + ' '.repeat(diff - left);
    }
    return str + ' '.repeat(diff);
  };

  // 4. Left Column Content (Featuring ASCII Bridge Logo)
  const leftCol = [
    `${bold}Welcome to ClaudeRelay${reset}`,
    ``,
    `${orange}      ▲       ▲      ${reset}`,
    `${orange}    /═|█|═════|█|═\\    ${reset}`,
    `${orange}  ══▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀══  ${reset}`,
    ``,
    `${green}✓ Proxy Server Active${reset}`,
    `${dim}http://localhost:${PORT}${reset}`,
    `${dim}Anthropic → OpenAI Proxy${reset}`
  ];

  // Truncate long URLs & Models cleanly if terminal is narrow
  const truncUrl = LLM_BASE_URL.length > rightWidth - 12 
    ? LLM_BASE_URL.slice(0, rightWidth - 15) + '...' 
    : LLM_BASE_URL;

  const truncModel = MODEL.length > rightWidth - 12 
    ? MODEL.slice(0, rightWidth - 15) + '...' 
    : MODEL;

  // 5. Right Column Content
  const rightCol = [
    `${bold}${orange}Upstream Configuration${reset}`,
    `${dim}Base URL :${reset} ${cyan}${truncUrl}${reset}`,
    `${dim}Model    :${reset} ${yellow}${truncModel}${reset}`,
    `─`.repeat(rightWidth),
    `${bold}${orange}Performance & Limits${reset}`,
    `${dim}Timeout    :${reset} ${REQUEST_TIMEOUT_MS / 1000}s per request`,
    ``,
    `${dim}✓ Zero-deps  •  ✓ SSE Stream  •  ✓ Tools${reset}`
  ];

  // 6. Synchronized Borders
  const headerTitle = ` ClaudeRelay v1.0.0 `;
  const topDashes = totalBoxWidth - 4 - getVisibleWidth(headerTitle);
  const topBorder = `${orange}╭──${bold}${headerTitle}${reset}${orange}${'─'.repeat(Math.max(0, topDashes))}╮${reset}`;
  const bottomBorder = `${orange}╰${'─'.repeat(totalBoxWidth - 2)}╯${reset}`;

  console.log('\n' + topBorder);

  // 7. Render Rows
  const maxRows = Math.max(leftCol.length, rightCol.length);
  for (let i = 0; i < maxRows; i++) {
    const lText = pad(leftCol[i] || '', leftWidth, 'center');
    const rText = pad(rightCol[i] || '', rightWidth, 'left');
    console.log(`${orange}│${reset} ${lText} ${orange}│${reset} ${rText} ${orange}│${reset}`);
  }

  console.log(bottomBorder + '\n');
});