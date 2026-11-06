// Preserve the player's recoloring and baked outfit. Idle anatomy is rebuilt
// from pixels of their own composed run sheet, never from an uncolored sprite.
(function () {
  'use strict';
  let serial = 0;
  function resolve(scene, sourceKey, dir) {
    const spec = window.JpoFlightPoseData?.[dir] || window.JpoFlightPoseData?.down;
    if (!spec) throw new Error('Flight pose anatomy did not load.');
    const source = scene.textures.get(sourceKey);
    const revision = source._jpoPoseRevision || 0;
    let cached = source._jpoFlightPose;
    if (!cached || cached.revision !== revision || !scene.textures.exists(cached.key)) {
      const image = source.getSourceImage ? source.getSourceImage() : source.source[0].image;
      const canvas = document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(image, 0, 0);
      const native = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const out = ctx.getImageData(0, 0, canvas.width, canvas.height);
      for (const pose of Object.values(window.JpoFlightPoseData)) {
        for (let i = 0; i < pose.pixels.length; i++) {
          const x = i % 16, y = 22 + Math.floor(i / 16);
          const dst = (y * canvas.width + pose.frame * 16 + x) * 4;
          const src = pose.pixels[i];
          for (let channel = 0; channel < 4; channel++)
            out.data[dst + channel] = src < 0 ? 0 : native.data[src * 4 + channel];
        }
      }
      ctx.putImageData(out, 0, 0);
      const key = `jpo_flight_pose_${++serial}`;
      scene.textures.addSpriteSheet(key, canvas, { frameWidth: 16, frameHeight: 32 });
      if (cached && scene.textures.exists(cached.key)) scene.textures.remove(cached.key);
      cached = source._jpoFlightPose = { key, revision };
    }
    return { key: cached.key, frame: spec.frame };
  }
  window.JpoFlightPose = { resolve };
})();
