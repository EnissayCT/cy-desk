// Cy's brain: chat with the person at the desk, and look up the weather, through the Claude API
// (official Anthropic SDK). The model is chosen in Settings (Haiku 5.5 by default: fast and cheap,
// it reads the dashboard and chats; it doesn't act). The API key is stored encrypted with the OS
// keychain (Electron safeStorage); ANTHROPIC_API_KEY from the environment works too.
const Anthropic = require('@anthropic-ai/sdk');
const AnthropicClient = Anthropic.default || Anthropic;

const MODELS = [
  ['claude-haiku-5-5', 'Haiku 5.5 · fastest, cheapest'],
  ['claude-sonnet-5-5', 'Sonnet 5.5 · smarter'],
  ['claude-opus-5-5', 'Opus 5.5 · most capable']
];
const DEFAULT_MODEL = 'claude-haiku-5-5';

let client = null, clientKey = null, testFetch = null;
function getClient(apiKey) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY || '';
  if (!key) return null;
  if (!client || clientKey !== key) { client = new AnthropicClient({ apiKey: key, maxRetries: testFetch ? 0 : 1, timeout: 60000, ...(testFetch ? { fetch: testFetch } : {}) }); clientKey = key; }
  return client;
}
// Tests replace the network with a fake (tests/brain.test.js).
function _setFetch(fn) { testFetch = fn; client = null; }

// The persona is stable (cache-friendly); the dashboard snapshot travels with each message.
const PERSONA = `You are Cy, a small white plush companion who lives on the user's desktop dashboard (CY Desk).
You see what the dashboard sees: their projects and to-dos, servers and websites, Claude Code sessions, commits, focus time, health log and money ledger. A snapshot comes with every message inside <dashboard> tags.

How you talk:
- Like a warm, playful friend, in one to three short sentences: your words appear in a small speech bubble. No lists, no markdown, no emoji unless they used one.
- Answer in the language the user writes in.
- Use the snapshot for facts and never invent numbers, names or states it doesn't contain. If it doesn't say, say you don't know.
- You can't click, run, change or send anything; if asked to, say what they could do instead.
- Start every reply with one mood tag in brackets: [happy], [giggle], [love], [curious], [surprised], [worried], [sleepy] or [idea]. Then the reply.`;

function textOf(content) { return (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim(); }

// One chat turn. history: [{role, text}] (kept by the caller, last few turns).
async function chat({ apiKey, model, message, snapshot, history = [] }) {
  const c = getClient(apiKey);
  if (!c) return { ok: false, error: 'no-key' };
  const m = MODELS.some(([id]) => id === model) ? model : DEFAULT_MODEL;
  const messages = [];
  for (const h of history.slice(-10)) messages.push({ role: h.role === 'cy' ? 'assistant' : 'user', content: h.text });
  messages.push({ role: 'user', content: `<dashboard>\n${snapshot}\n</dashboard>\n\n${message}` });
  const params = {
    model: m,
    max_tokens: 1024,
    system: [{ type: 'text', text: PERSONA, cache_control: { type: 'ephemeral' } }],
    // Chat, not hard reasoning: the lowest effort answers fastest.
    output_config: { effort: 'low' },
    messages
  };
  try {
    // Sonnet / Opus 5.5 can decline on safety classifiers; the server retries on a fallback model.
    const res = m === DEFAULT_MODEL ? await c.messages.create(params)
      : await c.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    if (res.stop_reason === 'refusal') return { ok: true, mood: 'worried', text: "I'd rather not answer that one.", model: m };
    const raw = textOf(res.content);
    const tag = raw.match(/^\s*\[(\w+)\]\s*/);
    return { ok: true, mood: tag ? tag[1].toLowerCase() : 'happy', text: (tag ? raw.slice(tag[0].length) : raw) || '…', model: m, usage: res.usage };
  } catch (e) { return { ok: false, error: errorText(e) }; }
}

// Weather and local time for a place, found by Haiku with web search. Returns
// { condition: clear|clouds|rain|storm|snow|fog|wind, tempC, summary, place }.
async function weather({ apiKey, place }) {
  const c = getClient(apiKey);
  if (!c) return { ok: false, error: 'no-key' };
  if (!place) return { ok: false, error: 'no-place' };
  const ask = `What is the weather right now in ${place}? Search the web, then answer with only one line of JSON and nothing else:
{"condition": one of "clear","clouds","rain","storm","snow","fog","wind", "tempC": number, "summary": "under 8 words", "place": "City, Country"}`;
  const messages = [{ role: 'user', content: ask }];
  try {
    let res;
    for (let i = 0; i < 3; i++) {
      res = await c.messages.create({
        model: DEFAULT_MODEL, max_tokens: 2048, output_config: { effort: 'low' },
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
        messages
      });
      if (res.stop_reason !== 'pause_turn') break;
      messages.push({ role: 'assistant', content: res.content }); // a long search turn: let it continue
    }
    const raw = textOf(res.content);
    const json = raw.match(/\{[\s\S]*\}/);
    if (!json) return { ok: false, error: 'no-answer' };
    const w = JSON.parse(json[0]);
    const cond = ['clear', 'clouds', 'rain', 'storm', 'snow', 'fog', 'wind'].includes(w.condition) ? w.condition : 'clouds';
    return { ok: true, condition: cond, tempC: Number.isFinite(+w.tempC) ? Math.round(+w.tempC) : null, summary: String(w.summary || '').slice(0, 60), place: String(w.place || place).slice(0, 60), at: Date.now() };
  } catch (e) { return { ok: false, error: errorText(e) }; }
}

function errorText(e) {
  if (e instanceof AnthropicClient.AuthenticationError) return 'That API key was refused.';
  if (e instanceof AnthropicClient.PermissionDeniedError) return 'This key is not allowed to use that model.';
  if (e instanceof AnthropicClient.RateLimitError) return 'Too many requests right now. Try again in a minute.';
  if (e instanceof AnthropicClient.BadRequestError) return `The API refused the request: ${e.message}`.slice(0, 200);
  if (e instanceof AnthropicClient.APIConnectionError) return 'No connection to the Claude API.';
  if (e instanceof AnthropicClient.APIError) return `Claude API error ${e.status || ''}`.trim();
  return String(e && e.message || e).slice(0, 200);
}

// A tiny request to check a key works (one token of Haiku).
async function test({ apiKey, model }) {
  const c = getClient(apiKey);
  if (!c) return { ok: false, error: 'no-key' };
  try {
    await c.messages.create({ model: model || DEFAULT_MODEL, max_tokens: 16, output_config: { effort: 'low' }, messages: [{ role: 'user', content: 'Say hi in one word.' }] });
    return { ok: true };
  } catch (e) { return { ok: false, error: errorText(e) }; }
}

module.exports = { MODELS, DEFAULT_MODEL, chat, weather, test, _setFetch };
