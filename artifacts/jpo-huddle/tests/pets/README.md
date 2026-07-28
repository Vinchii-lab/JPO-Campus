# Pet accessories regression tests

Buyable emoji accessories (bow/bell/scarf/shades/top hat/crown, `petacc_` ids)
drawn ON the active pet — one worn slot (`jpo_players.equipped_pet_acc`,
`''` = bare pet), ownership shared with the `cosmetics` array, buy auto-equips.

Both scripts run against the LIVE dev server + dev database, seed throwaway
`petacc-*` / `browacc-*` players with fresh random emails, and clean up.

## Run

```bash
cd artifacts/jpo-huddle
TEST_PORT=<port> node tests/pets/petacc.mjs          # headless socket: buy/equip/broadcast/rejections/restore
TEST_PORT=<port> node tests/pets/browser-petacc.cjs  # puppeteer: overlay renders, tracks, flips, dies with pet
```

Get `<port>` from the `artifacts/jpo-huddle: web` boot log ("running on port
NNNNN"). Both scripts print per-check ✓/✗ and end with `RESULT: PASS|FAIL` —
assert on that line, not the exit banner.

## Traps (learned the hard way — see .agents/memory)

- Space runs ≥12 s apart or use fresh emails: the disconnect grace window
  resumes in-memory sessions and skips the DB restore path.
- The buy throttle burns tokens even on rejected attempts — the scripts pace
  shop emits ~700 ms apart.
- Coin assertions leave slack for the +2/min presence tick; seeding
  `last_daily_bonus = CURRENT_DATE` keeps the +10 login bonus out of the math.
- Headless chromium here has no color-emoji font, so accessory glyphs
  screenshot as tofu boxes (□) — position/flip checks are done numerically in
  page context; real browsers render the emoji fine.
