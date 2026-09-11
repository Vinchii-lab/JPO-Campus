import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
let now = 1_000_000;
let stamp = 'new-build';
let lastReload = now - 60_000;
let timeout = null;
let periodic = null;
const listeners = {};
const location = { pathname: '/', href: '/' };
const context = {
  window: { addEventListener(name, callback) { listeners[name] = callback; } },
  document: { hidden: false },
  location,
  console: { log() {}, error() {} },
  Date: { now: () => now },
  fetch: async () => ({ json: async () => ({ stamp }) }),
  sessionStorage: {
    getItem: () => String(lastReload),
    setItem(_key, value) { lastReload = Number(value); },
  },
  clearTimeout() { timeout = null; },
  setTimeout(callback, delay) { timeout = { callback, delay }; return 1; },
  setInterval(callback, delay) {
    assert.equal(delay, 60_000);
    periodic = callback;
  },
};
vm.runInNewContext(script, context);
const settle = () => new Promise(resolve => setImmediate(resolve));

listeners.load();
await settle();
assert.equal(location.href, '/', 'cooldown prevents an immediate reload');
assert.equal(timeout.delay, 240_050, 'a mismatch retries after cooldown rather than being lost');
now += timeout.delay;
timeout.callback();
await settle();
assert.equal(location.href, '/?_cb=new-build', 'retry upgrades an old tab without another socket event');

location.href = '/';
context.window.__BUILD__ = stamp;
listeners.focus();
await settle();
assert.equal(location.href, '/', 'focus does not reload the current build');
assert.equal(timeout, null);

stamp = 'next-build';
now += 300_001;
periodic();
await settle();
assert.equal(location.href, '/?_cb=next-build', 'periodic recovery works without gameplay/socket callbacks');

location.href = '/';
stamp = undefined;
periodic();
await settle();
assert.equal(location.href, '/', 'invalid stamp responses never trigger a reload');
console.log('PASS: build cooldown retries, focus, socket-independent recovery, and invalid stamp handling');