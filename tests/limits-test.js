// limits-test.js — Exhaustive boundary / limits test for the Anthropic→OpenAI proxy
// Tests things the existing suite does NOT cover.
// Run: node limits-test.js

'use strict';
const http  = require('http');
const https = require('https');

const PROXY = { host: '127.0.0.1', port: 20128 };

// ─── Colour helpers ──────────────────────────────────────────────────────────
function color(code, s) { return `\x1b[${code}m${s}\x1b[0m`; }
const green  = s => color('32', s);
const red    = s => color('31', s);
const yellow = s => color('33', s);
const cyan   = s => color('36', s);
const bold   = s => color('1',  s);
const dim    = s => color('2',  s);
const magenta= s => color('35', s);

let passed = 0, failed = 0, warned = 0;
function pass(label, detail='') { passed++; console.log(`  ${green('✓')} ${label}${detail?dim('  '+detail):''}`); }
function fail(label, detail='') { failed++; console.log(`  ${red('✗')} ${label}${detail?red('  → '+detail):''}`); }
function warn(label, detail='') { warned++; console.log(`  ${yellow('⚠')} ${label}${detail?yellow('  '+detail):''}`); }

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function post(path, body, { timeout=90_000, rawBody=null, extraHeaders={} }={}) {
  return new Promise((resolve, reject) => {
    const payload = rawBody ?? JSON.stringify(body);
    const req = http.request({
      ...PROXY, path, method: 'POST',
      timeout,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'proxy',
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload),
        ...extraHeaders,
      },
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('socket timeout')); });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

function getStream(body, { timeout=120_000 }={}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const events = []; const rawLines = [];
    const req = http.request({
      ...PROXY, path: '/v1/messages', method: 'POST',
      timeout,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'proxy',
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let buf = '';
      res.on('data', chunk => {
        buf += chunk.toString();
        const lines = buf.split('\n'); buf = lines.pop() || '';
        let cur = null;
        for (const line of lines) {
          rawLines.push(line);
          if (line.startsWith('event: ')) cur = line.slice(7).trim();
          else if (line.startsWith('data: ')) {
            try { events.push({ event: cur, data: JSON.parse(line.slice(6)) }); }
            catch { events.push({ event: cur, raw: line.slice(6) }); }
          }
        }
      });
      res.on('end', () => resolve({ status: res.statusCode, events, rawLines }));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('socket timeout')); });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function send(method, path, body='', headers={}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...PROXY, path, method,
      headers: { 'Content-Length': Buffer.byteLength(body), ...headers },
    }, res => {
      let b=''; res.on('data', d => b+=d);
      res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST SECTIONS
// ─────────────────────────────────────────────────────────────────────────────

// ── 1. HTTP protocol surface ──────────────────────────────────────────────────
async function testHttpSurface() {
  console.log(bold('\n── 1. HTTP protocol surface ────────────────────────────'));

  // CORS preflight
  const cors = await send('OPTIONS', '/v1/messages', '', { Origin: 'https://example.com' });
  if (cors.status === 200) pass('OPTIONS preflight → 200');
  else fail('OPTIONS preflight', `${cors.status}`);

  const allowOrigin = cors.headers['access-control-allow-origin'];
  if (allowOrigin === '*') pass('CORS Access-Control-Allow-Origin: *');
  else fail('CORS header missing or wrong', allowOrigin);

  // PUT method
  const put = await send('PUT', '/v1/messages');
  if (put.status === 405) pass('PUT /v1/messages → 405');
  else warn('PUT /v1/messages', `expected 405, got ${put.status}`);

  // DELETE method
  const del = await send('DELETE', '/v1/messages');
  if (del.status === 405) pass('DELETE /v1/messages → 405');
  else warn('DELETE /v1/messages', `expected 405, got ${del.status}`);

  // Root path alias for /health
  const root = await send('GET', '/');
  if (root.status === 200) pass('GET / → 200 (alias for health)');
  else fail('GET /', `${root.status}`);

  // Unknown path
  const unknown = await send('GET', '/v1/unknown-path');
  if (unknown.status === 405) pass('GET /v1/unknown → 405');
  else warn('Unknown path', `got ${unknown.status}`);

  // Unknown POST path
  const unknownPost = await send('POST', '/v1/completions', '{}', {'Content-Type':'application/json'});
  // The proxy doesn't route /v1/completions — expect 500 (JSON.parse of empty body) or 405
  if (unknownPost.status >= 400) pass(`POST /v1/completions (unhandled route) → ${unknownPost.status}`);
  else warn('POST /v1/completions', `got ${unknownPost.status}`);
}

// ── 2. Request body edge cases ────────────────────────────────────────────────
async function testRequestEdgeCases() {
  console.log(bold('\n── 2. Request body edge cases ──────────────────────────'));

  // Completely empty body
  const empty = await send('POST', '/v1/messages', '', {'Content-Type':'application/json','Content-Length':'0'});
  if (empty.status >= 400) pass(`Empty body → ${empty.status} (handled)`);
  else warn('Empty body', `got ${empty.status}`);

  // Valid JSON but not an object
  const arr = await post('/v1/messages', null, { rawBody: '[1,2,3]' });
  if (arr.status >= 400) pass(`JSON array body → ${arr.status} (handled)`);
  else warn('JSON array body', `got ${arr.status}`);

  // null body
  const nullBody = await post('/v1/messages', null, { rawBody: 'null' });
  if (nullBody.status >= 400) pass(`null body → ${nullBody.status} (handled)`);
  else warn('null body', `got ${nullBody.status}`);

  // Missing max_tokens (required by Anthropic spec)
  try {
    const r = await post('/v1/messages', {
      model: 'test', messages: [{ role: 'user', content: 'hi' }],
      // no max_tokens — proxy defaults to 8192
    }, { timeout: 30_000 });
    if (r.status === 200) pass('Missing max_tokens → 200 (proxy defaults to 8192)');
    else warn('Missing max_tokens', `status ${r.status}`);
  } catch(e) { warn('Missing max_tokens threw', e.message); }

  // Huge max_tokens (beyond typical model limits)
  try {
    const r = await post('/v1/messages', {
      model: 'test', max_tokens: 999999,
      messages: [{ role: 'user', content: 'Say hi.' }],
    }, { timeout: 30_000 });
    if (r.status === 200) pass('max_tokens=999999 → 200 (forwarded as-is)');
    else if (r.status >= 400) pass(`max_tokens=999999 → ${r.status} (upstream rejected)`);
  } catch(e) { warn('max_tokens=999999 threw', e.message); }

  // temperature boundary: 0
  try {
    const r = await post('/v1/messages', {
      model: 'test', max_tokens: 16, temperature: 0,
      messages: [{ role: 'user', content: 'Say COLD.' }],
    }, { timeout: 30_000 });
    if (r.status === 200) pass('temperature=0 → 200');
    else warn('temperature=0', `status ${r.status}`);
  } catch(e) { warn('temperature=0 threw', e.message); }

  // temperature boundary: 2 (max per OpenAI spec)
  try {
    const r = await post('/v1/messages', {
      model: 'test', max_tokens: 16, temperature: 2,
      messages: [{ role: 'user', content: 'Say HOT.' }],
    }, { timeout: 30_000 });
    if (r.status === 200) pass('temperature=2 → 200');
    else warn('temperature=2', `status ${r.status}`);
  } catch(e) { warn('temperature=2 threw', e.message); }
}

// ── 3. Message format edge cases ──────────────────────────────────────────────
async function testMessageFormats() {
  console.log(bold('\n── 3. Message format edge cases ────────────────────────'));

  // Multi-turn conversation
  try {
    const r = await post('/v1/messages', {
      model: 'test', max_tokens: 32,
      messages: [
        { role: 'user',      content: 'My name is Alice.' },
        { role: 'assistant', content: 'Hello Alice!' },
        { role: 'user',      content: 'What is my name?' },
      ],
    }, { timeout: 40_000 });
    if (r.status === 200) {
      const j = JSON.parse(r.body);
      const text = (j.content||[]).map(b=>b.text||'').join('').toLowerCase();
      if (text.includes('alice')) pass('Multi-turn: model recalled name "Alice"');
      else pass('Multi-turn conversation → 200 (name not confirmed in reply)');
    } else warn('Multi-turn', `status ${r.status}`);
  } catch(e) { warn('Multi-turn threw', e.message); }

  // System prompt as string
  try {
    const r = await post('/v1/messages', {
      model: 'test', max_tokens: 24,
      system: 'Always reply with exactly: SYSTEM_PROMPT_OK',
      messages: [{ role: 'user', content: 'Hello?' }],
    }, { timeout: 30_000 });
    if (r.status === 200) pass('System prompt (string) → 200');
    else warn('System prompt string', `status ${r.status}`);
  } catch(e) { warn('System prompt threw', e.message); }

  // System prompt as array of blocks (Anthropic format)
  try {
    const r = await post('/v1/messages', {
      model: 'test', max_tokens: 24,
      system: [{ type: 'text', text: 'Always reply: BLOCK_SYSTEM_OK' }],
      messages: [{ role: 'user', content: 'Hello?' }],
    }, { timeout: 30_000 });
    if (r.status === 200) pass('System prompt (block array) → 200');
    else warn('System prompt block array', `status ${r.status}`);
  } catch(e) { warn('System prompt block array threw', e.message); }

  // User message as array of text blocks
  try {
    const r = await post('/v1/messages', {
      model: 'test', max_tokens: 24,
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'Say ' },
        { type: 'text', text: 'BLOCK_OK' },
      ]}],
    }, { timeout: 30_000 });
    if (r.status === 200) pass('User message as text block array → 200');
    else warn('User block array', `status ${r.status}`);
  } catch(e) { warn('User block array threw', e.message); }

  // Unicode / emoji content
  try {
    const r = await post('/v1/messages', {
      model: 'test', max_tokens: 32,
      messages: [{ role: 'user', content: '日本語テスト 🎌 مرحبا ñoño' }],
    }, { timeout: 30_000 });
    if (r.status === 200) pass('Unicode + emoji content → 200');
    else warn('Unicode content', `status ${r.status}`);
  } catch(e) { warn('Unicode threw', e.message); }

  // Very long single message (~4KB)
  try {
    const bigMsg = 'A'.repeat(4096);
    const r = await post('/v1/messages', {
      model: 'test', max_tokens: 16,
      messages: [{ role: 'user', content: `Here is text: ${bigMsg}. Reply OK.` }],
    }, { timeout: 40_000 });
    if (r.status === 200) pass('4 KB message → 200');
    else warn('4 KB message', `status ${r.status}`);
  } catch(e) { warn('4 KB message threw', e.message); }
}

// ── 4. Tool call edge cases ───────────────────────────────────────────────────
async function testToolEdgeCases() {
  console.log(bold('\n── 4. Tool call edge cases ─────────────────────────────'));

  // Multiple tools defined
  try {
    const r = await post('/v1/messages', {
      model: 'test', max_tokens: 128,
      tools: [
        { name: 'add',      description: 'Add two numbers', input_schema: { type:'object', properties:{ a:{type:'number'}, b:{type:'number'} }, required:['a','b'] } },
        { name: 'subtract', description: 'Subtract b from a', input_schema: { type:'object', properties:{ a:{type:'number'}, b:{type:'number'} }, required:['a','b'] } },
        { name: 'multiply', description: 'Multiply two numbers', input_schema: { type:'object', properties:{ a:{type:'number'}, b:{type:'number'} }, required:['a','b'] } },
      ],
      messages: [{ role: 'user', content: 'What is 7 plus 3?' }],
    }, { timeout: 40_000 });
    if (r.status === 200) {
      const j = JSON.parse(r.body);
      const tools = (j.content||[]).filter(b=>b.type==='tool_use');
      if (tools.length > 0) pass(`Multiple tools: model chose "${tools[0].name}"`);
      else pass('Multiple tools → 200 (model answered in text)');
    } else warn('Multiple tools', `status ${r.status}`);
  } catch(e) { warn('Multiple tools threw', e.message); }

  // tool_choice: "any" (maps to "required" in OpenAI)
  try {
    const r = await post('/v1/messages', {
      model: 'test', max_tokens: 64,
      tool_choice: 'any',
      tools: [{ name: 'ping', description: 'Ping tool', input_schema: { type:'object', properties:{} } }],
      messages: [{ role: 'user', content: 'Just call ping.' }],
    }, { timeout: 40_000 });
    if (r.status === 200) pass('tool_choice:"any" → 200 (mapped to required)');
    else warn('tool_choice:any', `status ${r.status}`);
  } catch(e) { warn('tool_choice:any threw', e.message); }

  // Tool result round-trip (user provides tool result)
  try {
    const r = await post('/v1/messages', {
      model: 'test', max_tokens: 64,
      tools: [{ name: 'get_weather', description: 'Get weather', input_schema: { type:'object', properties:{ city:{type:'string'} }, required:['city'] } }],
      messages: [
        { role: 'user',      content: 'Weather in Paris?' },
        { role: 'assistant', content: [{ type:'tool_use', id:'call_1', name:'get_weather', input:{ city:'Paris' } }] },
        { role: 'user',      content: [{ type:'tool_result', tool_use_id:'call_1', content:'Sunny, 22°C' }] },
      ],
    }, { timeout: 40_000 });
    if (r.status === 200) pass('Tool result round-trip → 200');
    else warn('Tool result round-trip', `status ${r.status}`);
  } catch(e) { warn('Tool result round-trip threw', e.message); }
}

// ── 5. Streaming edge cases ───────────────────────────────────────────────────
async function testStreamingEdgeCases() {
  console.log(bold('\n── 5. Streaming edge cases ─────────────────────────────'));

  // Streaming with system prompt
  try {
    const r = await getStream({
      model: 'test', max_tokens: 32, stream: true,
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Say STREAM_SYS_OK' }],
    }, { timeout: 40_000 });
    if (r.status === 200) {
      const text = r.events.filter(e=>e.event==='content_block_delta'&&e.data?.delta?.type==='text_delta').map(e=>e.data.delta.text).join('');
      pass(`Stream + system prompt → 200  reply: "${text.slice(0,60)}"`);
    } else warn('Stream + system prompt', `status ${r.status}`);
  } catch(e) { warn('Stream + system threw', e.message); }

  // SSE format correctness: all lines should start with "event: " or "data: " or be blank
  try {
    const r = await getStream({
      model: 'test', max_tokens: 32, stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }, { timeout: 40_000 });
    const malformed = r.rawLines.filter(l => l !== '' && !l.startsWith('event: ') && !l.startsWith('data: '));
    if (malformed.length === 0) pass('SSE format: all lines correctly prefixed');
    else fail('SSE malformed lines detected', malformed.slice(0,3).join(' | '));
  } catch(e) { warn('SSE format check threw', e.message); }

  // Streaming stops correctly (message_stop event present)
  try {
    const r = await getStream({
      model: 'test', max_tokens: 16, stream: true,
      messages: [{ role: 'user', content: 'One word: yes or no?' }],
    }, { timeout: 40_000 });
    const hasStop = r.events.some(e => e.event === 'message_stop');
    if (hasStop) pass('Stream terminates with message_stop event');
    else fail('Stream missing message_stop');
  } catch(e) { warn('Stream termination check threw', e.message); }
}

// ── 6. Concurrency ────────────────────────────────────────────────────────────
async function testConcurrency() {
  console.log(bold('\n── 6. Concurrency (5 parallel requests) ────────────────'));
  console.log(dim('     Firing 5 requests simultaneously (rate limiter will queue them)...'));
  const start = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) =>
      post('/v1/messages', {
        model: 'test', max_tokens: 16,
        messages: [{ role: 'user', content: `Say "P${i+1}" only.` }],
      }, { timeout: 180_000 })
    )
  );
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const ok      = results.filter(r => r.status === 'fulfilled' && r.value.status === 200).length;
  const errored = results.filter(r => r.status === 'rejected').length;
  const nonOk   = results.filter(r => r.status === 'fulfilled' && r.value.status !== 200).length;

  if (ok === 5)           pass(`All 5 concurrent requests completed OK in ${elapsed}s`);
  else if (ok > 0)        warn(`${ok}/5 succeeded in ${elapsed}s (${errored} errors, ${nonOk} non-200)`);
  else                    fail(`All 5 failed (${errored} threw, ${nonOk} non-200)`);

  console.log(dim(`     Rate limit queued extra requests — total wall time: ${elapsed}s`));
}

// ── 7. Response shape compliance ──────────────────────────────────────────────
async function testResponseShape() {
  console.log(bold('\n── 7. Response shape compliance (Anthropic spec) ───────'));
  try {
    const r = await post('/v1/messages', {
      model: 'anything', max_tokens: 32,
      messages: [{ role: 'user', content: 'hi' }],
    }, { timeout: 30_000 });

    if (r.status !== 200) { warn('Non-200 — cannot check shape', `${r.status}`); return; }
    const j = JSON.parse(r.body);

    const checks = {
      'id field present':          typeof j.id === 'string' && j.id.length > 0,
      'type === "message"':        j.type === 'message',
      'role === "assistant"':      j.role === 'assistant',
      'content is array':          Array.isArray(j.content),
      'stop_reason present':       j.stop_reason != null,
      'stop_sequence present':     'stop_sequence' in j,
      'usage.input_tokens number': typeof j.usage?.input_tokens === 'number',
      'usage.output_tokens number':typeof j.usage?.output_tokens === 'number',
      'model field present':       typeof j.model === 'string',
    };

    for (const [label, ok] of Object.entries(checks)) {
      if (ok) pass(label);
      else    fail(label, JSON.stringify(j[label.split(' ')[0]]));
    }
  } catch(e) { fail('Response shape check threw', e.message); }
}

// ── 8. Known limitations ──────────────────────────────────────────────────────
async function testKnownLimitations() {
  console.log(bold('\n── 8. Known proxy limitations (documented) ─────────────'));

  // Image / vision content block
  console.log(dim('  [8a] Vision / image content blocks'));
  try {
    const r = await post('/v1/messages', {
      model: 'test', max_tokens: 32,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
        { type: 'text', text: 'What is in this image?' },
      ]}],
    }, { timeout: 30_000 });
    // Outcome is model-dependent: some upstreams accept images, others reject them.
    // Either way the proxy correctly passes through and doesn't crash — always a warn.
    if (r.status === 200) warn(`Image block → 200 (upstream accepted — model supports vision)`);
    else warn(`Image block → ${r.status} (upstream rejected — model does not support vision; proxy passed it through cleanly)`);
  } catch(e) { warn('Image block threw', e.message); }

  // Streaming tool use
  console.log(dim('  [8b] Streaming + tool use'));
  try {
    const r = await getStream({
      model: 'test', max_tokens: 128, stream: true,
      tools: [{ name: 'calc', description: 'Calculator', input_schema: { type:'object', properties:{ expr:{type:'string'} }, required:['expr'] } }],
      messages: [{ role: 'user', content: 'Calculate 2 + 2 using the calc tool.' }],
    }, { timeout: 40_000 });
    if (r.status === 200) {
      const hasToolStart = r.events.some(e => e.event === 'content_block_start' && e.data?.content_block?.type === 'tool_use');
      if (hasToolStart) pass('Streaming tool use → tool_use block emitted ✓');
      else warn('Streaming tool use → model answered in text (no tool_use block in stream)');
    } else warn('Streaming tool use', `status ${r.status}`);
  } catch(e) { warn('Streaming tool use threw', e.message); }

  // max_tokens=1 (minimum possible output)
  console.log(dim('  [8c] max_tokens=1'));
  try {
    const r = await post('/v1/messages', {
      model: 'test', max_tokens: 1,
      messages: [{ role: 'user', content: 'Say something long.' }],
    }, { timeout: 30_000 });
    if (r.status === 200) {
      const j = JSON.parse(r.body);
      const text = (j.content||[]).map(b=>b.text||'').join('');
      pass(`max_tokens=1 → 200, got "${text.slice(0,20)}" (stop_reason: ${j.stop_reason})`);
    } else warn('max_tokens=1', `status ${r.status}`);
  } catch(e) { warn('max_tokens=1 threw', e.message); }

  // Anthropic beta header (should be ignored by proxy)
  console.log(dim('  [8d] anthropic-beta header passthrough'));
  try {
    const r = await post('/v1/messages', {
      model: 'test', max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
    }, { extraHeaders: { 'anthropic-beta': 'max-tokens-3-5-sonnet-2024-07-15' } });
    if (r.status === 200) pass('anthropic-beta header → proxy ignores it gracefully, 200');
    else warn('anthropic-beta header', `status ${r.status}`);
  } catch(e) { warn('anthropic-beta threw', e.message); }

  // Server survives after all these tests
  console.log(dim('  [8e] Server health after all tests'));
  try {
    const h = await new Promise((res,rej) => {
      const req = http.request({...PROXY, path:'/health', method:'GET', timeout:5000}, r => {
        let b=''; r.on('data', d=>b+=d); r.on('end', ()=>res({status:r.statusCode,body:b}));
      });
      req.on('error', rej); req.end();
    });
    if (h.status === 200) pass('Server still healthy after all boundary tests ✓');
    else fail('Server unhealthy after tests', h.body);
  } catch(e) { fail('Server unreachable after tests', e.message); }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(bold(cyan('\n╔══════════════════════════════════════════════════════╗')));
  console.log(bold(cyan('║   Claude Relay Proxy — Boundary / Limits Test Suite  ║')));
  console.log(bold(cyan('╚══════════════════════════════════════════════════════╝')));
  console.log(dim(`  Proxy: http://${PROXY.host}:${PROXY.port}`));
  console.log(dim(`  Time : ${new Date().toLocaleString()}\n`));

  await testHttpSurface();
  await testRequestEdgeCases();
  await testMessageFormats();
  await testToolEdgeCases();
  await testStreamingEdgeCases();
  await testConcurrency();
  await testResponseShape();
  await testKnownLimitations();

  console.log(bold('\n── Summary ─────────────────────────────────────────────'));
  console.log(`  ${green(`${passed} passed`)}  ${failed > 0 ? red(`${failed} failed`) : dim('0 failed')}  ${warned > 0 ? yellow(`${warned} warned`) : dim('0 warnings')}`);

  if      (failed === 0 && warned === 0) console.log(green(bold('\n  ✓ All boundary tests passed!\n')));
  else if (failed === 0)                 console.log(yellow(bold('\n  ⚠  Passed with warnings — see above for limitations.\n')));
  else                                   console.log(red(bold('\n  ✗ Some tests FAILED — see above.\n')));
}

main().catch(e => { console.error(red('\nFATAL:'), e); process.exit(1); });
