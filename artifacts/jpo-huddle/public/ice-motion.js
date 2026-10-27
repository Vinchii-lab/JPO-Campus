// Uses actual post-collision velocity, never a separate momentum reservoir.
// A correction, pause or seat reset therefore also resets skating momentum.
(function (root) {
  'use strict';
  root.JpoIceMotion = {
    step(previous, target, speed, delta) {
      const dt = Math.max(0, Math.min(Number(delta) || 0, 50)) / 1000;
      const cap = Math.max(0, Number(speed) || 0);
      const clamp = (v) => {
        let x = Number.isFinite(v?.x) ? v.x : 0, y = Number.isFinite(v?.y) ? v.y : 0;
        const n = Math.hypot(x, y);
        if (n > cap && n > 0) { x *= cap / n; y *= cap / n; }
        return { x, y };
      };
      const from = clamp(previous), to = clamp(target);
      const input = Math.hypot(to.x, to.y) > 0;
      // Exaggerated ice: ~10 seconds / twelve tiles of free coast at full speed.
      // Build speed quickly, but make braking/reversing deliberately slippery.
      // Leaving ice, collisions and ordinary action stops still cancel the slide.
      const turning = input && Math.hypot(from.x, from.y) > 6 &&
        from.x * to.x + from.y * to.y < Math.hypot(from.x, from.y) * Math.hypot(to.x, to.y) * 0.9;
      const k = 1 - Math.exp(-dt / (input ? (turning ? 0.65 : 0.18) : 3));
      let x = from.x + (to.x - from.x) * k;
      let y = from.y + (to.y - from.y) * k;
      if (!input && Math.hypot(x, y) < 6) x = y = 0;
      return clamp({ x, y });
    },
  };
})(window);
