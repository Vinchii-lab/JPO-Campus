// UTC keeps server deployments independent of host timezone. The release
// Christmas launches early in 2026 only; normal calendars resume afterward.
export const CHRISTMAS_RELEASE_START = Date.parse("2026-10-27T00:00:00Z");
export const CHRISTMAS_RELEASE_END = Date.parse("2026-12-27T00:00:00Z");
export const HALLOWEEN_RELEASE_END = CHRISTMAS_RELEASE_START;
export const HALLOWEEN_RELEASE_START = Date.parse("2026-09-29T00:00:00Z");
export function seasonNow(d = new Date(), enabled = process.env.HALLOWEEN_RELEASE_ENABLED !== "false") {
  if (d.getTime() >= CHRISTMAS_RELEASE_START && d.getTime() < CHRISTMAS_RELEASE_END) return "christmas";
  if (enabled && d.getTime() >= HALLOWEEN_RELEASE_START && d.getTime() < HALLOWEEN_RELEASE_END) return "halloween";
  const m = d.getUTCMonth(), day = d.getUTCDate();
  if (m === 7 || m === 8 || (m === 9 && day <= 9)) return "rainy";
  if ((m === 9 && day >= 10) || (m === 10 && day <= 4)) return "halloween";
  if ((m === 10 && day >= 5) || (m === 11 && day <= 26)) return "christmas";
  if ((m === 11 && day >= 27) || (m === 0 && day <= 15)) return "newyears";
  if ((m === 0 && day >= 16) || (m === 1 && day <= 16)) return "valentines";
  return null;
}
export const SEASONAL_ITEMS = { raincoat: "rainy", umbrella: "rainy", rainboots: "rainy", witchhat: "halloween", pumpkinhead: "halloween", vampirecape: "halloween",
  santahat: "christmas", reindeerantlers: "christmas", christmasscarf: "christmas", christmassweater: "christmas", elfoutfit: "christmas", snowflakewings: "christmas" };
export const SEASONAL_PETS = { pet_frog: "rainy", pet_bat: "halloween", pet_reindeer: "christmas" };
export function canIssueItem(id, d = new Date(), enabled) {
  if (id === "pet_frog") return false; // Shelved, not deleted; transfers are not issuance.
  const season = SEASONAL_ITEMS[id] || SEASONAL_PETS[id];
  return !season || season === seasonNow(d, enabled);
}