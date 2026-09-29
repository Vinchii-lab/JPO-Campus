// Illustrative reference only. Renders the approved 16-frame stage-2 and stage-3
// bat flap cycles into two motion studies without changing gameplay assets.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, '../public/assets/pets/anim');
const temp = mkdtempSync(join(tmpdir(), 'bat-special-reference-'));
const FPS = 24, COUNT = 72, W = 1160, H = 550;
const sprites = {};
try {
  for (const stage of [2, 3]) {
    sprites[stage] = Array.from({ length: 16 }, (_, i) => {
      const png = execFileSync('magick', [
        join(assets, `bat_s${stage}_flap${i}.png`),
        '-filter', 'point', '-resize', '300%', 'png32:-',
      ], { maxBuffer: 5e6 });
      return `data:image/png;base64,${png.toString('base64')}`;
    });
  }

  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const ease = v => { v = clamp(v); return v * v * (3 - 2 * v); };
  const mix = (a, b, f) => a + (b - a) * f;
  const fmt = n => Number(n).toFixed(1);
  const wave = (t, offset = 0) => Math.sin((t + offset) * Math.PI * 2);
  function position(stage, t) {
    const startX = stage === 2 ? 210 : 785;
    const distance = stage === 2 ? 155 : 191;
    const prep = stage === 2 ? .35 : .4;
    const dashEnd = stage === 2 ? 1.05 : 1.05;
    const returnEnd = stage === 2 ? 1.75 : 1.85;
    const bob = 2.5 * wave(t * 1.15);
    if (t < prep) {
      const u = ease(t / prep);
      return { x: startX - (stage === 2 ? 17 : 11) * u, y: 276 + bob + 8 * u,
        tilt: -10 * u, direction: 1, phase: '01 / GATHER', progress: u * .24 };
    }
    if (t < dashEnd) {
      const u = (t - prep) / (dashEnd - prep);
      const travel = stage === 2 ? ease(u) : 1 - Math.pow(1 - u, 2.1);
      return { x: startX - (stage === 2 ? 17 : 11) + (distance + (stage === 2 ? 17 : 11)) * travel,
        y: 276 - (stage === 2 ? 8 : 19) * travel + (stage === 2 ? 34 : 28) * Math.sin(Math.PI * u) + bob,
        tilt: mix(-10, stage === 2 ? 16 : 20, Math.sin(Math.PI * Math.min(1, u * 1.3))),
        direction: 1, phase: stage === 2 ? '02 / ECHO SWOOP' : '02 / SPECTRAL DASH',
        progress: .24 + .43 * u };
    }
    if (t < returnEnd) {
      const u = ease((t - dashEnd) / (returnEnd - dashEnd));
      return { x: startX + distance * (1 - u),
        y: mix(276 - (stage === 2 ? 8 : 19), 276, u) - 26 * Math.sin(Math.PI * u) + bob,
        tilt: -8 * Math.sin(Math.PI * u), direction: -1,
        phase: stage === 2 ? '03 / EASE TO HOVER' : '03 / RUNE + RETURN',
        progress: .67 + .33 * u };
    }
    return { x: startX, y: 276 + bob, tilt: 0, direction: 1,
      phase: '04 / HOVER HOLD', progress: 1 };
  }
  function image(stage, x, y, t, options = {}) {
    const index = Math.floor(t * (stage === 2 ? 13 : 15)) % 16;
    const flip = options.direction === -1 ? -1 : 1;
    return `<g opacity="${options.opacity ?? 1}" transform="translate(${fmt(x)} ${fmt(y)}) rotate(${fmt(options.tilt || 0)}) scale(${flip} 1)">
      <image x="-96" y="-96" width="192" height="192" href="${sprites[stage][index]}"/></g>`;
  }
  function orbitDots(cx, cy, t, stage) {
    let out = '';
    for (let i = 0; i < 9; i++) {
      const angle = i * 2.399 + t * 2.7;
      const r = 74 + 12 * Math.sin(i * 6.1);
      const x = cx + Math.cos(angle) * r, y = cy + Math.sin(angle) * r * .62;
      out += `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${i % 3 ? 1.4 : 2.3}" fill="${stage === 2 ? '#b8a3e9' : '#80e5df'}" opacity="${fmt(.22 + .24 * (1 + wave(t * 1.4, i / 9)))}"/>`;
    }
    return out;
  }
  function adultFx(t, p) {
    let out = '';
    // Three discrete wingbeat-timed sonar pulses, radiating only near the bat.
    for (const onset of [.46, .67, .88]) {
      const age = t - onset;
      if (age < 0 || age > .29) continue;
      const sample = position(2, onset);
      const u = age / .29, cx = sample.x + 42 + 47 * u, cy = sample.y - 7;
      for (let i = 0; i < 2; i++) {
        const span = 14 + 17 * u + i * 11;
        out += `<path d="M ${fmt(cx - 7)} ${fmt(cy - span)} Q ${fmt(cx + span * .98)} ${fmt(cy)} ${fmt(cx - 7)} ${fmt(cy + span)}"
          fill="none" stroke="${i ? '#d4b8ff' : '#a886f1'}" stroke-width="${i ? 2 : 2.7}"
          stroke-linecap="round" opacity="${fmt((1 - u) * (i ? .42 : .78))}"/>`;
      }
    }
    if (t < .35) {
      const strength = ease(t / .35);
      out += `<path d="M ${fmt(p.x - 48)} ${fmt(p.y - 30)} Q ${fmt(p.x - 100)} ${fmt(p.y - 7)} ${fmt(p.x - 64)} ${fmt(p.y + 31)}"
        fill="none" stroke="#a893de" stroke-width="2" stroke-dasharray="2 8" stroke-linecap="round" opacity="${fmt(strength * .45)}"/>`;
    }
    return out;
  }
  function finalFx(t, p) {
    let out = '';
    if (t < .4) {
      const s = ease(t / .4);
      for (let i = 0; i < 5; i++) {
        const a = t * 5 + i * 1.256, r = 110 - 46 * s + (i % 2) * 9;
        const x = p.x + Math.cos(a) * r, y = p.y + Math.sin(a) * r * .58;
        out += `<path d="M ${fmt(x - 12)} ${fmt(y + 6)} Q ${fmt(x - 4)} ${fmt(y - 8)} ${fmt(x + 6)} ${fmt(y - 12)}"
          fill="none" stroke="${i % 2 ? '#a39cf4' : '#81e6e0'}" stroke-width="2" stroke-linecap="round"
          opacity="${fmt(.2 + .5 * s)}"/>`;
        out += `<circle cx="${fmt(x + 6)}" cy="${fmt(y - 12)}" r="2.3" fill="#c2f6f0" opacity="${fmt(.3 + .55 * s)}"/>`;
      }
    }
    if (t >= .4 && t < 1.21) {
      // A local history: three actual silhouettes from the same approved flap set.
      for (let n = 3; n >= 1; n--) {
        const past = t - .065 * n;
        if (past < .4 || past > 1.05) continue;
        const q = position(3, past);
        out += image(3, q.x, q.y, past, { opacity: [.0, .26, .17, .09][n], tilt: q.tilt, direction: 1 });
      }
      for (let n = 1; n <= 14; n++) {
        const past = t - .028 * n;
        if (past < .4 || past > 1.05) continue;
        const q = position(3, past);
        const a = 1 - n / 15;
        const wiggle = Math.sin(past * 34 + n * .8);
        const cx = q.x - 13, cy = q.y + 26 + 12 * wiggle;
        out += `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(1.2 + 2.8 * a)}" fill="${n % 2 ? '#8fe9e7' : '#be9bfc'}" opacity="${fmt(.57 * a)}"/>`;
        if (n % 3 === 0) out += `<path d="M ${fmt(cx - 12)} ${fmt(cy + 4)} Q ${fmt(cx - 2)} ${fmt(cy - 9)} ${fmt(cx + 7)} ${fmt(cy - 6)}"
          fill="none" stroke="${n % 2 ? '#90e9e7' : '#ad90f4'}" stroke-width="2" stroke-linecap="round" opacity="${fmt(.43 * a)}"/>`;
      }
    }
    const age = t - 1.015;
    if (age >= 0 && age < .51) {
      const u = age / .51, x = 976, y = 257, radius = 18 + 61 * ease(u);
      out += `<circle cx="${x}" cy="${y}" r="${fmt(radius)}" fill="none" stroke="#a693fa"
        stroke-width="2.5" opacity="${fmt(.7 * (1-u))}"/>`;
      out += `<circle cx="${x}" cy="${y}" r="${fmt(radius * .73)}" fill="none" stroke="#8cebe5"
        stroke-width="1.5" opacity="${fmt(.5 * (1-u))}"/>`;
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4, px = x + radius * Math.cos(a), py = y + radius * Math.sin(a);
        out += `<path d="M ${fmt(px - 3)} ${fmt(py)} l 3 -4 3 4 -3 4 z"
          fill="none" stroke="${i % 2 ? '#c3a7fa' : '#91e8e2'}" stroke-width="1.5" opacity="${fmt(.8 * (1-u))}"/>`;
      }
    }
    return out;
  }
  function panel(stage, t) {
    const p = position(stage, t), x = stage === 2 ? 24 : 594;
    const accent = stage === 2 ? '#bea3f9' : '#9beae4';
    const badge = stage === 2 ? 'FORM 02  /  ADULT' : 'FORM 03  /  FINAL';
    const title = stage === 2 ? 'ECHO SWOOP' : 'SPECTRAL DASH';
    const subtitle = stage === 2 ? 'Gather · curved swoop · 3 sonar beats' : 'Gather · phantom dash · rune finish';
    let ticks = '';
    for (let i = 0; i < 30; i++) {
      ticks += `<rect x="${x + 35 + i * 16}" y="461" width="9" height="4" rx="2"
        fill="${i / 30 <= p.progress ? accent : '#46505f'}" opacity="${i / 30 <= p.progress ? '.92' : '.55'}"/>`;
    }
    const path = stage === 2
      ? 'M 210 276 Q 290 346 365 268 Q 276 205 210 276'
      : 'M 785 276 Q 873 344 976 257 Q 883 205 785 276';
    return `<g>
      <rect x="${x}" y="82" width="542" height="424" rx="22" fill="#222833" stroke="#485364" stroke-width="1.4"/>
      <rect x="${x + 1}" y="83" width="540" height="71" rx="21" fill="#292f3d"/>
      <rect x="${x + 1}" y="135" width="540" height="19" fill="#292f3d"/>
      <text x="${x + 28}" y="110" fill="${accent}" font-size="13" font-weight="700" letter-spacing="2.6">${badge}</text>
      <text x="${x + 28}" y="141" fill="#f5f3fa" font-size="25" font-weight="700" letter-spacing="1.2">${title}</text>
      <rect x="${x + 20}" y="168" width="502" height="271" rx="14" fill="#1b222d" stroke="#364454"/>
      <path d="${path}" fill="none" stroke="${accent}" stroke-width="1.5" stroke-dasharray="4 9" opacity=".3"/>
      <line x1="${x + 34}" y1="415" x2="${x + 508}" y2="415" stroke="#657085" stroke-opacity=".28" stroke-dasharray="3 8"/>
      <ellipse cx="${stage === 2 ? 210 : 785}" cy="415" rx="78" ry="28" fill="url(#halo)" opacity=".19"/>
      ${orbitDots(p.x, p.y, t, stage)}
      ${stage === 2 ? adultFx(t, p) : finalFx(t, p)}
      ${image(stage, p.x, p.y, t, { tilt: p.tilt, direction: p.direction })}
      <text x="${x + 30}" y="456" fill="#e4dfed" font-size="14" letter-spacing=".8" font-weight="700">${p.phase}</text>
      ${ticks}
      <text x="${x + 30}" y="491" fill="#9da9b9" font-size="12">${subtitle}</text>
    </g>`;
  }
  function render(t) {
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="DejaVu Sans, sans-serif">
      <defs>
        <radialGradient id="bg"><stop stop-color="#323846"/><stop offset="1" stop-color="#171c25"/></radialGradient>
        <radialGradient id="halo"><stop stop-color="#c5b2f8"/><stop offset="1" stop-color="#c5b2f8" stop-opacity="0"/></radialGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#bg)"/>
      <text x="25" y="38" fill="#f4f2f8" font-size="20" font-weight="700" letter-spacing="1.3">BAT SPECIALS  /  MOTION REFERENCE</text>
      <text x="25" y="62" fill="#b2bdcb" font-size="12">Approved sprites · 3× nearest-neighbor · proposed timing only</text>
      ${panel(2, t)}${panel(3, t)}
      <text x="27" y="535" fill="#91a0af" font-size="11" letter-spacing=".5">LOCALIZED FX  •  NO CAMERA SHAKE  •  ORIGINAL ART / ORIGINAL FLAP CYCLE</text>
      <text x="1030" y="535" fill="#91a0af" font-size="11">${fmt(t)}s / 3.0s</text>
    </svg>`;
  }
  mkdirSync(temp, { recursive: true });
  for (let i = 0; i < COUNT; i++) {
    const svg = join(temp, `frame-${String(i).padStart(3, '0')}.svg`);
    writeFileSync(svg, render(i / FPS));
    execFileSync('magick', [`svg:${svg}`, `png32:${join(temp, `frame-${String(i).padStart(3, '0')}.png`)}`], { stdio: 'pipe' });
  }
  // Palette is sampled from the actual frames; gifs loop seamlessly through the hold.
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(FPS),
    '-i', join(temp, 'frame-%03d.png'), '-vf', 'palettegen=stats_mode=full',
    join(temp, 'palette.png')]);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(FPS),
    '-i', join(temp, 'frame-%03d.png'), '-i', join(temp, 'palette.png'),
    '-lavfi', 'paletteuse=dither=sierra2_4a', '-loop', '0', join(here, 'bat-special-reference.gif')]);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(FPS),
    '-i', join(temp, 'frame-%03d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-crf', '19', '-movflags', '+faststart', join(here, 'bat-special-reference.mp4')]);
  // Two labeled rows x four chronological moments: gather / travel / return / hold.
  const frames = [7, 17, 31, 53];
  const tiles = [];
  for (const stage of [2, 3]) {
    for (const i of frames) {
      const tile = join(temp, `tile-${stage}-${i}.png`);
      execFileSync('magick', [join(temp, `frame-${String(i).padStart(3, '0')}.png`),
        '-crop', stage === 2 ? '542x424+24+82' : '542x424+594+82', '+repage', tile]);
      tiles.push(tile);
    }
  }
  const first = join(temp, 'row1.png'), second = join(temp, 'row2.png');
  execFileSync('magick', [...tiles.slice(0, 4), '+append', first]);
  execFileSync('magick', [...tiles.slice(4), '+append', second]);
  execFileSync('magick', [first, second, '-append', join(here, 'bat-special-storyboard.png')]);
  console.log('Rendered GIF, MP4 and 8-panel storyboard in', here);
} finally {
  rmSync(temp, { recursive: true, force: true });
}