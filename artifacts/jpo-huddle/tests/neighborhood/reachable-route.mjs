// Test-only planner. Rectangles here are forbidden SPRITE-origin regions,
// not a mixture of server foot coordinates and Arcade body coordinates.
export function collisionRegions({ serverBlocks = [], clientBlocks = [], body, radius = 16 }) {
  return [
    ...serverBlocks.map(r => ({
      x: r.x - radius, y: r.y - radius,
      width: r.width + radius * 2, height: r.height + radius * 2,
    })),
    ...clientBlocks.map(r => ({
      x: r.x - body.offsetX - body.halfWidth,
      y: r.y - body.offsetY - body.halfHeight,
      width: r.width + body.halfWidth * 2,
      height: r.height + body.halfHeight * 2,
    })),
  ];
}

export function reachableRoute({ start, goal, bounds, regions, step = 8, clearance = 4 }) {
  const walkable = (x, y, padding = clearance) => x >= 20 && y >= 20 &&
    x <= bounds.width - 20 && y <= bounds.height - 20 &&
    !regions.some(r => x > r.x - padding && x < r.x + r.width + padding &&
      y > r.y - padding && y < r.y + r.height + padding);
  const segment = (a, b) => {
    const n = Math.ceil(Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)));
    for (let i = 1; i <= n; i++)
      if (!walkable(a.x + (b.x - a.x) * i / n, a.y + (b.y - a.y) * i / n,
        a.gx === 0 && a.gy === 0 && !walkable(a.x, a.y) ? 0 : clearance)) return false;
    if (!walkable(b.x, b.y)) return false;
    return true;
  };
  // Anchor lattice at the ACTUAL start: rounding it onto a blocked cell or
  // assuming an untested diagonal from the start made the old BFS unsound.
  const queue = [{ ...start, gx: 0, gy: 0, parent: -1 }];
  const seen = new Set(["0,0"]);
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i];
    if (walkable(p.x, p.y) && Math.hypot(p.x - goal.x, p.y - goal.y) <= goal.radius) {
      const path = [];
      for (let j = i; j >= 0; j = queue[j].parent) path.push({ x: queue[j].x, y: queue[j].y });
      path.reverse();
      const waypoints = [];
      for (let j = 1; j < path.length - 1; j++)
        if (path[j + 1].x - path[j].x !== path[j].x - path[j - 1].x ||
            path[j + 1].y - path[j].y !== path[j].y - path[j - 1].y) waypoints.push(path[j]);
      waypoints.push(path.at(-1));
      return { waypoints, visited: queue.length };
    }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, -1], [0, 1]]) {
      const n = { x: p.x + dx * step, y: p.y + dy * step,
        gx: p.gx + dx, gy: p.gy + dy, parent: i };
      const key = `${n.gx},${n.gy}`;
      if (!seen.has(key) && segment(p, n)) { seen.add(key); queue.push(n); }
    }
  }
  throw new Error(`No full-body route from ${JSON.stringify(start)} to ${JSON.stringify(goal)}`);
}

// Passed directly to page.evaluate; no closures or changes to game objects.
export function captureRouteGeometry() {
  const scene = window._neighborhoodScene, p = scene.player, b = p.body;
  const blocks = ["_geometryBlocks", "_yardBlocks", "_furnitureBlocks"].flatMap(key =>
    (scene[key]?.children?.entries || []).filter(o => o.body?.enable !== false && o.body).map(o => ({
      x: o.body.x, y: o.body.y, width: o.body.width, height: o.body.height,
    })));
  return {
    start: { x: p.x, y: p.y }, bounds: scene.info.bounds,
    serverBlocks: scene.info.geometry?.blockers || [], clientBlocks: blocks,
    radius: scene.info.actorFootRadius || 16,
    body: {
      halfWidth: b.halfWidth, halfHeight: b.halfHeight,
      offsetX: (b.offset.x - p.displayOriginX) * p.scaleX + b.halfWidth,
      offsetY: (b.offset.y - p.displayOriginY) * p.scaleY + b.halfHeight,
    },
  };
}