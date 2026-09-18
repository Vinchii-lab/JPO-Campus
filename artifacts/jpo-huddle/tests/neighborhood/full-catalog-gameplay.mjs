// Opt-in only; invoked by the isolated real-game harness, never production.
import assert from "node:assert/strict";
import { writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

export async function fullCatalogGameplay(h) {
  const { ownerPage: page, guestPage, catalog, ownerEmail, guestEmail, db } = h;
  const matrix = {
    mode: "full-catalog", startedAt: new Date().toISOString(),
    limitations: [
      "QA loader restore swaps showroom to home; reload is setup, not door travel.",
      "Only real delivered cashier DOM is browsed; missing products are BLOCKED, never injected.",
      "Guest editing checks cover visible controls, not adversarial socket authorization.",
    ],
    items: Object.values(catalog).map(item => ({
      id: item.id, category: item.category, footprint: item.footprint,
      purchase: { status: "BLOCKED", reason: "not reached" },
      place: { status: "BLOCKED", reason: "purchase required" },
      store: { status: "BLOCKED", reason: "placement required" },
      move: { status: "BLOCKED", reason: "representative footprint not reached" },
      actions: (item.actions || []).map(action => ({
        action: typeof action === "string" ? action : action.id,
        status: "BLOCKED", reason: "placement required",
      })),
    })),
    guest: { status: "BLOCKED", reason: "not reached" },
    persistence: { status: "BLOCKED", reason: "not reached" },
  };
  // Keep the last completed checkpoint if the bounded test is interrupted.
  const save = async () => {
    const destination = join(h.outputDir, "full-catalog-matrix.json");
    const temporary = `${destination}.tmp`;
    await writeFile(temporary, JSON.stringify(matrix, null, 2));
    await rename(temporary, destination);
  };
  const budget = () => { if (h.remainingMs() < 7000) throw new Error("BLOCKED: journey deadline"); };
  const attempt = async (target, fn) => {
    try { budget(); Object.assign(target, { status: "PASS", evidence: await fn() }); delete target.reason; }
    catch (error) {
      target.status = error.message.startsWith("BLOCKED:") ? "BLOCKED" : "FAIL";
      target.reason = error.message;
    }
    await save();
    return target.status === "PASS";
  };
  // Clear only our capture buffer, not server state, to correlate fresh responses.
  const clear = () => page.evaluate(() => { window.__realGameEvents = []; });
  const ack = async (event, id, action = null) => {
    await page.waitForFunction(({ event, id, action }) =>
      (window.__realGameEvents || []).some(e => e.event === event &&
        (!id || String(e.payload?.instanceId || e.payload?.activity?.instanceId ||
          e.payload?.item?.id) === id || e.payload?.item?.furnitureId === id) &&
        (!action || e.payload?.activity?.action === action)),
    { timeout: Math.min(4500, h.remainingMs()) }, { event, id, action });
    const response = await page.evaluate(({ event, id, action }) =>
      [...window.__realGameEvents].reverse().find(e => e.event === event &&
        (!id || String(e.payload?.instanceId || e.payload?.activity?.instanceId ||
          e.payload?.item?.id) === id || e.payload?.item?.furnitureId === id) &&
        (!action || e.payload?.activity?.action === action))?.payload, { event, id, action });
    assert.equal(response?.ok, true, JSON.stringify(response));
    return response;
  };
  const click = async selector => {
    const button = await page.$(selector);
    if (!button) throw new Error(`BLOCKED: real UI control absent: ${selector}`);
    await button.evaluate(node => node.scrollIntoView({ block: "center" }));
    await button.click();
  };
  const durable = async () => {
    const result = await db.query(
      `SELECT id::text, furniture_id FROM jpo_home_furniture WHERE owner_email=$1 ORDER BY id`,
      [ownerEmail]);
    const balance = await db.query("SELECT coins FROM jpo_players WHERE email=$1", [ownerEmail]);
    return { inventory: result.rows, coins: Number(balance.rows[0].coins) };
  };
  await save();
  try {
    await h.registerThroughUi(page, ownerEmail, "QA Furniture");
    await h.waitForLocation(page, "furniture-shop");
    await h.installEventCapture(page);
    await h.moveThroughPortal(page, "ArrowDown", "city", "catalog real showroom exit");
    await h.moveThroughPortal(page, "ArrowUp", "furniture-shop", "catalog real showroom entry");
    const cashier = await page.evaluate(() => {
      const npc = window._neighborhoodScene?.cashierNpcs?.[0];
      return npc && { x: npc.x, y: npc.y, radius: npc.radius || 116 };
    });
    assert.ok(cashier, "cashier exists");
    await h.walkReachable(page, cashier, "catalog cashier");
    await h.pagePressAndOpenCashier(page);
    matrix.deliveredShop = await page.evaluate(() =>
      [...document.querySelectorAll("#shop-panel [data-buy]")].map(b => ({
        id: b.dataset.buy, text: b.closest(".home-item")?.innerText,
      })));
    // Current production shop renders category headings, not pagination tabs.
    // Use DOM navigation if a future/current deployment exposes category tabs.
    for (const row of matrix.items) {
      await attempt(row.purchase, async () => {
        const category = await page.$(`#shop-panel [data-category="${row.category}"]`);
        if (category) await category.click();
        const before = await durable();
        await clear();
        await click(`#shop-panel [data-buy="${row.id}"]`);
        await click("#shop-panel [data-confirm-purchase]");
        const response = await ack("homePurchaseResult", row.id);
        const after = await durable();
        const added = after.inventory.filter(i => !before.inventory.some(old => old.id === i.id));
        assert.equal(added.length, 1);
        assert.equal(added[0].furniture_id, row.id);
        assert.equal(before.coins - after.coins, Number(catalog[row.id].price));
        row.instanceId = added[0].id;
        return { response, instanceId: row.instanceId, beforeCoins: before.coins, afterCoins: after.coins };
      });
    }
    await h.reloadOwnerHome(page, "catalog setup phase: home");
    const seenFootprints = new Set();
    for (const row of matrix.items) {
      if (!row.instanceId) continue;
      const placed = await attempt(row.place, async () => {
        await h.openInventoryHotbar(page, row.id);
        await h.selectHotbarItem(page, "furniture", row.id, "furniture", row.id);
        await click('.hotbar-action-btn[data-action="place"]');
        await h.hideNeighborhoodOverlay(page);
        await h.clickPlacementSpot(page, row.id);
        await clear();
        await click("#ghost-confirm");
        const response = await ack("homeActionResult", row.instanceId);
        const snapshot = await h.requestHomeSnapshot(page);
        assert.ok(snapshot.layout.some(i => String(i.id) === row.instanceId && i.furnitureId === row.id));
        assert.ok(!snapshot.inventory.some(i => String(i.id) === row.instanceId));
        const sprite = await page.evaluate(id => {
          const s = window._neighborhoodScene?.furniture?.find(s => String(s.getData("instanceId")) === id);
          return s && { texture: s.texture?.key, visible: s.visible, furnitureId: s.getData("furnitureId") };
        }, row.instanceId);
        assert.equal(sprite?.furnitureId, row.id);
        assert.ok(sprite.visible && sprite.texture && !["__MISSING", "__DEFAULT"].includes(sprite.texture));
        return { response, sprite };
      });
      if (!placed) continue;
      const footprint = JSON.stringify(row.footprint);
      if (!seenFootprints.has(footprint)) {
        seenFootprints.add(footprint);
        await attempt(row.move, async () => {
          await h.showNeighborhoodOverlay(page);
          await h.openHomeEditorForHotbar(page);
          const before = await h.requestHomeSnapshot(page);
          await click(`#home-panel [data-move="${row.instanceId}"]`);
          await click("#ghost-cancel");
          assert.deepEqual((await h.requestHomeSnapshot(page)).layout, before.layout);
          // Actual relocated representative requires a second, clear cell.
          await click(`#home-panel [data-move="${row.instanceId}"]`);
          await h.hideNeighborhoodOverlay(page);
          const point = await h.canvasPointForWorld(page, 15 * 48 + 24, 10 * 48 + 24, row.id);
          await page.mouse.click(point.x, point.y);
          await clear();
          await click("#ghost-confirm");
          const response = await ack("homeActionResult", row.instanceId);
          const after = await h.requestHomeSnapshot(page);
          assert.notDeepEqual(after.layout.find(i => String(i.id) === row.instanceId),
            before.layout.find(i => String(i.id) === row.instanceId));
          assert.deepEqual(after.layout.filter(i => String(i.id) !== row.instanceId),
            before.layout.filter(i => String(i.id) !== row.instanceId));
          return response;
        });
      } else row.move = { status: "NOT_APPLICABLE", reason: "footprint represented earlier" };
      for (const action of row.actions) {
        await attempt(action, async () => {
          await h.hideNeighborhoodOverlay(page);
          await h.walkToHomeAction(page, row.id, action.action, row.id, row.instanceId, { tight: true });
          await clear();
          await h.pressFurnitureAction(page, action.action, { shift: action.action === "lie" && row.actions.length > 1 });
          const response = await ack("furnitureInteractionResult", row.instanceId, action.action);
          await h.screenshotChairCloseup(page, `catalog-${row.id}-${action.action}-during`, row.instanceId);
          await h.exitFurnitureAction(page);
          const state = await page.evaluate(() => window._neighborhoodScene?.activity);
          assert.ok(!state, "activity resets after E");
          await h.screenshotChairCloseup(page, `catalog-${row.id}-${action.action}-reset`, row.instanceId);
          return response;
        });
      }
      if (matrix.guest.status === "BLOCKED") await attempt(matrix.guest, async () => {
        await h.registerThroughUi(guestPage, guestEmail, "QA Visitor");
        await h.waitForLocation(guestPage, `home:${ownerEmail}`);
        await h.installEventCapture(guestPage);
        const guest = await h.requestHomeSnapshot(guestPage);
        assert.ok(guest.layout.some(i => String(i.id) === row.instanceId));
        assert.equal(await guestPage.$$eval("#home-panel [data-move], #home-panel [data-return]", nodes => nodes.length), 0);
        await h.screenshot(guestPage, "catalog-guest-representative");
        return { observedInstance: row.instanceId, editingControls: 0 };
      });
      await attempt(row.store, async () => {
        await h.showNeighborhoodOverlay(page);
        await h.openHomeEditorForHotbar(page);
        const before = await h.requestHomeSnapshot(page);
        await clear();
        await click(`#home-panel [data-return="${row.instanceId}"]`);
        const response = await ack("homeActionResult", row.instanceId);
        const after = await h.requestHomeSnapshot(page);
        assert.deepEqual(after.layout, before.layout.filter(i => String(i.id) !== row.instanceId));
        assert.equal(after.inventory.filter(i => String(i.id) === row.instanceId).length, 1);
        assert.equal(after.inventory.length, before.inventory.length + 1);
        return response;
      });
    }
    await attempt(matrix.persistence, async () => {
      const before = await h.requestHomeSnapshot(page);
      await h.reloadOwnerHome(page, "catalog committed batch reload");
      const after = await h.requestHomeSnapshot(page);
      assert.deepEqual(after.layout, before.layout);
      assert.deepEqual(after.inventory, before.inventory);
      return { layout: after.layout, inventory: after.inventory };
    });
  } catch (error) {
    matrix.journey = { status: "FAIL", reason: error.message };
  } finally {
    matrix.finishedAt = new Date().toISOString();
    await save();
  }
  const incomplete = matrix.items.some(row =>
    [row.purchase, row.place, row.store, row.move, ...row.actions]
      .some(test => !["PASS", "NOT_APPLICABLE"].includes(test.status)));
  h.ok(!incomplete && !matrix.journey && matrix.guest.status === "PASS" &&
    matrix.persistence.status === "PASS", "full catalog matrix has no missing gameplay rows");
}