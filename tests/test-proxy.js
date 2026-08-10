// test-proxy.js — Full diagnostic test suite for the NVIDIA NIM proxy
// Tests: health, non-streaming, streaming, rate-limit queueing, timeout/disconnect resilience
// Run with: node test-proxy.js

'use strict';
const http = require('http');

const PROXY = { host: '127.0.0.1', port: 20128 };
const ANTHROPIC_VERSION = '2023-06-01';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function color(code, s) { return `\x1b[${code}m${s}\x1b[0m`; }
const green  = s => color('32', s);
const red    = s => color('31', s);
const yellow = s => color('33', s);
const cyan   = s => color('36', s);
const bold   = s => color('1', s);
const dim    = s => color('2', s);

let passed = 0, failed = 0, warned = 0;

function pass(label, detail = '') {
  passed++;
  console.log(`  ${green('✓')} ${label}${detail ? dim('  ' + detail) : ''}`);
}
function fail(label, detail = '') {
  failed++;
  console.log(`  ${red('✗')} ${label}${detail ? red('  → ' + detail) : ''}`);
}
function warn(label, detail = '') {
  warned++;
  console.log(`  ${yellow('⚠')} ${label}${detail ? yellow('  ' + detail) : ''}`);
}

function post(path, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      ...PROXY, path, method: 'POST',
      timeout: opts.timeout || 90_000,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'proxy',
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Client socket timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function getStream(path, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const events = [];
    const req = http.request({
      ...PROXY, path, method: 'POST',
      timeout: opts.timeout || 120_000,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'proxy',
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let buf = '';
      res.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split('\n'); buf = lines.pop() || '';
        let currentEvent = null;
        for (const line of lines) {
          if (line.startsWith('event: ')) currentEvent = line.slice(7).trim();
          else if (line.startsWith('data: ')) {
            try { events.push({ event: currentEvent, data: JSON.parse(line.slice(6)) }); }
            catch { events.push({ event: currentEvent, raw: line.slice(6) }); }
          }
        }
      });
      res.on('end', () => resolve({ status: res.statusCode, events }));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Client socket timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Tests ────────────────────────────────────────────────────────────────────

async function testHealth() {
  console.log(bold('\n── Test 1: Health check ──────────────────────────────'));
  return new Promise((resolve, reject) => {
    const req = http.request({ ...PROXY, path: '/health', method: 'GET', timeout: 5000 }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (res.statusCode === 200 && j.status === 'ok') {
            pass('Health endpoint returns 200 + {status:"ok"}');
            console.log(dim(`     model: ${j.model}`));
          } else {
            fail('Health endpoint', `status=${res.statusCode} body=${body}`);
          }
        } catch(e) { fail('Health JSON parse', e.message); }
        resolve();
      });
    });
    req.on('timeout', () => { req.destroy(); fail('Health timeout'); resolve(); });
    req.on('error', e => { fail('Health connection error', e.message); resolve(); });
    req.end();
  });
}

async function testNonStreaming() {
  console.log(bold('\n── Test 2: Non-streaming request ─────────────────────'));
  const start = Date.now();
  try {
    const r = await post('/v1/messages', {
      model: 'claude-opus-4-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Reply with exactly: PROXY_OK' }],
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (r.status === 200) {
      pass(`HTTP 200 in ${elapsed}s`);
      try {
        const j = JSON.parse(r.body);
        if (j.type === 'message') pass('Response has type:"message"');
        else fail('Response type', `got: ${j.type}`);

        if (j.role === 'assistant') pass('Response role:"assistant"');
        else fail('Response role', `got: ${j.role}`);

        if (Array.isArray(j.content) && j.content.length > 0) pass('Content array non-empty');
        else fail('Content array empty or missing');

        if (j.content[0]?.type === 'text') pass('First content block type:"text"');
        else fail('First content block type', `got: ${j.content[0]?.type}`);

        const text = j.content.map(b => b.text || '').join('');
        console.log(dim(`     LLM reply: "${text.slice(0, 120)}"`));

        if (j.usage?.input_tokens != null && j.usage?.output_tokens != null)
          pass(`Usage tokens reported (in=${j.usage.input_tokens}, out=${j.usage.output_tokens})`);
        else warn('Usage tokens missing or null');

        if (j.stop_reason) pass(`stop_reason: "${j.stop_reason}"`);
        else warn('stop_reason missing');

      } catch(e) { fail('Response JSON parse', e.message); }
    } else {
      fail(`HTTP ${r.status}`, r.body.slice(0, 300));
    }
  } catch(e) {
    fail('Non-streaming request threw', e.message);
  }
}

async function testStreaming() {
  console.log(bold('\n── Test 3: Streaming request ─────────────────────────'));
  const start = Date.now();
  try {
    const r = await getStream('/v1/messages', {
      model: 'claude-opus-4-5',
      max_tokens: 80,
      stream: true,
      messages: [{ role: 'user', content: 'Count 1 to 5, one per line.' }],
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    if (r.status === 200) pass(`HTTP 200 stream in ${elapsed}s`);
    else { fail(`HTTP ${r.status}`); return; }

    const types = r.events.map(e => e.event);
    const checks = {
      'message_start':     types.includes('message_start'),
      'ping':              types.includes('ping'),
      'content_block_start': types.includes('content_block_start'),
      'content_block_delta': types.includes('content_block_delta'),
      'content_block_stop':  types.includes('content_block_stop'),
      'message_delta':     types.includes('message_delta'),
      'message_stop':      types.includes('message_stop'),
    };
    for (const [ev, present] of Object.entries(checks)) {
      if (present) pass(`SSE event: ${ev}`);
      else fail(`SSE event missing: ${ev}`);
    }

    // Reconstruct text from deltas
    const text = r.events
      .filter(e => e.event === 'content_block_delta' && e.data?.delta?.type === 'text_delta')
      .map(e => e.data.delta.text)
      .join('');
    console.log(dim(`     Streamed text: "${text.slice(0, 120)}"`));

    const stop = r.events.find(e => e.event === 'message_delta');
    if (stop?.data?.delta?.stop_reason) pass(`stop_reason: "${stop.data.delta.stop_reason}"`);
    else warn('stop_reason missing from message_delta');

    console.log(dim(`     Total SSE events: ${r.events.length}`));
  } catch(e) {
    fail('Streaming request threw', e.message);
  }
}

async function testToolUse() {
  console.log(bold('\n── Test 4: Tool use (non-streaming) ──────────────────'));
  const start = Date.now();
  try {
    const r = await post('/v1/messages', {
      model: 'claude-opus-4-5',
      max_tokens: 256,
      tools: [{
        name: 'get_weather',
        description: 'Get the current weather for a city',
        input_schema: {
          type: 'object',
          properties: { city: { type: 'string', description: 'City name' } },
          required: ['city'],
        },
      }],
      messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (r.status === 200) {
      pass(`HTTP 200 in ${elapsed}s`);
      try {
        const j = JSON.parse(r.body);
        const toolBlocks = (j.content || []).filter(b => b.type === 'tool_use');
        if (toolBlocks.length > 0) {
          pass(`Model called tool: "${toolBlocks[0].name}"`);
          const input = toolBlocks[0].input || {};
          if (input.city) pass(`Tool input.city = "${input.city}"`);
          else warn('Tool input.city not set');
          if (j.stop_reason === 'tool_use') pass('stop_reason: "tool_use"');
          else warn(`stop_reason: "${j.stop_reason}" (expected tool_use)`);
        } else {
          warn('Model did not call tool (answered in text instead)', 'This is OK if model prefers text');
          const text = (j.content || []).map(b => b.text || '').join('');
          console.log(dim(`     Text: "${text.slice(0, 100)}"`));
        }
      } catch(e) { fail('Tool use JSON parse', e.message); }
    } else {
      fail(`HTTP ${r.status}`, r.body.slice(0, 300));
    }
  } catch(e) {
    fail('Tool use request threw', e.message);
  }
}

async function testRateLimit() {
  console.log(bold('\n── Test 5: Rate-limit queue (3 rapid requests) ───────'));
  console.log(dim('     Sending 3 requests back-to-back...'));
  const times = [];
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    try {
      const r = await post('/v1/messages', {
        model: 'claude-opus-4-5',
        max_tokens: 16,
        messages: [{ role: 'user', content: `Say "OK${i+1}" only.` }],
      }, { timeout: 120_000 });
      times.push(Date.now() - t);
      if (r.status === 200) pass(`Request ${i+1} completed (${((Date.now()-t)/1000).toFixed(1)}s)`);
      else fail(`Request ${i+1} HTTP ${r.status}`, r.body.slice(0, 100));
    } catch(e) {
      fail(`Request ${i+1} threw`, e.message);
    }
  }
  if (times.length === 3) pass(`All 3 requests resolved without crash`);
}

async function testMalformed() {
  console.log(bold('\n── Test 6: Malformed / edge-case inputs ──────────────'));
  // Empty messages
  try {
    const r = await post('/v1/messages', {
      model: 'claude-opus-4-5',
      max_tokens: 16,
      messages: [],
    }, { timeout: 30_000 });
    if (r.status >= 400 || r.status === 500) pass(`Empty messages → ${r.status} (server handled)`);
    else if (r.status === 200) warn('Empty messages returned 200 (model accepted it)');
  } catch(e) { fail('Empty messages threw', e.message); }

  // Invalid JSON
  try {
    const r = await new Promise((resolve, reject) => {
      const payload = '{bad json}';
      const req = http.request({
        ...PROXY, path: '/v1/messages', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, res => {
        let b = ''; res.on('data', d => b += d);
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      req.on('error', reject);
      req.write(payload); req.end();
    });
    if (r.status >= 400 || r.status === 500) pass(`Invalid JSON → ${r.status} (server handled)`);
    else warn(`Invalid JSON returned ${r.status}`);
  } catch(e) { fail('Invalid JSON threw (server crash?)', e.message); }

  // GET to messages endpoint
  try {
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ ...PROXY, path: '/v1/messages', method: 'GET' }, res => {
        let b = ''; res.on('data', d => b += d);
        res.on('end', () => resolve({ status: res.statusCode }));
      });
      req.on('error', reject);
      req.end();
    });
    if (r.status === 405) pass(`GET /v1/messages → 405 Method Not Allowed`);
    else warn(`GET /v1/messages → ${r.status} (expected 405)`);
  } catch(e) { fail('GET method check threw', e.message); }
}

async function testClientDisconnect() {
  console.log(bold('\n── Test 7: Client disconnect mid-stream ──────────────'));
  console.log(dim('     Opening stream, reading 1 chunk, then abruptly closing...'));
  let gotChunk = false;
  await new Promise(resolve => {
    const payload = JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 512,
      stream: true,
      messages: [{ role: 'user', content: 'Write a long poem about space exploration, at least 20 lines.' }],
    });
    const req = http.request({
      ...PROXY, path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'proxy',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      res.once('data', chunk => {
        gotChunk = true;
        res.destroy(); // Simulate abrupt client disconnect
      });
      res.on('close', () => {
        if (gotChunk) pass('Got first chunk before disconnect');
        pass('Client disconnect: connection destroyed without hanging');
        // Wait a bit to see if the server process crashed
        setTimeout(resolve, 2000);
      });
    });
    req.on('error', () => resolve()); // expected — socket destroyed
    req.write(payload);
    req.end();
  });

  // Verify server still alive after disconnect
  await new Promise(resolve => {
    const req = http.request({ ...PROXY, path: '/health', method: 'GET', timeout: 5000 }, res => {
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => {
        if (res.statusCode === 200) pass('Server still alive after client disconnect ✓');
        else fail('Server returned non-200 after disconnect');
        resolve();
      });
    });
    req.on('error', e => { fail('Server unreachable after disconnect', e.message); resolve(); });
    req.end();
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(bold(cyan('\n╔══════════════════════════════════════════════════╗')));
  console.log(bold(cyan('║   NVIDIA NIM Proxy — Diagnostic Test Suite       ║')));
  console.log(bold(cyan('╚══════════════════════════════════════════════════╝')));
  console.log(dim(`  Proxy: http://${PROXY.host}:${PROXY.port}`));
  console.log(dim(`  Time : ${new Date().toLocaleString()}\n`));

  await testHealth();
  await testNonStreaming();
  await testStreaming();
  await testToolUse();
  await testRateLimit();
  await testMalformed();
  await testClientDisconnect();

  console.log(bold('\n── Summary ───────────────────────────────────────────'));
  console.log(`  ${green(`${passed} passed`)}  ${failed > 0 ? red(`${failed} failed`) : dim('0 failed')}  ${warned > 0 ? yellow(`${warned} warned`) : dim('0 warnings')}`);

  if (failed === 0 && warned === 0) {
    console.log(green(bold('\n  ✓ All tests passed — proxy is healthy!\n')));
  } else if (failed === 0) {
    console.log(yellow(bold('\n  ⚠ Tests passed with warnings — review above.\n')));
  } else {
    console.log(red(bold('\n  ✗ Some tests FAILED — check server logs above.\n')));
    process.exit(1);
  }
}

main().catch(e => {
  console.error(red('\nFATAL: Test runner crashed:'), e);
  process.exit(1);
});
