import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const code = html.slice(html.indexOf("    let _connected = false, _resumeSent = false"), html.indexOf("    function _maybeResume()"));

function boot({ connected = true, scene = true, token = true, href = "https://example.invalid/" } = {}) {
  const elements = {}, callbacks = {}, timers = new Map(), replaced = [];
  let tokenCleared = false, timerId = 0;
  function el(id) {
    if (!elements[id]) {
      const hidden = new Set(["reconnect-recovery", "card-login"].includes(id) ? ["hidden"] : []);
      elements[id] = { textContent: "", classList: {
        contains: x => hidden.has(x), add: x => hidden.add(x), remove: x => hidden.delete(x) },
      addEventListener: (event, cb) => { callbacks[id] = cb; },
      querySelector: () => el("spinner") };
    }
    return elements[id];
  }
  vm.runInNewContext(code, {
    window: { _gameScene: scene ? {} : null }, URL, Date,
    socket: { connected }, location: { href, replace: x => replaced.push(x) },
    document: { getElementById: el },
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: id => timers.delete(id),
    _loadToken: () => token, _clearToken: () => { tokenCleared = true; },
  });
  return { el, callbacks, timers, replaced, cleared: () => tokenCleared };
}

test("stalled asset, network and session phases expose recovery without deleting saved session", () => {
  for (const [options, message] of [[{scene:false}, /graphics/], [{connected:false}, /connection/], [{}, /saved-session/]]) {
    const b = boot(options);
    for (const fn of b.timers.values()) fn();
    assert.match(b.el("reconnect-status").textContent, message);
    assert.equal(b.el("reconnect-recovery").classList.contains("hidden"), false);
    assert.equal(b.cleared(), false);
    b.callbacks["reconnect-retry"]();
    assert.equal(b.cleared(), false);
    assert.match(b.replaced[0], /_retry=/);
  }
});
test("explicit sign-in abandons old page; fresh page opens login with no stale resume", () => {
  const b = boot();
  b.callbacks["reconnect-signin"]();
  assert.equal(b.cleared(), true);
  assert.match(b.replaced[0], /_signin=1/);
  const next = boot({ token:false, href:b.replaced[0] });
  assert.equal(next.timers.size, 0);
  assert.equal(next.el("card-login").classList.contains("hidden"), false);
  assert.equal(next.el("card-register").classList.contains("hidden"), true);
});
test("success/failure handlers cancel boot timeout and never reset account data", () => {
  assert.match(html, /socket.on\('approved', _stopResumeWatch\)/);
  assert.match(html, /socket.on\('registrationPending', _stopResumeWatch\)/);
  assert.match(html, /function _showRegisterForm\(\) \{\s*_stopResumeWatch\(\)/);
  assert.doesNotMatch(code, /localStorage.clear|resetPlayer|socket.emit\('register'/);
});
