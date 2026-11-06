---
name: Character wing flight
description: User intent for character flight and price-based speed, distinct from pet flight.
---
Characters with equipped wings should be able to fly, with flight speed based on how expensive their wings are.

**Why:** The user explicitly clarified that the backburnered flight feature is for users wearing wings, not reindeer or other pets.

**How to apply:** Plan and verify character flight separately from pet animations. The user approved the proposed implementation after choosing Spacebar: fixed catalog-based speed tiers, an explicit fastest Phoenix tier, no sale-based speed changes, takeoff/hover/landing, a grounded shadow, a touch Fly/Land button, and no flight advantage during competitive games.

Keep all existing collisions while characters fly.

**Why:** The user chose “Keep all collisions” when asked whether flight should pass over furniture.

**How to apply:** Flight must not bypass furniture, walls, doors or map boundaries. Elevation is visual; retain the ground collision body and existing map restrictions.

Wing previews must show the correct side profile at the shoulder/back anchor when the character moves sideways, not a front-facing pair surrounding the head.

**Why:** The user rejected the moving-flight concept's wing placement in side view.

**How to apply:** Inspect left and right cruise frames at visible scale before presenting motion previews; correct front-view composition alone is not sufficient.

Flight needs a clearly visible, dark ground shadow rather than a barely perceptible oval.

**Why:** The user twice requested a darker shadow because the in-game effect did not feel like flying.

**How to apply:** Judge readability on the actual snowy HQ floor, not just a plain concept background. Keep the shadow grounded and visually separated from the airborne character; do not change movement or collision behavior when adjusting its appearance.

Airborne characters must hold a relaxed pose with hands at the sides and feet hanging still, not a frozen step from the walking cycle.

**Why:** The user explicitly asked for the in-game pose to match the generated flight movement and rejected a walking-looking airborne pose.

**How to apply:** Inspect all four directions with actual equipped clothes. The wings and hover can move, but the arms and legs should not stride. Landing must restore ordinary walking.

Spacebar toggles Fly/Land during normal exploration; typing, menus and existing minigame controls take precedence.

**Why:** The user chose Spacebar after checking its current Quick Draw and Pool actions and explicitly asked to implement the agreed plan without breaking the app.

**How to apply:** Never globally consume Spacebar before checking the active UI/game state. Existing owners receive flight without repurchasing wings. Keep flight state temporary: refreshing should restore a safe grounded position.
