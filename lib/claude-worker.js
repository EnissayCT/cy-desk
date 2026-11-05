// Runs the Claude transcript reading (lib/claude.js usage + repos) off the main thread: the first
// pass over weeks of transcripts takes seconds. Keeps its cache between requests.
const { parentPort } = require('worker_threads');
const claude = require('./claude');

parentPort.on('message', (msg) => {
  try {
    if (msg.cmd === 'usage') parentPort.postMessage({ id: msg.id, ok: true, data: claude.usage(msg.opts || {}) });
    else if (msg.cmd === 'repos') parentPort.postMessage({ id: msg.id, ok: true, data: claude.repos(msg.opts || {}) });
    else parentPort.postMessage({ id: msg.id, ok: false, error: 'unknown command' });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, ok: false, error: e.message });
  }
});
