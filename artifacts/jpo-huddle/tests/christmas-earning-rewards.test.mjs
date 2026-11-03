import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const catalog = source.slice(source.indexOf("const CHORES = {"), source.indexOf("// Station object id → chore id"));
const calculation = source.match(/const chore = \{ \.\.\.CHORES\[choreId\].*;/)[0];

test("Christmas pays five times base chores and reverts outside Christmas", () => {
  for (const season of ["christmas", "halloween", "rainy", null]) {
    const context = vm.createContext({ seasonNow: () => season });
    vm.runInContext(catalog, context);
    for (const [id, base] of Object.entries({ plants: 15, couch: 12, weights: 20, board: 10, meeting: 25 })) {
      const result = vm.runInContext(`(() => { const choreId = '${id}'; ${calculation} return chore; })()`, context);
      assert.equal(result.pay, base * (season === "christmas" ? 5 : 1));
      assert.equal(result.cooldownMs, 3600000);
      assert.equal(vm.runInContext(`CHORES.${id}.pay`, context), base);
    }
  }
});

test("After Dark awards a fixed 500 to each winner and announces the same value", () => {
  assert.match(source, /const ROUND_PRIZE\s*=\s*500;/);
  const settle = source.slice(source.indexOf("async function endRound("), source.indexOf("function roundHandleLeave("));
  assert.match(settle, /\[w.email, ROUND_PRIZE\]/);
  assert.match(settle, /p.coins \+= ROUND_PRIZE/);
  assert.match(settle, /prize: ROUND_PRIZE/);
  assert.match(settle, /r.state = "ending"/);
  assert.match(source, /\[p.email, chore.pay\]/);
  assert.match(source, /pay: chore.pay, line: chore.line/);
});
