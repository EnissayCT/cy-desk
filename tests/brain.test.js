// Cy's brain without the network: the SDK talks to a fake fetch, so this checks what is sent to the
// Claude API (model, effort, persona, fallbacks, web search) and how replies are read. No key, no cost.
//   node tests/brain.test.js
const brain = require('../lib/cybrain');
let failed = 0;
const ok = (name, cond, extra = '') => { if (!cond) failed++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra !== '' ? ' :: ' + JSON.stringify(extra) : ''}`); };

const sent = [];
let replies = [];
brain._setFetch(async (url, init) => {
  const body = JSON.parse(init.body);
  sent.push({ url: String(url), body, headers: init.headers });
  const r = replies.shift() || { status: 200, json: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: '[happy] Hi!' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 3 } } };
  return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } });
});
const msg = (text, extra = {}) => ({ status: 200, json: { id: 'msg_x', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, ...extra } });

(async () => {
  // no key: nothing is sent
  delete process.env.ANTHROPIC_API_KEY;
  const none = await brain.chat({ apiKey: '', message: 'hi', snapshot: '' });
  ok('no key: no request, clear error', !none.ok && none.error === 'no-key' && sent.length === 0);

  // Haiku chat: plain Messages API, low effort, persona cached, dashboard in the message, mood parsed
  replies = [msg('[love] Busy and good week!')];
  const r = await brain.chat({ apiKey: 'sk-ant-test-0000000000000000000000', message: 'How was my week?', snapshot: 'Commits this week: 14.', history: [{ role: 'user', text: 'hey' }, { role: 'cy', text: 'hi!' }] });
  const b = sent[0].body;
  ok('default model is Haiku 5.5', b.model === 'claude-haiku-5-5', b.model);
  ok('low effort for chat', b.output_config && b.output_config.effort === 'low');
  ok('persona is cached', Array.isArray(b.system) && b.system[0].cache_control && /You are Cy/.test(b.system[0].text));
  ok('history then the new message', b.messages.length === 3 && b.messages[1].role === 'assistant' && /<dashboard>[\s\S]*Commits this week: 14[\s\S]*<\/dashboard>[\s\S]*How was my week\?/.test(b.messages[2].content));
  ok('no fallbacks on Haiku', !b.fallbacks && !/v1\/messages\?beta/.test(sent[0].url));
  ok('mood tag read and removed', r.ok && r.mood === 'love' && r.text === 'Busy and good week!', r);

  // Sonnet / Opus: server-side fallback on refusals
  replies = [msg('[curious] Hmm.')];
  await brain.chat({ apiKey: 'sk-ant-test-0000000000000000000000', model: 'claude-sonnet-5-5', message: 'q', snapshot: '' });
  const s = sent[sent.length - 1];
  const betaHeader = typeof s.headers.get === 'function' ? s.headers.get('anthropic-beta') : s.headers['anthropic-beta'];
  ok('Sonnet 5.5 asks for server-side fallbacks', s.body.model === 'claude-sonnet-5-5' && s.body.fallbacks === 'default' && /server-side-fallback-2026-07-01/.test(String(betaHeader)), { fallbacks: s.body.fallbacks, betaHeader });

  // refusal: Cy declines kindly
  replies = [msg('', { content: [], stop_reason: 'refusal' })];
  const ref = await brain.chat({ apiKey: 'sk-ant-test-0000000000000000000000', message: 'q', snapshot: '' });
  ok('refusal handled', ref.ok && ref.mood === 'worried' && /rather not/.test(ref.text));

  // API errors come back as plain sentences
  replies = [{ status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }];
  const bad = await brain.chat({ apiKey: 'sk-ant-test-0000000000000000000000', message: 'q', snapshot: '' });
  ok('bad key explained', !bad.ok && /refused/.test(bad.error), bad.error);

  // weather: Haiku with the web search tool, a paused turn resumed, JSON read
  sent.length = 0;
  replies = [msg('', { content: [{ type: 'text', text: 'Searching…' }], stop_reason: 'pause_turn' }),
    msg('Here you go: {"condition":"rain","tempC":14.6,"summary":"Light rain, mild","place":"Lisbon, Portugal"}')];
  const w = await brain.weather({ apiKey: 'sk-ant-test-0000000000000000000000', place: 'Lisbon' });
  ok('weather uses Haiku + web search', sent[0].body.model === 'claude-haiku-5-5' && sent[0].body.tools[0].type === 'web_search_20250305' && sent[0].body.tools[0].max_uses <= 2);
  ok('paused turn resumed', sent.length === 2 && sent[1].body.messages.length === 2 && sent[1].body.messages[1].role === 'assistant');
  ok('weather parsed', w.ok && w.condition === 'rain' && w.tempC === 15 && w.place === 'Lisbon, Portugal', w);
  replies = [msg('{"condition":"volcano","tempC":"hot"}')];
  const w2 = await brain.weather({ apiKey: 'sk-ant-test-0000000000000000000000', place: 'X' });
  ok('odd answers made safe', w2.ok && w2.condition === 'clouds' && w2.tempC === null, w2);

  console.log(`${failed ? 'FAILED' : 'ALL PASSED'}: ${failed} failure(s)`);
  process.exitCode = failed ? 1 : 0;
})();
