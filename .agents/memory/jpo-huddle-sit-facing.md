---
name: JPO Huddle seated "facing right" reports
description: How to triage recurring "character faces right when sitting at a desk" reports — usually correct-by-design, not a bug.
---

# "Faces right when sitting at a desk" — triage the SEAT TYPE first

There are two very different desk seats, and they SHOULD look different when seated. Most "faces
right" reports are the manager-desk case below, which is correct by design.

## 1. Blue manager desks → correctly face RIGHT (this is the usual culprit)
`DESK_FAMILIES` blue desks (GIDs 959/960/975/976/991/992) are a 2×3 furniture sprite with the chair
baked into the **left-middle** cell and the desk+monitor occupying the **right** column. So the seated
person faces **right, into their own desk** — `deskChairAt()` returns `facing:'right'`, `lastDir` becomes
`right`, and the client plays the `sit` sheet (`*_sit_16x16.png`) which is a **full right-side profile**.
That matches the user phrase "the whole body is turned right." **It is correct.** Blue desks live in
**HR, CEO, QA, L&D**. Green manager desks are the mirror (chair right-middle, face **left**) — Operations,
IT, CMA, Claims, Accounting.

## 2. Front-desk / workstation chairs (GID 606) → correctly face DOWN
606 chairs resolve to `down` via `SEAT_FACING` (verified at runtime even when walking in from the right:
`resolvedFacing=down, lastDir=down`). Their `down` sheet (`*_sit3_16x16.png`, a head-bowed-toward-desk
pose) leans slightly right at low zoom but is NOT a full side profile. Front Desk has only 606 chairs +
a down-facing sectional sofa — no right-facing seat exists there.

**Why this matters:** an earlier pass "fixed" the sit bug by only testing 606 chairs (down) and concluded
it was an art head-tilt. That missed that the reporter was almost certainly at a **blue manager desk**,
where the full right profile is intentional. Always establish WHICH seat the user sat in before deciding
anything is broken.

**How to apply:** ask/deduce the seat type. If it's a manager desk, right/left facing is correct (facing
their desk) — changing it (e.g. forcing all desk sitters to face the viewer) is a DESIGN choice, not a bug
fix, and looks like the avatar is turned away from its desk. If truly a resolution bug is suspected, confirm
at runtime (temporary URL-gated hook logging `resolvedFacing`/`lastDir`); the low-res screenshot is not a
reliable oracle. Any real change to seated ART is high-risk — see jpo-huddle-palette.md (`_sitZones` /
`SIT_ANATOMY`).
