import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const code = fs.readFileSync(new URL('../public/flight-pose.js', import.meta.url), 'utf8');
const data = fs.readFileSync(new URL('../public/flight-pose-data.js', import.meta.url), 'utf8');

test('flight anatomy uses the composed outfit, preserves upper body, and rebuilds after recoloring', () => {
  const native = new Uint8ClampedArray(384 * 32 * 4);
  for (let i=0; i<native.length/4; i++) native.set([i%256,Math.floor(i/256),i%11,255],i*4);
  const original = native.slice();
  const source = { getSourceImage: () => ({width:384,height:32,pixels:native}) };
  const textures = new Map([['dressed',source]]);
  const scene = { textures: {
    get: key => textures.get(key), exists: key => textures.has(key),
    remove: key => textures.delete(key),
    addSpriteSheet: (key, canvas) => textures.set(key, {image:canvas.pixels}),
  }};
  const window = {};
  vm.runInNewContext(data + code, { window, document: { createElement: () => {
    const canvas = {};
    let pixels;
    canvas.getContext = () => ({
      drawImage: image => {pixels=image.pixels.slice();},
      getImageData: () => ({data:pixels.slice()}),
      putImageData: image => {canvas.pixels=image.data;},
    });
    return canvas;
  }}});
  let key;
  for(const dir of ['right','up','left','down']) {
    const pose = window.JpoFlightPose.resolve(scene,'dressed',dir);
    key ||= pose.key;
    assert.equal(pose.key,key);
    const spec = window.JpoFlightPoseData[dir];
    assert.equal(pose.frame,spec.frame);
    const out = textures.get(key).image;
    for(let y=0;y<22;y++) for(let x=0;x<16;x++) {
      const i=(y*384+spec.frame*16+x)*4;
      assert.deepEqual(out.slice(i,i+4),native.slice(i,i+4));
    }
    for(let i=0;i<160;i++) {
      const dst=((22+Math.floor(i/16))*384+spec.frame*16+i%16)*4;
      const src=spec.pixels[i];
      assert.deepEqual(out.slice(dst,dst+4),src<0?new Uint8ClampedArray(4):native.slice(src*4,src*4+4));
    }
  }
  assert.deepEqual(native,original,'walking texture must remain unchanged');
  source._jpoPoseRevision=1;
  const rebuilt=window.JpoFlightPose.resolve(scene,'dressed','right');
  assert.notEqual(rebuilt.key,key);
  assert.equal(textures.has(key),false);
});
