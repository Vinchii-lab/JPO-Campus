// Plaza Gym uses the exact HQ LimeZu strips at native 3x scale.
// Runs after neighborhood-interiors.js, leaving other room renderers untouched.
(() => {
  const interiors = window.JpoInteriors;
  const preload = interiors.preload;
  const draw = interiors.draw;
  let socket;
  let currentScene;
  const activities = new Map();
  const presentations = new Map();
  const labelStyle = { fontFamily: 'monospace', fontSize: '12px', color: '#d5f4f0',
    backgroundColor: '#18353b', padding: { x: 8, y: 5 } };

  interiors.preload = function(scene) {
    preload.call(this, scene);
    for (const [key, file, width, height] of [
      ['punch_bag_idle', 'punch_bag_idle.png', 32, 32],
      ['punch_bag_hit', 'punch_bag_hit.png', 32, 32],
      ['anim_treadmill', 'anim_treadmill.png', 48, 64],
    ]) if (!scene.textures.exists(key)) scene.load.spritesheet(key, '/assets/' + file,
      { frameWidth: width, frameHeight: height });
    if (!scene.textures.exists('plaza-gym-floor-sheet'))
      scene.load.image('plaza-gym-floor-sheet', '/assets/Gym_layer_1.png');
  };

  function apply(activity) {
    if (!currentScene || currentScene.location !== 'cafe') return;
    if (activity.state === 'stop') {
      activities.delete(activity.id);
      clearPresentation(activity.id);
    }
    else activities.set(activity.id, activity);
    refreshEquipment();
  }

  function actorEntry(scene, id) {
    if (id === socket?.id) return {
      actor: scene.player,
      nameTag: scene.localNameTag,
      cosmetic: scene.localCosmetic,
      cosmeticDef: scene.localCosmeticDef,
      wings: scene.localWings,
      wingsDef: scene.localWingsDef,
      slotObjs: scene.localSlotObjs,
      pet: scene.localPet,
      bubble: scene.localBubble,
      dir: scene.playerDir || 'down',
    };
    const remote = scene.remotes?.[id];
    return remote ? {
      actor: remote.sprite, nameTag: remote.nameTag,
      cosmetic: remote.cosmetic, cosmeticDef: remote.cosmeticDef,
      wings: remote.wings, wingsDef: remote.wingsDef,
      slotObjs: remote.slotObjs, pet: remote.pet, bubble: remote.chatBubble,
      dir: remote.lastDir || 'down',
    } : null;
  }

  function positionWearables(scene, entry, x, y, dir, depth) {
    for (const [object, def] of [
      [entry.cosmetic, entry.cosmeticDef], [entry.wings, entry.wingsDef],
      ...Object.values(entry.slotObjs || {}).map(slot => [slot?.obj, slot?.def]),
    ]) {
      if (!object) continue;
      if (def) scene._placeWearable(object, def, x, y, dir);
      else object.setPosition(x, y - 68);
      object.setDepth(depth + 1);
    }
  }

  function clearPresentation(id) {
    const presentation = presentations.get(id);
    if (!presentation) return;
    presentations.delete(id);
    presentation.runner.destroy();
    const entry = actorEntry(presentation.scene, id);
    if (!entry?.actor) return;
    entry.actor.setVisible(presentation.actorVisible);
    const x = entry.actor.x, y = entry.actor.y, dir = entry.dir;
    entry.nameTag?.setPosition(x, y - 40);
    positionWearables(presentation.scene, entry, x, y, dir, y);
    if (entry.pet) {
      entry.pet.setPosition(x - 38, y + 10);
      if (entry.pet._animSet?.idle) entry.pet.setTexture(entry.pet._animSet.idle);
      presentation.scene._setActorDepth?.(entry.pet, entry.pet.y, -1);
      presentation.scene._placePetAcc?.(entry.pet);
    }
    entry.bubble?.setPosition(x, y - 85);
  }

  function clearAllPresentations() {
    for (const id of [...presentations.keys()]) clearPresentation(id);
  }

  function runningAnimation(scene, textureKey) {
    // This is the renderer's established convention (OfficeScene
    // _createDirAnims and NeighborhoodScene's local/remote walking branches),
    // applied to the real palette/baked-wearable texture.
    scene._createDirAnims?.(textureKey);
    const key = `walk_${textureKey}_up`;
    return scene.anims.exists(key) ? key : null;
  }

  function updateRunPresentation(scene, id, activity) {
    const entry = actorEntry(scene, id);
    if (!entry?.actor || !Number.isFinite(activity.poseX) || !Number.isFinite(activity.poseY)) {
      clearPresentation(id);
      return;
    }
    let presentation = presentations.get(id);
    const textureKey = id === socket.id
      ? (scene.playerTexKey || entry.actor.texture.key)
      : (scene.remotes[id]?.texture || entry.actor.texture.key);
    if (!presentation) {
      const runner = scene.add.sprite(activity.poseX, activity.poseY, textureKey)
        .setScale(3).setOrigin(entry.actor.originX, entry.actor.originY);
      presentation = {
        scene, runner, actorVisible: entry.actor.visible,
        firstFrame: null, changedFrame: false,
      };
      presentations.set(id, presentation);
      entry.actor.setVisible(false);
    }
    const runner = presentation.runner;
    if (runner.texture.key !== textureKey) runner.setTexture(textureKey);
    const key = runningAnimation(scene, textureKey);
    if (key && (runner.anims.currentAnim?.key !== key || !runner.anims.isPlaying)) runner.play(key);
    runner.setPosition(activity.poseX, activity.poseY).setFlipX(false)
      .setDepth(Number.isFinite(activity.poseDepth) ? activity.poseDepth : activity.poseY);
    const frame = runner.frame?.name ?? runner.frame?.index;
    if (presentation.firstFrame == null) presentation.firstFrame = frame;
    else if (frame !== presentation.firstFrame) presentation.changedFrame = true;

    const depth = Number.isFinite(activity.poseDepth) ? activity.poseDepth : activity.poseY;
    entry.nameTag?.setPosition(activity.poseX, activity.poseY - 52).setDepth(depth + 2);
    positionWearables(scene, entry, activity.poseX, activity.poseY, 'up', depth);
    if (entry.pet) {
      // Exercise pose from the pet memory: park beside the owner rather than
      // running through the machine, and carry its accessory with it.
      entry.pet.setPosition(activity.poseX + 52, activity.poseY + 42).setDepth(depth + 1);
      if (entry.pet._animSet?.sit) entry.pet.setTexture(entry.pet._animSet.sit);
      scene._placePetAcc?.(entry.pet);
      entry.pet._acc?.setDepth(depth + 2);
    }
    entry.bubble?.setPosition(activity.poseX, activity.poseY - 92);
  }
  function refreshEquipment() {
    const scene = currentScene;
    if (!scene?.gymEquipment) return;
    for (const station of scene.gymStations) {
      const sprite = scene.gymEquipment.get(station.id);
      const active = [...activities.values()].find(a => a.object === station.id && a.endsAt > Date.now());
      const key = station.kind === 'punch'
        ? (active ? 'plaza-bag-hit' : 'plaza-bag-idle')
        : (active ? 'plaza-tread-run' : null);
      if (key && sprite.anims.currentAnim?.key !== key) sprite.play(key);
      else if (!key) { sprite.anims.stop(); sprite.setTexture('anim_treadmill', 0); }
    }
  }

  interiors.draw = function(scene, location) {
    draw.call(this, scene, location);
    if (location !== 'cafe') return;
    const room = scene.cache.json.get('commercial-layouts')?.rooms?.cafe;
    if (!room?.gymStations?.length) throw new Error('Plaza Gym layout is missing. Regenerate commercial layouts.');
    currentScene = scene;
    activities.clear();
    scene.gymStations = room.gymStations;
    scene.gymEquipment = new Map();

    // Same gym rubber floor as HQ c200/r28: GID 9153, local tile 60
    // in Gym_layer_1 (19 columns), not a new approximate floor graphic.
    const floorKey = 'plaza-gym-rubber-floor';
    if (!scene.textures.exists(floorKey)) {
      const texture = scene.textures.createCanvas(floorKey, 16, 16);
      texture.context.drawImage(scene.textures.get('plaza-gym-floor-sheet').getSourceImage(),
        48, 48, 16, 16, 0, 0, 16, 16);
      texture.refresh().setFilter(Phaser.Textures.FilterMode.NEAREST);
    }
    scene.add.tileSprite(48, 96, 288, 192, floorKey).setOrigin(0).setScale(3)
      .setDepth(-9999).setData('layerRole', 'interior-background');
    const makeText = (x, y, text, style = labelStyle) => scene.add.text(x, y, text, style)
      .setOrigin(0.5).setDepth(2500).setData('layerRole', 'interior-sign');
    makeText(480, 69, 'PLAZA GYM  /  TRAIN TOGETHER', { ...labelStyle, fontSize: '18px' });
    makeText(480, 104, 'BOXING', { ...labelStyle, color: '#ffd987' });
    makeText(480, 294, 'CARDIO', { ...labelStyle, color: '#ffd987' });
    for (const [key, texture, end, rate] of [
      ['plaza-bag-idle', 'punch_bag_idle', 5, 6],
      ['plaza-bag-hit', 'punch_bag_hit', 5, 14],
      ['plaza-tread-run', 'anim_treadmill', 2, 8],
    ]) if (!scene.anims.exists(key)) scene.anims.create({
      key, frames: scene.anims.generateFrameNumbers(texture, { start: 0, end }),
      frameRate: rate, repeat: -1,
    });
    for (const station of scene.gymStations) {
      const sprite = scene.add.sprite(station.x, station.y,
        station.kind === 'punch' ? 'punch_bag_idle' : 'anim_treadmill', 0)
        .setOrigin(0).setScale(3).setDepth(station.blocker.y + station.blocker.height)
        .setData('floorAnchor', station.blocker.y + station.blocker.height)
        .setData('layerRole', 'interior-furniture');
      scene.gymEquipment.set(station.id, sprite);
      scene.add.ellipse(station.anchor.x, station.anchor.y, 46, 18, 0x56cab4, 0.2)
        .setStrokeStyle(1, 0x56cab4, 0.65).setDepth(-10)
        .setData('layerRole', 'interior-background');
    }
    scene.gymHint = makeText(480, 607, 'Walk to a marker · E / action to train · 8 seconds · walk or E to stop');
    scene.gymActorEffects = new Map();
    refreshEquipment();
    socket?.emit('interact', { object: 'plaza-gym:sync' });
    scene.events.once('shutdown', () => {
      socket?.emit('interact', { object: 'plaza-gym:stop' });
      clearAllPresentations();
      scene.gymEquipment = null;
      scene.gymActorEffects?.clear();
      if (currentScene === scene) { currentScene = null; activities.clear(); }
    });
  };

  window.JpoGym = {
    bind(connection) {
      socket = connection;
      socket.on('plazaGymActivity', apply);
      socket.on('plazaGymSnapshot', list => {
        clearAllPresentations();
        activities.clear();
        if (Array.isArray(list)) list.forEach(apply);
        refreshEquipment();
      });
    },
    nearby(scene) {
      if (scene.location !== 'cafe' || !scene.player || !scene.gymStations) return null;
      return scene.gymStations.find(s => Math.hypot(scene.player.x - s.anchor.x,
        scene.player.y - s.anchor.y) <= s.radius) || null;
    },
    interact(scene) {
      if (scene.location !== 'cafe') return false;
      if (activities.has(socket.id)) {
        socket.emit('interact', { object: 'plaza-gym:stop' });
        return true;
      }
      const station = this.nearby(scene);
      if (!station) return false;
      socket.emit('interact', { object: station.id });
      return true;
    },
    update(scene) {
      if (scene !== currentScene || !scene.player) return;
      let changed = false;
      for (const [id, activity] of activities) {
        if (Date.now() >= activity.endsAt) {
          activities.delete(id);
          clearPresentation(id);
          changed = true;
        }
      }
      if (changed) refreshEquipment();
      const own = activities.get(socket.id);
      const near = this.nearby(scene);
      scene.gymHint.setText(own
        ? `${own.kind === 'run' ? 'RUNNING' : 'BOXING'} · ${Math.max(0, Math.ceil((own.endsAt - Date.now()) / 1000))}s · E / walk to stop`
        : near ? `[E] ${near.kind === 'run' ? 'Run' : 'Punch'} for 8 seconds`
          : 'Walk to a marker · E / action to train · 8 seconds · walk or E to stop');
      for (const [id, effect] of scene.gymActorEffects) {
        if (!activities.has(id)) { effect.destroy(); scene.gymActorEffects.delete(id); }
      }
      for (const [id, activity] of activities) {
        if (activity.kind === 'run') {
          updateRunPresentation(scene, id, activity);
        } else clearPresentation(id);
      }
    },
  };
})();