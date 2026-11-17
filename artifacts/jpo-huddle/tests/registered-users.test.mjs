import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createAccountGate, deleteRegisteredAccount } from "../registered-users.mjs";

function fixture(overrides = {}) {
  const calls = [];
  const db = {
    async query(sql, args) {
      calls.push({ sql, args });
      if (overrides.failOn && sql.startsWith(overrides.failOn)) throw new Error("Database failure");
      if (sql.startsWith("SELECT email")) return { rows: overrides.missing ? [] : [{ email: "target@example.test", name: "Test Target" }] };
      if (sql.startsWith("SELECT EXISTS")) return { rows: [{ busy: !!overrides.market }] };
      return { rows: [], rowCount: 1 };
    },
    release() { calls.push({ sql: "release" }); },
  };
  return {
    calls,
    args: {
      pool: { async connect() { return db; } },
      gate: createAccountGate(),
      email: "TARGET@example.test", confirmEmail: "target@example.test",
      actorEmail: "owner@example.test", authorized: true,
      busyReason: () => overrides.busy || null,
      disconnect: email => calls.push({ sql: "disconnect", args: [email] }),
    },
  };
}

test("owner deletion commits exactly one account and its personal coach record", async () => {
  const { args, calls } = fixture();
  const result = await deleteRegisteredAccount(args);
  assert.equal(result.email, "target@example.test");
  assert.deepEqual(calls.map(c => c.sql.split(" ")[0]),
    ["BEGIN", "SELECT", "SELECT", "disconnect", "DELETE", "DELETE", "COMMIT", "release"]);
  for (const { sql, args } of calls.filter(c => c.sql.startsWith("DELETE"))) {
    assert.match(sql, /WHERE email = \$1/);
    assert.deepEqual(args, ["target@example.test"]);
  }
  assert.ok(!calls.some(c => /DELETE FROM jpo_(whispers|admin_log|grand_events)/.test(c.sql)));
});

test("non-owners, self deletion, missing identity and wrong confirmation do no DB work", async () => {
  for (const patch of [
    { authorized: false }, { actorEmail: "target@example.test" },
    { actorEmail: "" }, { confirmEmail: "other@example.test" },
    { email: { malicious: true } }, { email: "x".repeat(81) + "@test" },
  ]) {
    const { args, calls } = fixture();
    await assert.rejects(deleteRegisteredAccount({ ...args, ...patch }));
    assert.equal(calls.length, 0);
  }
});

test("missing accounts, active games, market liabilities and database failure roll back", async () => {
  for (const override of [
    { missing: true }, { busy: "Finish the game first." }, { market: true },
    { failOn: "DELETE FROM jpo_players" },
  ]) {
    const { args, calls } = fixture(override);
    await assert.rejects(deleteRegisteredAccount(args));
    assert.ok(calls.some(c => c.sql === "ROLLBACK"));
    assert.ok(!calls.some(c => c.sql === "COMMIT"));
    assert.equal(calls.at(-1).sql, "release");
    assert.equal(args.gate.isDeleting("target@example.test"), false);
    if (!override.failOn) assert.ok(!calls.some(c => c.sql === "disconnect"));
  }
});

test("the gate waits for an in-flight login, rejects new entry and duplicate deletion, and releases afterward", async () => {
  const gate = createAccountGate(), order = [];
  let finishLogin;
  const login = gate.enter("a", async () => {
    order.push("login"); await new Promise(resolve => { finishLogin = resolve; }); order.push("entered");
  });
  await Promise.resolve();
  const deletion = gate.remove("a", async () => { order.push("deleted"); });
  await assert.rejects(gate.enter("a", () => {}), /being deleted/);
  await assert.rejects(gate.remove("a", () => {}), /already in progress/);
  await gate.enter("b", () => order.push("other-account"));
  assert.ok(!order.includes("deleted"));
  finishLogin(); await login; await deletion;
  assert.ok(order.indexOf("entered") < order.indexOf("deleted"));
  await gate.enter("a", () => order.push("new-registration"));
  assert.equal(order.at(-1), "new-registration");
});

test("a failed queued operation cannot strand an account", async () => {
  const gate = createAccountGate();
  await assert.rejects(gate.enter("a", () => { throw new Error("login failed"); }));
  await gate.remove("a", () => {});
  await gate.enter("a", () => {});
});

test("unpaid event rewards prevent account deletion without disconnecting anyone", async () => {
  const { args, calls } = fixture();
  await assert.rejects(deleteRegisteredAccount({
    ...args, rewardLiability: async () => "Unpaid event reward",
  }), /Unpaid event reward/);
  assert.ok(calls.some(c => c.sql === "ROLLBACK"));
  assert.ok(!calls.some(c => c.sql === "disconnect" || c.sql.startsWith("DELETE")));
});

const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const ui = html.slice(
  html.indexOf("    // ── Registered directory"),
  html.indexOf("    function ownerApprove("));

function uiFixture() {
  const events = new Map(), sent = [], elements = new Map(), listeners = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: "", style: {}, innerHTML: "", textContent: "", addEventListener(type, cb) { listeners.set(`${id}:${type}`, cb); } });
    return elements.get(id);
  };
  const window = { _ownerAuthed: true, prompt: () => "target@example.test" };
  const socket = { connected: true, on: (type, cb) => events.set(type, cb), emit: (...args) => sent.push(args) };
  const context = vm.createContext({ window, socket, document: { getElementById: element },
    _adminAuthed: true, Date, isFinite, Set, esc: s => String(s ?? "").replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`) });
  vm.runInContext(ui, context);
  // In a browser, assigning window.renderRoster also creates a global binding.
  context.renderRoster = window.renderRoster;
  events.get("registeredList")([{ email: "target@example.test", name: "Target", coins: 12, status: "Pending" }]);
  const click = () => listeners.get("op-roster-tbody:click")({
    target: { closest: () => ({ disabled: false, dataset: { deleteAccountEmail: "target@example.test" } }) },
  });
  return { window, socket, events, sent, element, click };
}

test("delete UI requires typed matching email and prevents duplicate clicks", () => {
  const s = uiFixture();
  s.window.prompt = () => null; s.click(); assert.equal(s.sent.length, 0);
  s.window.prompt = () => "wrong@example.test"; s.click(); assert.equal(s.sent.length, 0);
  s.window.prompt = () => "target@example.test"; s.click(); s.click();
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0][0], "ownerDeleteAccount");
  assert.match(s.element("op-roster-tbody").innerHTML, /Deleting/);
  s.events.get("ownerDeleteAccountResult")({ ok: true, email: "target@example.test", message: "Deleted" });
  assert.doesNotMatch(s.element("op-roster-tbody").innerHTML, /target@example/);
  assert.equal(s.sent.at(-1)[0], "adminRegisteredList");
});

test("ordinary admins and disconnected browsers cannot send deletion; errors restore the button", () => {
  const s = uiFixture();
  s.window._ownerAuthed = false; s.window.renderRoster(); s.click();
  assert.doesNotMatch(s.element("op-roster-tbody").innerHTML, /Delete account/);
  assert.equal(s.sent.length, 0);
  s.window._ownerAuthed = true; s.socket.connected = false; s.click();
  assert.equal(s.sent.length, 0);
  s.socket.connected = true; s.click();
  s.events.get("ownerDeleteAccountResult")({ ok: false, email: "target@example.test", message: "Finish the game" });
  assert.match(s.element("op-roster-tbody").innerHTML, /Delete account/);
  assert.equal(s.element("op-roster-msg").textContent, "Finish the game");
});

test("forced sign-out restores the removed overlay and clears credentials before showing the account-deleted message", () => {
  const start = html.indexOf("    socket.on('kicked',");
  const code = html.slice(start, html.indexOf("    socket.on('approved',", start));
  for (const originalExists of [false, true]) {
    const nodes = new Map(), calls = [], handlers = new Map();
    const classList = (...initial) => {
      const values = new Set(initial);
      return { add: v => values.add(v), remove: v => values.delete(v), contains: v => values.has(v) };
    };
    const makeOverlay = () => ({ style: {}, classList: classList("hidden"),
      remove() { nodes.delete("join-overlay"); calls.push("remove-old"); } });
    const original = makeOverlay();
    if (originalExists) nodes.set("join-overlay", original);
    nodes.set("coin-hud", { classList: classList("visible") });
    const body = { classList: classList("playing"), appendChild(overlay) {
      nodes.set("join-overlay", overlay);
      for (const id of ["card-register", "card-login", "card-reconnecting", "card-pending", "card-rejected", "card-kicked", "kicked-heading", "kicked-detail"]) {
        nodes.set(id, { classList: classList("hidden"), textContent: "" });
      }
    } };
    const keyboard = { enabled: true };
    vm.runInNewContext(code, {
      socket: { on: (event, fn) => handlers.set(event, fn) },
      document: { getElementById: id => nodes.get(id), body },
      _joinOverlayTemplate: { cloneNode: makeOverlay },
      _clearToken: () => calls.push("clear-token"),
      _roundReset: () => calls.push("round-reset"), _phaserKbd: keyboard,
    });
    handlers.get("kicked")({ reason: "accountDeleted" });
    assert.deepEqual(calls.slice(0, 2), ["clear-token", "round-reset"]);
    assert.equal(nodes.get("join-overlay").classList.contains("hidden"), false);
    assert.equal(nodes.get("card-kicked").classList.contains("hidden"), false);
    assert.match(nodes.get("kicked-heading").textContent, /account was deleted/);
    assert.equal(keyboard.enabled, false);
    assert.equal(body.classList.contains("playing"), false);
    if (originalExists) {
      assert.notEqual(nodes.get("join-overlay"), original);
      // Approval's old closure references a detached node, not the replacement.
      assert.equal(original.classList.contains("hidden"), true);
    }
  }
});
