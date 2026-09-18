// Plaza Gym uses the exact HQ LimeZu strips at native 3x scale.
// Runs after neighborhood-interiors.js, leaving other room renderers untouched.
(() => {
  const interiors = window.JpoInteriors;
  const preload = interiors.preload;
  const draw = interiors.draw;
  let socket;
  let currentScene;
  const activities = new Map();
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
    if (activity.state === 'stop') activities.delete(activity.id);
    else activities.set(activity.id, activity);
    refreshEquipment();
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
        if (Date.now() >= activity.endsAt) { activities.delete(id); changed = true; }
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
        const actor = id === socket.id ? scene.player : scene.remotes[id]?.sprite;
        if (!actor) continue;
        let effect = scene.gymActorEffects.get(id);
        if (!effect) {
          effect = scene.add.text(actor.x, actor.y - 64, activity.kind === 'run' ? '🏃' : '🥊',
            { fontSize: '20px' }).setOrigin(0.5).setDepth(2600);
          scene.gymActorEffects.set(id, effect);
        }
        effect.setPosition(actor.x, actor.y - 64 + Math.sin(Date.now() / 120) * 3);
        // Keep running avatars animated without moving/teleporting their bodies.
        if (activity.kind === 'run') {
          const key = 'walk_' + actor.texture.key + '_up';
          const animation = scene.anims.get(key);
          if (animation?.frames?.length) {
            const frame = animation.frames[Math.floor((Date.now() - activity.startedAt) *
              animation.frameRate / 1000) % animation.frames.length];
            actor.anims.stop();
            actor.setFrame(frame.textureFrame);
          }
        }
      }
    },
  };
})();