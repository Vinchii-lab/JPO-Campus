// Motion proposal only: render approved flap textures at 3x point sampling.
// Never modifies gameplay art or animation code.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'bat-sonar-'));
const fps = 24, length = 108, width = 1160, height = 550;
const fmt = n => Number(n).toFixed(1);
const clamp = n => Math.max(0, Math.min(1, n));
const smooth = n => { n = clamp(n); return n * n * (3 - 2 * n); };
const art = {};
try {
  for (const stage of [2, 3]) art[stage] = Array.from({ length: 16 }, (_, index) => {
    const png = execFileSync('magick', [
      join(dir, `../public/assets/pets/anim/bat_s${stage}_flap${index}.png`),
      '-filter', 'point', '-resize', '300%', 'png32:-',
    ], { maxBuffer: 5e6 });
    return `data:image/png;base64,${png.toString('base64')}`;
  });

  function bat(stage, x, y, t, options = {}) {
    // Wings hold open during the final charge; the body retains the original
    // source sprite's proportions and its same 64px canvas/shoulder anchors.
    const index = options.index ?? ((stage === 3 && t > .70 && t < 1.28)
      ? 0 : Math.floor(t * (stage === 2 ? 12 : 13)) % 16);
    return `<g transform="translate(${fmt(x)} ${fmt(y)}) rotate(${fmt(options.tilt || 0)})" opacity="${fmt(options.opacity ?? 1)}">
      <image x="-96" y="-96" width="192" height="192" href="${art[stage][index]}"/></g>`;
  }
  function pose(stage, t) {
    if (stage === 2) {
      const brace = smooth(t / .60);
      const release = smooth((t - 2.35) / .75);
      return { x: 170 - 12 * brace + 12 * release,
        y: 293 + 7 * brace - 7 * release + (t > 3.1 ? 3 * Math.sin(t * 7) : 0),
        tilt: -7 * brace * (1-release),
        phase: t < .65 ? '01 / INHALE + BRACE' : t < 2.35 ? '02 / THREE SONAR CALLS' :
          t < 3.15 ? '03 / ECHO RETURNS' : '04 / HOVER HOLD' };
    }
    const rise = smooth(t / .88), settle = smooth((t - 2.55) / .9);
    return { x: 865, y: 293 - 46 * rise + 46 * settle + (t > 3.5 ? 3 * Math.sin(t * 7) : 0),
      tilt: 0, phase: t < .88 ? '01 / CHARGED ASCENT' :
        t < 1.24 ? '02 / SUSPENDED HOLD' :
        t < 2.55 ? '03 / SONIC ECLIPSE' :
        t < 3.45 ? '04 / CONTROLLED SETTLE' : '05 / HOVER HOLD' };
  }
  function brightStroke(d, color, strength, thick = 8) {
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${thick + 20}" stroke-linecap="round" opacity="${fmt(strength * .11)}"/>
      <path d="${d}" fill="none" stroke="${color}" stroke-width="${thick + 9}" stroke-linecap="round" opacity="${fmt(strength * .28)}"/>
      <path d="${d}" fill="none" stroke="${color}" stroke-width="${thick}" stroke-linecap="round" opacity="${fmt(strength * .9)}"/>
      <path d="${d}" fill="none" stroke="#e6ffff" stroke-width="2.3" stroke-linecap="round" opacity="${fmt(strength * .93)}"/>`;
  }
  function semicircle(cx, cy, r) {
    return `M ${fmt(cx)} ${fmt(cy-r)} A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(cx)} ${fmt(cy+r)}`;
  }
  function callEffects(t, p) {
    let result = '', cx = p.x + 40, cy = p.y + 1;
    if (t < .85) {
      const s = smooth(t / .65);
      result += `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(5 + s * 13)}" fill="#9aeefa" opacity="${fmt(s * .22)}"/>
        <circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(2 + s * 5)}" fill="#ecffff" opacity="${fmt(s * .95)}"/>`;
    }
    for (const onset of [.85, 1.14, 1.43]) {
      const age = t - onset;
      if (age < 0 || age > 1.42) continue;
      const radius = 24 + 205 * age / 1.05;
      if (radius > 276) continue;
      const strength = Math.min(1, age / .12) * (1 - .44 * smooth((age - .72) / .7));
      result += brightStroke(semicircle(205, 300, radius),
        onset === 1.14 ? '#b8a4ff' : '#65edfa', strength, 8.4);
      // Bright call nucleus reconnects the huge expanding fronts to the mouth.
      if (age < .27) result += `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(5 + age * 24)}"
        fill="#b7faff" opacity="${fmt((1-age/.27)*.9)}"/>`;
      // Small, readable echo returns travel toward the mouth after the call.
      if (age > .76 && age < 1.4) {
        const back = 142 - (age - .76) * 145;
        result += `<path d="${semicircle(205,300,back)}" fill="none" stroke="#e2b9ff"
          stroke-width="3.5" stroke-dasharray="7 13" opacity="${fmt(.45 * (1-(age-.76)/.64))}"/>`;
      }
    }
    if (t > .8 && t < 2.5) {
      for (let i = 0; i < 14; i++) {
        const onset = .85 + (i % 3) * .29 + Math.floor(i/3) * .14;
        const age = t - onset;
        if (age < 0 || age > 1.02) continue;
        const x = 209 + 198 * age, y = 300 + Math.sin(i * 8.2) * (15 + age * 115);
        result += `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${i % 2 ? 2.4 : 3.7}"
          fill="${i % 2 ? '#d6b5ff' : '#a7fcff'}" opacity="${fmt(.8 * (1-age/1.02))}"/>`;
      }
    }
    return result;
  }
  function eclipseEffects(t, p) {
    let result = '', x = 865, y = 259;
    if (t < 1.35) {
      const s = smooth(t / .94) * (t > 1.24 ? 1 - smooth((t-1.24)/.11) : 1);
      result += `<circle cx="${x}" cy="${y}" r="${fmt(22 + 47*s)}" fill="#9984ff" opacity="${fmt(.08 + .17*s)}"/>
        <circle cx="${x}" cy="${y}" r="${fmt(11 + 21*s)}" fill="#75eaf7" opacity="${fmt(.13 + .30*s)}"/>
        <circle cx="${x}" cy="${y}" r="${fmt(5 + 11*s)}" fill="#f3ffff" opacity="${fmt(.18 + .78*s)}"/>`;
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4 + t * .7, r = 99 - 51*s;
        const px = x + Math.cos(a)*r, py = y + Math.sin(a)*r*.72;
        result += `<path d="M ${fmt(px-9)} ${fmt(py+5)} Q ${fmt(px)} ${fmt(py-10)} ${fmt(px+8)} ${fmt(py-8)}"
          fill="none" stroke="${i%2 ? '#83f3ff' : '#cf9cff'}" stroke-width="4" stroke-linecap="round"
          opacity="${fmt(.20 + .77*s)}"/>`;
      }
    }
    // Four independently propagating sonic wavefronts, crisp at the leading
    // edges, with wide colored glow. All remain local to the bat's arena.
    for (let n = 0; n < 4; n++) {
      const age = t - (1.24 + .19*n);
      if (age < 0 || age > 1.43) continue;
      const radius = 20 + 227 * smooth(age / 1.13);
      const fade = 1 - .71 * smooth((age-.58)/.85);
      const strength = Math.min(1,age/.09)*fade;
      result += brightStroke(`M ${fmt(x+radius)} ${y} A ${fmt(radius)} ${fmt(radius)} 0 1 1 ${fmt(x-radius)} ${y}
        A ${fmt(radius)} ${fmt(radius)} 0 1 1 ${fmt(x+radius)} ${y}`,
      n % 2 ? '#9cf8ff' : '#b192ff', strength, n === 0 ? 11 : 8.5);
      for (let j = 0; j < 13; j++) {
        const a = j * 2.399 + n * .9;
        const px = x + radius * Math.cos(a), py = y + radius * Math.sin(a);
        result += `<circle cx="${fmt(px)}" cy="${fmt(py)}" r="${fmt(2.2 + (j%3))}"
          fill="${n%2 ? '#c1ffff' : '#e3c6ff'}" opacity="${fmt(.7*strength)}"/>`;
      }
    }
    if (t >= 1.35 && t < 2.75) {
      const spread = 28 + 110 * smooth((t-1.35)/.9);
      const alpha = .35 * (1-smooth((t-2.12)/.65));
      // Source textures themselves are the translucent, outward-pushed echoes.
      result += bat(3, x-spread, y+20, t-.17, { opacity: alpha });
      result += bat(3, x+spread, y+17, t-.22, { opacity: alpha*.85 });
      result += bat(3, x, y-spread*.72, t-.11, { opacity: alpha*.72 });
    }
    if (t > 1.33 && t < 3.15) {
      const progress = smooth((t-1.33)/1.47);
      for (let i = 0; i < 3; i++) {
        const rx = 23 + progress * (45 + i * 44);
        result += `<ellipse cx="${x}" cy="413" rx="${fmt(rx)}" ry="${fmt(rx*.20)}"
          fill="none" stroke="${i%2 ? '#b699ff' : '#87f5fa'}"
          stroke-width="${i===0 ? 5 : 3}" opacity="${fmt((.64-i*.12)*(1-smooth((t-2.44)/.71)))}"/>`;
      }
    }
    return result;
  }
  function panel(stage, t) {
    const x = stage === 2 ? 24 : 594, p = pose(stage,t);
    const accent = stage === 2 ? '#87edff' : '#c6a4ff';
    const title = stage === 2 ? 'ADULT: ECHO CALL' : 'FINAL: SONIC ECLIPSE';
    const detail = stage === 2 ? '3 directional mouth-origin sonar fronts' : 'Charged ascent → full radial sonic release';
    const progress = t / 4.5;
    let segments = '';
    for (let i = 0; i < 32; i++) segments += `<rect x="${x+27+i*15.2}" y="465" width="9" height="5" rx="2"
      fill="${i/32 < progress ? accent : '#566273'}" opacity="${i/32 < progress ? '.95' : '.45'}"/>`;
    return `<g>
      <rect x="${x}" y="79" width="542" height="433" rx="21" fill="#202633" stroke="#5d6979" stroke-width="1.5"/>
      <rect x="${x+1}" y="80" width="540" height="79" rx="20" fill="#2b3443"/>
      <rect x="${x+1}" y="135" width="540" height="24" fill="#2b3443"/>
      <text x="${x+25}" y="111" font-size="13" font-weight="700" fill="${accent}" letter-spacing="2.5">FORM 0${stage} / ${stage === 2 ? 'DIRECTIONAL SONAR' : 'AREA SONAR'}</text>
      <text x="${x+25}" y="145" font-size="22" font-weight="700" fill="#fff" letter-spacing=".4">${title}</text>
      <rect x="${x+19}" y="170" width="504" height="274" rx="13" fill="#151e2a" stroke="#536171"/>
      <g clip-path="url(#clip${stage})">
        <line x1="${x+26}" y1="413" x2="${x+516}" y2="413" stroke="#788b9d" opacity=".25" stroke-dasharray="5 9"/>
        ${stage === 2 ? callEffects(t,p) : eclipseEffects(t,p)}
        ${bat(stage, p.x, p.y, t, { tilt:p.tilt })}
      </g>
      <text x="${x+27}" y="457" fill="#f7f4ff" font-size="13" font-weight="700" letter-spacing=".7">${p.phase}</text>
      ${segments}
      <text x="${x+27}" y="494" fill="#c5d0dc" font-size="12">${detail}</text>
    </g>`;
  }
  function frame(t) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="DejaVu Sans, sans-serif">
      <defs>
        <radialGradient id="bg"><stop stop-color="#343c4d"/><stop offset="1" stop-color="#171c26"/></radialGradient>
        <clipPath id="clip2"><rect x="43" y="170" width="504" height="274" rx="13"/></clipPath>
        <clipPath id="clip3"><rect x="613" y="170" width="504" height="274" rx="13"/></clipPath>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#bg)"/>
      <text x="25" y="37" font-size="19" font-weight="700" fill="#fff" letter-spacing="1">BAT SONAR  /  SPECIAL MOVE STUDY</text>
      <text x="25" y="62" font-size="12" fill="#b8c6d4">Original bat art · 3× nearest-neighbor · proposed motion, not gameplay</text>
      ${panel(2,t)}${panel(3,t)}
      <text x="25" y="536" font-size="11" fill="#b0c0cf">SONAR IS THE ATTACK  •  BAT REMAINS ANCHORED  •  NO CAMERA SHAKE</text>
      <text x="1032" y="536" font-size="11" fill="#b0c0cf">${fmt(t)}s / 4.5s</text>
    </svg>`;
  }
  for (let i = 0; i < length; i++) {
    const stem = join(work, `frame-${String(i).padStart(3, '0')}`);
    writeFileSync(`${stem}.svg`, frame(i/fps));
    execFileSync('magick', [`svg:${stem}.svg`, `png32:${stem}.png`], { stdio: 'pipe' });
  }
  execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-y','-framerate','24','-i',
    join(work,'frame-%03d.png'),'-vf','palettegen=stats_mode=full',join(work,'palette.png')]);
  execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-y','-framerate','24','-i',
    join(work,'frame-%03d.png'),'-i',join(work,'palette.png'),'-lavfi',
    'paletteuse=dither=sierra2_4a','-loop','0',join(dir,'bat-sonar-reference.gif')]);
  execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-y','-framerate','24','-i',
    join(work,'frame-%03d.png'),'-c:v','libx264','-pix_fmt','yuv420p',
    '-crf','18','-movflags','+faststart',join(dir,'bat-sonar-reference.mp4')]);
  // Actual peak frames are deliberately the middle two columns of each row.
  const tiles = [];
  for (const stage of [2,3]) for (const i of [12,40,50,78]) {
    const tile = join(work, `tile-${stage}-${i}.png`);
    execFileSync('magick',[join(work,`frame-${String(i).padStart(3,'0')}.png`),
      '-crop',stage === 2 ? '542x433+24+79' : '542x433+594+79','+repage',tile]);
    tiles.push(tile);
  }
  const rowA = join(work,'adult.png'), rowB = join(work,'final.png');
  execFileSync('magick',[...tiles.slice(0,4),'+append',rowA]);
  execFileSync('magick',[...tiles.slice(4),'+append',rowB]);
  execFileSync('magick',[rowA,rowB,'-append',join(dir,'bat-sonar-storyboard.png')]);
  console.log('Rendered bat sonar reference GIF, MP4 and peak-effect storyboard.');
} finally {
  rmSync(work, { recursive:true, force:true });
}