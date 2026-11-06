---
name: Character wing flight
description: User intent for character flight and price-based speed, distinct from pet flight.
---
Characters with equipped wings should be able to fly, with flight speed based on how expensive their wings are.

**Why:** The user explicitly clarified that the backburnered flight feature is for users wearing wings, not reindeer or other pets.

**How to apply:** Plan and verify character flight separately from pet animations. Controls, speed multipliers, rare-wing treatment and price-change behavior still require agreement; do not treat draft recommendations as approved.

Keep all existing collisions while characters fly.

**Why:** The user chose “Keep all collisions” when asked whether flight should pass over furniture.

**How to apply:** Flight must not bypass furniture, walls, doors or map boundaries. Elevation is visual; retain the ground collision body and existing map restrictions.

Wing previews must show the correct side profile at the shoulder/back anchor when the character moves sideways, not a front-facing pair surrounding the head.

**Why:** The user rejected the moving-flight concept's wing placement in side view.

**How to apply:** Inspect left and right cruise frames at visible scale before presenting motion previews; correct front-view composition alone is not sufficient.
