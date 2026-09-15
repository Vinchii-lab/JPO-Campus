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
  // The y coordinate supplied by the home/commercial layout is the contact
  // point with the floor, not the centre of the bitmap. Keep the contract
  // explicit here so an image's visual height can never move it in front of
  // an actor standing on the same row.
  const OCCLUDER_EPSILON = 0.01;

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

  function finite(value, fallback) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
  }

  function floorAnchor(definition, x, y, options = {}) {
    // `depth` was the original renderer option and remains an accepted
    // alias. New callers can name the value `floorAnchor` to make accidental
    // bitmap-centre sorting harder to introduce.
    return finite(options.floorAnchor, finite(options.depth, finite(y, 0)));
  }

  function floorDepth(anchor, bias = 0) {
    return finite(anchor, 0) + finite(bias, 0);
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
    const parts = [object, ...(object.getData?.("occluderParts") || [])];
    const definition = object.getData?.("furnitureDefinition");
    const frame = frameInfo(definition)?.initialFrame || 0;
    parts.forEach((part) => {
      if (!part) return;
      if (typeof part.stop === "function") part.stop();
      if (typeof part.setFrame === "function") part.setFrame(frame);
    });
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
    const parts = [object, ...(object.getData?.("occluderParts") || [])];
    if (key) parts.forEach((part) => part?.play?.(key, true));
    object.setData?.("activity", action);
    object.setData?.("effect", effect);
    object.setData?.("effectState", activity.effectState || "on");
    // Consumers can use this stable marker to add water/screen particles
    // without guessing from a local timer. No fake geometry is drawn here.
    object.setData?.("effectActive", true);
    return object;
  }

  function textureFrameSize(scene, object, definition) {
    const frames = frameInfo(definition);
    if (frames) return { width: frames.frameWidth, height: frames.frameHeight };
    const key = object?.texture?.key;
    const source = key && scene?.textures?.get?.(key)?.getSourceImage?.();
    return {
      width: finite(source?.width, 0),
      height: finite(source?.height, 0),
    };
  }

  function occluderConfig(definition, options = {}) {
    if (options.occluder === false) return null;
    const configured = options.occluder && typeof options.occluder === "object"
      ? options.occluder : definition?.occluder;
    if (!configured || typeof configured !== "object") return null;
    // Occlusion is authored against the actual source art.  A definition can
    // provide a default front row plus a narrower action-specific row (for
    // example a bath rim versus a sofa rail); actions never opt in through a
    // guessed global crop.
    const action = options.action || options.activity?.action || null;
    if (configured.actions && action && configured.actions[action]) {
      return configured.actions[action];
    }
    if (configured.default && typeof configured.default === "object") {
      return configured.default;
    }
    // Accept a direct `{ fromPx, ... }` authored config for commercial
    // manifests and tests.  Nested action maps are handled above.
    return Number.isFinite(Number(configured.fromPx)) ||
      Number.isFinite(Number(configured.fromRatio)) ||
      Number.isFinite(Number(configured.from))
      ? configured : null;
  }

  // Split the lower/front portion of a bitmap into a second display object.
  // The original object remains the back portion and therefore still sorts
  // against actors by its actual floor anchor. The front copy is only an
  // occluder; it does not alter the saved footprint or interaction metadata.
  // This is also exported for authored commercial-layout objects, which do not
  // have a catalog definition but use the same Phaser image contract.
  function splitOccluder(scene, object, options = {}) {
    if (!scene?.add || !object || typeof object.setCrop !== "function") return null;
    if (object.getData?.("occluderParts")?.length) return object;
    const size = textureFrameSize(scene, object, object.getData?.("furnitureDefinition"));
    if (!(size.width > 0 && size.height > 0)) return null;
    const authoredFromPx = Number.isFinite(Number(options.fromPx))
      ? Number(options.fromPx) : null;
    const authoredFromRatio = Number.isFinite(Number(options.fromRatio))
      ? Number(options.fromRatio) : null;
    const authoredFrom = Number.isFinite(Number(options.from))
      ? Number(options.from) : null;
    if (authoredFromPx == null && authoredFromRatio == null && authoredFrom == null) return null;
    const from = Math.max(0, Math.min(size.height - 1, Math.floor(
      authoredFromPx != null
        ? authoredFromPx
        : authoredFromRatio != null
          ? size.height * authoredFromRatio
          : authoredFrom,
    )));
    const requestedHeight = Number.isFinite(Number(options.heightPx))
      ? Number(options.heightPx) : size.height - from;
    const height = Math.max(1, Math.min(size.height - from, Math.floor(requestedHeight)));
    const depth = finite(object.depth, finite(object.y, 0));
    const frontDepth = floorDepth(depth, finite(options.depthBias, OCCLUDER_EPSILON));
    const animated = !!object.anims && typeof scene.add.sprite === "function";
    const front = animated
      ? scene.add.sprite(object.x, object.y, object.texture?.key, object.frame?.name ?? object.frame?.index ?? 0)
      : scene.add.image(object.x, object.y, object.texture?.key);
    if (!front) return null;
    const originX = finite(object.originX, 0.5);
    const originY = finite(object.originY, 1);
    front.setOrigin?.(originX, originY);
    front.setScale?.(object.scaleX ?? object.scale ?? 1, object.scaleY ?? object.scale ?? 1);
    if (Number.isFinite(Number(object.angle))) front.setAngle?.(object.angle);
    if (object.flipX !== undefined) front.setFlipX?.(!!object.flipX);
    if (object.flipY !== undefined) front.setFlipY?.(!!object.flipY);
    front.setCrop(0, from, size.width, height);
    front.setDepth?.(frontDepth);
    front.setData?.("floorAnchor", finite(object.getData?.("floorAnchor"), depth));
    front.setData?.("layerRole", "furniture-occluder");
    const parts = object.getData?.("occluderParts") || [];
    parts.push(front);
    object.setData?.("occluderParts", parts);
    // Phaser's destroy event keeps commercial/home cleanup symmetrical: the
    // scene only needs to retain and destroy the returned base object.
    if (!object.getData?.("occluderDestroyBound")) object.once?.("destroy", () => {
      (object.getData?.("occluderParts") || []).forEach((part) => {
        if (!part?.destroyed) part.destroy?.();
      });
    });
    object.setData?.("occluderDestroyBound", true);
    object.setData?.("occluderConfig", { ...options });
    return object;
  }

  function clearOccluder(object) {
    const parts = object?.getData?.("occluderParts") || [];
    parts.forEach((part) => {
      if (!part?.destroyed) part.destroy?.();
    });
    object?.setData?.("occluderParts", []);
    object?.setData?.("occluderConfig", null);
    return object;
  }

  function ensureOccluder(scene, object, definition, options = {}) {
    const config = occluderConfig(definition, options);
    const existing = object?.getData?.("occluderConfig");
    const same = existing && config &&
      Object.keys(config).every((key) => Number(existing[key]) === Number(config[key])) &&
      Object.keys(existing).every((key) => Number(existing[key]) === Number(config[key]));
    if (same && object?.getData?.("occluderParts")?.length) return object;
    clearOccluder(object);
    if (config) splitOccluder(scene, object, config);
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
    const anchorY = floorAnchor(definition, x, y, options);
    const depth = finite(options.depth, anchorY);
    object.setDepth?.(depth);
    object.setData?.("furnitureId", definition.id);
    object.setData?.("furnitureDefinition", definition);
    object.setData?.("category", definition.category || "Miscellaneous");
    object.setData?.("footprint", definition.footprint || {
      width: definition.width || 1, height: definition.height || 1,
    });
    object.setData?.("anchor", anchor);
    object.setData?.("actions", Array.isArray(definition.actions) ? definition.actions : []);
    object.setData?.("instanceId", options.instanceId == null ? null : String(options.instanceId));
    object.setData?.("floorAnchor", anchorY);
    object.setData?.("depth", depth);
    object.setData?.("layerRole", "furniture");
    setNearest(scene, key);

    ensureOccluder(scene, object, definition, {
      ...options,
      action: options.action || options.activity?.action,
    });

    if (options.activity || options.effect) {
      applyEffect(scene, object, definition, options.activity || {
        effect: options.effect, effectState: options.effectState || "on",
      });
    }
    return object;
  }

  function updateActivity(scene, object, definition, activity) {
    ensureOccluder(scene, object, definition, { activity });
    return applyEffect(scene, object, definition, activity);
  }

  global.HomeFurnitureRenderer = Object.freeze({
    preload,
    draw,
    floorAnchor,
    floorDepth,
    splitOccluder,
    clearOccluder,
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
