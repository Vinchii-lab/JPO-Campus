import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTOR_FOOT_RADIUS,
  CITY_COMMERCIAL_LAYOUT,
  LOCATION_GEOMETRY,
  LOCATION_PORTALS,
  LOCATIONS,
  locationBounds,
  locationSpawn,
  parseLocation,
  pointHitsRect,
  portalForTransition,
  streetCityPortalForTransition,
  streetDefinition,
  streetPortalForTransition,
  validContinuousStreetWorldMove,
  validLocationMove,
  validStreetWorldMove,
} from "../../artifacts/jpo-huddle/neighborhood.mjs";

const sparseHomes = [
  { ownerEmail: "first@example.com", name: "First", lotIndex: 1, construction: { wallsBuilt: true, complete: true } },
  { ownerEmail: "edge@example.com", name: "Edge", lotIndex: 8, construction: { wallsBuilt: true, complete: true } },
  { ownerEmail: "middle@example.com", name: "Middle", lotIndex: 9, construction: { wallsBuilt: true, complete: true } },
  { ownerEmail: "last@example.com", name: "Last", lotIndex: 17, construction: { wallsBuilt: true, complete: true } },
];

test("sparse lot indices still produce one city gate per residential block", () => {
  const street = streetDefinition(sparseHomes);
  assert.equal(street.segmentCount, 3);
  assert.equal(street.roadPortals.length, 3);
  assert.deepEqual(street.roadPortals.map((portal) => portal.segment), [0, 1, 2]);
  assert.deepEqual(street.cityPortals.map((portal) => portal.segment), [0]);
  assert.deepEqual(street.roadPortals.map((portal) => portal.spawn), [
    { x: 144, y: 480, dir: "right" },
    { x: 144, y: 480, dir: "right" },
    { x: 144, y: 480, dir: "right" },
  ]);
  for (const [segment, portal] of street.roadPortals.entries()) {
    assert.equal(portal.y, 432 + segment * 960);
    assert.equal(streetCityPortalForTransition(
      48,
      504,
      sparseHomes,
      segment,
    )?.segment, segment);
  }
});

test("road gates use the real actor radius at both map edges", () => {
  const street = streetDefinition(sparseHomes);
  for (const portal of street.roadPortals) {
    assert.equal(pointHitsRect(portal.x - ACTOR_FOOT_RADIUS + 1, portal.y + 72, portal), true);
    assert.equal(streetPortalForTransition(
      "city",
      portal.x + 48,
      portal.y + 72,
      sparseHomes,
    )?.segment, portal.segment);
  }
  assert.equal(pointHitsRect(15, 504, street.cityPortals[0]), true);
  assert.equal(streetCityPortalForTransition(48, 504, sparseHomes, 2)?.spawn.y, 504 + 2 * 960);
});

test("continuous road center remains walkable around sparse edge blocks", () => {
  const street = streetDefinition(sparseHomes);
  for (let segment = 0; segment < street.segmentCount; segment += 1) {
    const y = segment * 960 + 504;
    assert.equal(validStreetWorldMove(street, 16, y), true);
    assert.equal(validStreetWorldMove(street, 720, y), true);
    assert.equal(validStreetWorldMove(street, 1424, y), true);
    assert.equal(validStreetWorldMove(street, 720, y - 16), true);
    assert.equal(validStreetWorldMove(street, 720, y + 16), true);
  }
});

test("continuous movement rejects tunnelling through a blocker", () => {
  const street = streetDefinition([]);
  const blocker = { x: 680, y: 470, width: 80, height: 60 };
  assert.equal(validContinuousStreetWorldMove(street, 640, 504, 800, 504, [blocker]), false);
  assert.equal(validContinuousStreetWorldMove(street, 640, 400, 800, 400, [blocker]), true);
});

test("completed sparse-lot doors remain address-specific", () => {
  const street = streetDefinition(sparseHomes);
  const edge = street.lots.find((lot) => lot.ownerEmail === "edge@example.com");
  assert.ok(edge);
  const center = {
    x: edge.door.x + edge.door.width / 2,
    y: edge.door.y + edge.door.height / 2,
  };
  assert.equal(streetPortalForTransition("home:edge@example.com", center.x, center.y, sparseHomes)?.lot, 8);
  assert.equal(streetPortalForTransition("home:first@example.com", center.x, center.y, sparseHomes), null);
});

test("museum foyer and all four galleries have connected, clear exits", () => {
  assert.equal(parseLocation("museum")?.id, "museum");
  for (let room = 1; room <= 4; room += 1) {
    assert.equal(parseLocation(`museum-room-${room}`)?.id, `museum-room-${room}`);
    const foyerDoor = LOCATION_PORTALS.museum.find((portal) => portal.destination === `museum-room-${room}`);
    assert.ok(foyerDoor);
    assert.equal(foyerDoor.x + foyerDoor.width / 2, room * 192);
    const galleryPortal = portalForTransition("museum", `museum-room-${room}`, room * 192, 24);
    assert.equal(galleryPortal?.destination, `museum-room-${room}`);
    assert.deepEqual(galleryPortal?.spawn, { x: 480, y: 576, dir: "up" });
    const foyerPortal = portalForTransition(`museum-room-${room}`, "museum", 480, 684);
    assert.equal(foyerPortal?.destination, "museum");
    assert.equal(foyerPortal?.spawn.x, room * 192);
    assert.equal(validLocationMove(parseLocation(`museum-room-${room}`), 480, 576), true);
  }
  assert.deepEqual(CITY_COMMERCIAL_LAYOUT.museum.door, { x: 528, y: 1690, width: 96, height: 100 });
  assert.equal(CITY_COMMERCIAL_LAYOUT.museum.door.x + 48, 576);
  assert.equal(CITY_COMMERCIAL_LAYOUT.museum.door.y + 50, 1740);
  assert.equal(portalForTransition("city", "museum", 576, 1740)?.destination, "museum");
  assert.equal(portalForTransition("museum", "city", 480, 684)?.destination, "city");
  assert.equal(validLocationMove(parseLocation("museum"), 480, 576), true);
  assert.equal(locationBounds(parseLocation("city")).height, 1920);
  assert.deepEqual(locationSpawn(parseLocation("museum"), "city"), { x: 480, y: 576, dir: "up" });
});

test("existing venue bottom doors remain city-facing", () => {
  for (const id of ["furniture-shop", "garden-shop", "decor-shop", "cafe", "diner", "bakery", "sushi"]) {
    assert.equal(parseLocation(id)?.id, id);
    assert.equal(portalForTransition(id, "city", 480, 684)?.destination, "city");
    assert.equal(validLocationMove(parseLocation(id), 480, 576), true);
  }
  assert.equal(LOCATION_GEOMETRY.city.blockers.some((blocker) =>
    blocker.x === CITY_COMMERCIAL_LAYOUT.museum.blockers[0].x &&
    blocker.y === CITY_COMMERCIAL_LAYOUT.museum.blockers[0].y), true);
  assert.equal(LOCATIONS.city.bounds.width, 1152);
});

test("a removed residential segment returns through a current valid road", () => {
  const gate = streetCityPortalForTransition(48, 480, [], 999);
  assert.equal(gate.segment, 0);
  assert.deepEqual(gate.spawn, { x: 1248, y: 504, dir: "left" });
  assert(validStreetWorldMove(streetDefinition([]), gate.spawn.x, gate.spawn.y));
});