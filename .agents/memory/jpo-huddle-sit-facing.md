---
name: JPO Huddle seated "facing right" reports
description: Why recurring "character faces right when sitting at a desk" reports usually aren't a facing-resolution bug.
---

# Seated "facing right" at a desk is (almost always) the down-sit ART, not the facing resolution

Desk/workstation chairs (Furniture GID 606) resolve their seated facing to **`down`** via `SEAT_FACING`,
and that resolution has been verified correct at runtime — even when the player walks in from the right
(forced `lastDir='right'` + sit still yields `resolvedFacing=down, lastDir=down`). There is no code path
that produces `right` for a 606 seat (conference chairs are the only lastDir-fallback seats, and there are
zero orphan conference chairs in the map).

**Why it still *looks* like "facing right":** the `down` sit sheet (`*_sit3_16x16.png`, played via
`SIT_SUFFIX.down='sit3'`) is a **head-bowed-toward-the-desk** pose whose head/eye lean down-and-slightly-right
in every frame. At normal game zoom (low effective resolution) that read easily as a right profile. It is
visually distinct from the true right profile (`*_sit_16x16.png`), which is a full sideways head turn.

**Why:** this exact "sitting faces right" symptom has been reported/‷fixed‴ many times. The fixes that
mattered were all facing-*resolution* fixes (which seat faces which way). Once resolution is correct, further
identical reports are most likely reacting to the down-pose head-tilt (an ART matter), NOT a resolution bug.

**How to apply:** before touching `SEAT_FACING` / sit-resolution again, first confirm at runtime what facing
actually resolves to (a temporary URL-gated debug hook that seats an avatar and logs `resolvedFacing`/`lastDir`
is the fastest oracle — the low-res user screenshot is NOT a reliable oracle). If it already resolves to
`down`, the fix (if any) belongs in the `sit3` art, not the resolution code — and regenerating seated sheets
is high-risk (see jpo-huddle-palette.md / the `_sitZones` + `SIT_ANATOMY` constraints), so confirm intent first.
