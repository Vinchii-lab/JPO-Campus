---
name: JPO Huddle layered-character pipeline
description: Per-part layer PNGs replace zone-table recoloring in the client; how the split/verify/upgrade pieces fit and what diffs are expected.
---

# Layered-character pipeline (Phase 1+2 live on dev)

- Offline split: `tools/char-layer-split.cjs` (+ shared `char-layer-split-lib.cjs`, mirrors the client zone tables) partitions all 16 sheets (4 chars × run/sit/sit2/sit3) into `public/assets/layers/{Char}_{suffix}_{body|skin|hair|shirt|pants}.png`; recomposite is byte-identical. Run tools with `NODE_PATH=.agents/tools/node_modules` (pngjs).
- Client (`public/index.html`, "Layered-character renderer" block): `_layeredSwaps` tints only the owning layer's pixels (hair fill vs outline re-classified via `_hairIsOutline`, same rules as the splitter). Four call sites (`_redrawPreview`, `_redrawWardrobePreview`, `_buildPlayerTex` run + sit) prefer layers, falling back to legacy `_applySwaps` until images load. Body layer is never loaded client-side (pixels in no layer are untouched).
- **Load-race rule:** a Phaser texture cached from the legacy fallback would keep the bleed forever — fallback builds are recorded in `_legacyTexBuilds` and repainted IN PLACE (canvas redraw + `texture.refresh()`, sprites keep bindings) when the last layer image settles.
- **Expected legacy-vs-layered diffs are Amelia-only** (real palettes): flowing right-side hair strands now always follow hair color, plaid stays shirt, and old cross-zone bleed (clothes repainting hands, skin tinting hair highlights) is gone. Adam/Alex/Bob are pixel-identical. Treat those diff categories as accepted, not regressions.
- Acceptance tooling: offline `tools/char-layer-verify.cjs`; in-browser diff harness `/tmp/jpotest/layers_test.cjs` (recreate from this note if wiped).
- Phase 3 (pending): cosmetics as layer REPLACEMENTS (e.g. raincoat swaps the shirt layer per frame) instead of overlay sprites.
