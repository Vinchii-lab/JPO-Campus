// Personal-home exterior color UI and lossless roof-only house variants.
// neighborhood.js owns map composition; it calls the small bridge documented
// below so this module never needs to own its private scene/UI state.
(function() {
  'use strict';

  const COLORS = Object.freeze({
    teal: { label: 'Teal', hex: '#237c86' },
    terracotta: { label: 'Terracotta', hex: '#b65b45' },
    plum: { label: 'Plum', hex: '#76506f' },
    navy: { label: 'Navy', hex: '#2f4f78' },
    sage: { label: 'Sage', hex: '#70885f' },
  });
  const DEFAULT_COLOR = 'teal';
  const sourceKey = 'ext_house';
  const keyFor = (color) => 'ext_house_roof_' + color;
  const safeColor = (value) => Object.hasOwn(COLORS, value) ? value : DEFAULT_COLOR;

  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    let h = 0;
    if (delta) {
      if (max === r) h = ((g - b) / delta + 6) % 6;
      else if (max === g) h = (b - r) / delta + 2;
      else h = (r - g) / delta + 4;
      h /= 6;
    }
    return [h, max ? delta / max : 0, max];
  }

  function hsvToRgb(h, s, v) {
    const n = h * 6, i = Math.floor(n), f = n - i;
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    const values = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
    return values.map((value) => Math.round(value * 255));
  }

  // The sprite uses teal in its roof plus blue-lit windows. Spatial roof masks
  // keep the window/facade pixels entirely untouched; the HSV range then
  // selects the native teal shades inside only those roof/awning regions.
  function isRoofPixel(x, y, width) {
    const upperRoof = y >= 8 && y <= 38 && x >= 5 && x < width - 5;
    const sideRoof = y >= 38 && y <= 60 && (x < 34 || x > width - 35);
    const porchRoof = y >= 70 && y <= 84 && x >= 5 && x < width - 5;
    return upperRoof || sideRoof || porchRoof;
  }

  function ensureVariant(scene, requestedColor) {
    const color = safeColor(requestedColor);
    if (!scene?.textures) return sourceKey;
    if (color === DEFAULT_COLOR) return sourceKey;
    const textureKey = keyFor(color);
    if (scene.textures.exists(textureKey)) return textureKey;
    const source = scene.textures.get(sourceKey);
    const image = source?.getSourceImage?.();
    if (!image?.width || !image?.height || typeof document === 'undefined') return sourceKey;
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const [targetHue, targetSat] = rgbToHsv(
      parseInt(COLORS[color].hex.slice(1, 3), 16),
      parseInt(COLORS[color].hex.slice(3, 5), 16),
      parseInt(COLORS[color].hex.slice(5, 7), 16),
    );
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      if (!isRoofPixel(x, y, canvas.width)) continue;
      const offset = (y * canvas.width + x) * 4;
      if (!pixels.data[offset + 3]) continue;
      const [hue, saturation, value] = rgbToHsv(pixels.data[offset], pixels.data[offset + 1], pixels.data[offset + 2]);
      // Native teal roof shading; preserve black outlines and every non-roof
      // texture detail by replacing only qualifying painted roof pixels.
      if (hue < 0.47 || hue > 0.59 || saturation < 0.32 || value < 0.16 || value > 0.72) continue;
      const [r, g, b] = hsvToRgb(targetHue, Math.max(targetSat * 0.72, saturation * 0.5), value);
      pixels.data[offset] = r; pixels.data[offset + 1] = g; pixels.data[offset + 2] = b;
    }
    context.putImageData(pixels, 0, 0);
    scene.textures.addCanvas(textureKey, canvas);
    return textureKey;
  }

  // Call from NeighborhoodScene.preload after the existing ext_house load.
  // Variants are generated in create after Phaser has decoded the source image.
  function preloadHouseColors(_scene) {}

  function prepareHouseColors(scene) {
    Object.keys(COLORS).forEach((color) => ensureVariant(scene, color));
  }

  function applyHomeColor(sprite, color) {
    if (!sprite?.setTexture) return sprite;
    sprite.setTexture(ensureVariant(sprite.scene, color));
    return sprite;
  }

  let socket = null;
  let getBridge = null;
  const bridge = () => (typeof getBridge === 'function' ? getBridge() || {} : {});

  function render(panel) {
    const existing = panel?.querySelector?.('[data-house-colors]');
    existing?.remove();
    const state = bridge().homeState;
    const location = bridge().currentLocation;
    if (!panel || !state?.canEdit || typeof location !== 'string' || !location.startsWith('home:')) return;

    const section = document.createElement('section');
    section.className = 'home-section';
    section.dataset.houseColors = 'true';
    const label = document.createElement('small');
    label.textContent = 'Exterior roof color';
    section.appendChild(label);
    const palette = document.createElement('div');
    palette.setAttribute('role', 'group');
    palette.setAttribute('aria-label', 'Exterior roof color');
    palette.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px';
    const selected = safeColor(state.exteriorColor);
    Object.entries(COLORS).forEach(([id, definition]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.houseColor = id;
      button.textContent = definition.label;
      button.setAttribute('aria-pressed', String(id === selected));
      button.style.cssText = 'border:2px solid ' + (id === selected ? '#fff4cf' : '#35424a') +
        ';background:' + definition.hex + ';color:#fff;padding:5px 7px;cursor:pointer;text-shadow:1px 1px #182331';
      button.addEventListener('click', () => socket?.emit('homeColorSet', { color: id }));
      palette.appendChild(button);
    });
    section.appendChild(palette);
    panel.appendChild(section);
  }

  function initHouseColors(nextSocket, nextBridge) {
    if (socket) return window.jpoHouseColors;
    socket = nextSocket;
    getBridge = nextBridge;
    socket?.on('homeColorResult', (result) => {
      if (result?.message) bridge().toast?.(result.message);
      // The server also publishes homeSnapshot to every occupant. The optional
      // setter lets the owning UI adopt the result immediately without trusting
      // a requested value over the returned authoritative snapshot.
      if (result?.ok && result.home) bridge().setHomeState?.(result.home);
      bridge().rerenderHome?.();
    });
    return window.jpoHouseColors;
  }

  window.jpoHouseColors = Object.freeze({
    COLORS,
    preloadHouseColors,
    prepareHouseColors,
    applyHomeColor,
    render,
  });
  window.initHouseColors = initHouseColors;
})();