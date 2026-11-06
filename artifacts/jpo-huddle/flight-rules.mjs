// Stable catalog tiers, independent of flash sales and owner price overrides.
// Gift-only Phoenix has an explicit tier instead of its zero purchase price.
export const WING_FLIGHT_SPEEDS = Object.freeze({
  fairywings: 1.15, beewings: 1.25, batwings: 1.35,
  butterflywings: 1.45, snowflakewings: 1.55,
  angelwings: 1.65, devilwings: 1.65, jetpackwings: 1.85,
  goldenwings: 2, phoenixwings: 2.1,
});

export function ownedWingFlightSpeed(p) {
  return p && Array.isArray(p.cosmetics) && p.cosmetics.includes(p.wings)
    && Object.hasOwn(WING_FLIGHT_SPEEDS, p.wings)
    ? WING_FLIGHT_SPEEDS[p.wings] : 1;
}

export function flightDeniedReason(p, { competitive = false, privateRoom = false, exercising = false } = {}) {
  if (!p) return "Join the office before flying.";
  if (competitive) return "Flight is disabled during games.";
  if (privateRoom) return "Land before entering a home.";
  if (p.activity || exercising) return "Finish your activity before flying.";
  if (p.anim === "sit") return "Stand up before taking off.";
  if (ownedWingFlightSpeed(p) === 1) return "Equip wings you own to fly.";
  return null;
}
