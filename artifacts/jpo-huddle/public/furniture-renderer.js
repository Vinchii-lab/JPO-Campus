// Dedicated furniture presentation module.
//
// The neighborhood scene owns camera/lifecycle decisions; this module owns
// only catalog art, integer pixel scaling, depth anchors, and activity effects.
// It intentionally has no socket or DOM dependency so a scene can render the
// same authoritative catalog in a home, a yard, or the furniture showroom.
(function installHomeFurnitureRenderer(global) {
  "use strict";

  const DEFAULT_SCALE = 3;
  const texturePrefix = "home-furniture:";
  const animationPrefix = "home-furniture-animation:";

  function entries(catalog) {
    return Object.entries(catalog || {}).filter(([, definition]) =>
      definition && typeof definition === "object");
  }

  function textureKey(definition) {
    return texturePrefix + String(definition?.id || definition?.asset || "unknown");
  }

  function assetPath(definition) {
    // `path` is the current public contract. The fallback keeps old snapshots
    // useful when a scene receives a pre-overhaul catalog row.
    return definition?.path || definition?.assetPath || definition?.url || null;
  }

  function frameInfo(definition) {
    const frames = definition?.frames;
    if (!frames || typeof frames !== "object") return null;
    const frameCount = Math.max(1, Number(frames.frameCount || frames.count || 1));
    const frameWidth = Number(frames.frameWidth);
    const frameHeight = Number(frames.frameHeight);
    if (!Number.isFinite(frameWidth) || !Number.isFinite(frameHeight) ||
        frameWidth <= 0 || frameHeight <= 0) return null;
    return {
      frameCount,
      frameWidth,
      frameHeight,
      frameRate: Math.max(1, Number(frames.frameRate) || 8),
      initialFrame: Math.max(0, Math.min(frameCount - 1, Number(frames.initialFrame) || 0)),
      loop: frames.loop !== false,
    };
  }

  function isAnimated(definition) {
    return (frameInfo(definition)?.frameCount || 1) > 1;
  }

  function setNearest(scene, key) {
    const texture = scene?.textures?.get?.(key);
    if (!texture?.setFilter) return;
    const nearest = global.Phaser?.Textures?.FilterMode?.NEAREST;
    if (nearest !== undefined) texture.setFilter(nearest);
  }

  function preload(scene, catalog) {
    if (!scene?.load) return [];
    const loaded = [];
    for (const [, definition] of entries(catalog)) {
      const path = assetPath(definition);
      if (!path) continue;
      const key = textureKey(definition);
      if (scene.textures?.exists?.(key)) {
        setNearest(scene, key);
        continue;
      }
      const frames = frameInfo(definition);
      if (frames && frames.frameCount > 1 && typeof scene.load.spritesheet === "function") {
        scene.load.spritesheet(key, path, {
          frameWidth: frames.frameWidth,
          frameHeight: frames.frameHeight,
          startFrame: 0,
          endFrame: frames.frameCount - 1,
        });
      } else if (typeof scene.load.image === "function") {
        scene.load.image(key, path);
      }
      loaded.push(key);
    }
    return loaded;
  }

  function animationKey(definition) {
    return animationPrefix + String(definition?.id || definition?.asset || "unknown");
  }

  function ensureAnimation(scene, definition) {
    const frames = frameInfo(definition);
    if (!frames || frames.frameCount < 2 || !scene?.anims) return null;
    const key = animationKey(definition);
    if (scene.anims.exists?.(key)) return key;
    if (typeof scene.anims.generateFrameNumbers !== "function" ||
        typeof scene.anims.create !== "function") return null;
    const frameNumbers = scene.anims.generateFrameNumbers(textureKey(definition), {
      start: 0, end: frames.frameCount - 1,
    });
    scene.anims.create({
      key,
      frames: frameNumbers,
      frameRate: frames.frameRate,
      repeat: frames.loop ? -1 : 0,
    });
    return key;
  }

  function effectForAction(action) {
    return ({
      sit: "comfort",
      lie: "sleep",
      sleep: "sleep",
      shower: "water",
      bathe: "water",
      toggle_water: "water",
      watch: "tv",
    })[action] || null;
  }

  function clearEffect(scene, object) {
    if (!object) return object;
    if (typeof object.stop === "function") object.stop();
    if (typeof object.setFrame === "function") {
      const frame = frameInfo(object.getData?.("furnitureDefinition"))?.initialFrame || 0;
      object.setFrame(frame);
    }
    object.setData?.("activity", null);
    object.setData?.("effect", null);
    object.setData?.("effectState", "off");
    object.setData?.("effectActive", false);
    return object;
  }

  function applyEffect(scene, object, definition, activity = {}) {
    if (!object) return object;
    const action = activity.action || null;
    const effect = activity.effect || effectForAction(action);
    const active = activity.phase !== "stop" && activity.effectState !== "off";
    if (!active) return clearEffect(scene, object);

    const key = ensureAnimation(scene, definition);
    if (key && typeof object.play === "function") object.play(key, true);
    object.setData?.("activity", action);
    object.setData?.("effect", effect);
    object.setData?.("effectState", activity.effectState || "on");
    // Consumers can use this stable marker to add water/screen particles
    // without guessing from a local timer. No fake geometry is drawn here.
    object.setData?.("effectActive", true);
    return object;
  }

  function draw(scene, definition, x, y, options = {}) {
    if (!scene?.add || !definition) return null;
    const frames = frameInfo(definition);
    const animated = !!frames && frames.frameCount > 1;
    const key = textureKey(definition);
    const initialFrame = frames?.initialFrame || 0;
    const object = animated && typeof scene.add.sprite === "function"
      ? scene.add.sprite(x, y, key, initialFrame)
      : scene.add.image(x, y, key);
    if (!object) return null;

    const scale = Number.isFinite(Number(options.scale))
      ? Number(options.scale)
      : (Number.isFinite(Number(definition.scale)) ? Number(definition.scale) : DEFAULT_SCALE);
    const rotation = Number(options.rotation ?? 0);
    const anchor = options.anchor || definition.anchor || "bottom-center";
    const origin = options.origin || (anchor === "center" ? { x: 0.5, y: 0.5 } : { x: 0.5, y: 1 });
    object.setOrigin?.(origin.x, origin.y);
    object.setScale?.(scale);
    if (Number.isFinite(rotation)) object.setAngle?.(rotation);
    if (options.depth !== undefined) object.setDepth?.(options.depth);
    object.setData?.("furnitureId", definition.id);
    object.setData?.("furnitureDefinition", definition);
    object.setData?.("category", definition.category || "Miscellaneous");
    object.setData?.("footprint", definition.footprint || {
      width: definition.width || 1, height: definition.height || 1,
    });
    object.setData?.("anchor", anchor);
    object.setData?.("actions", Array.isArray(definition.actions) ? definition.actions : []);
    object.setData?.("instanceId", options.instanceId == null ? null : String(options.instanceId));
    setNearest(scene, key);

    if (options.activity || options.effect) {
      applyEffect(scene, object, definition, options.activity || {
        effect: options.effect, effectState: options.effectState || "on",
      });
    }
    return object;
  }

  function updateActivity(scene, object, definition, activity) {
    return applyEffect(scene, object, definition, activity);
  }

  global.HomeFurnitureRenderer = Object.freeze({
    preload,
    draw,
    textureKey,
    assetPath,
    frameInfo,
    isAnimated,
    effectForAction,
    applyEffect,
    updateActivity,
    clearEffect,
    effects: Object.freeze({
      apply: applyEffect,
      clear: clearEffect,
      forAction: effectForAction,
    }),
  });
})(typeof window !== "undefined" ? window : globalThis);
