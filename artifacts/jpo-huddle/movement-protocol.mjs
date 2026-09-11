// Transport-only movement envelope checks.  Location and sequence are
// deliberately checked before any physics validation or correction so a packet
// from a previous map (or an older queued packet) cannot move the active map's
// player backwards.
export function inspectMovementEnvelope(data, currentLocation, lastSequence = 0) {
  if (!data || typeof data !== "object") {
    return { ignore: true, reason: "invalid-envelope" };
  }

  const hasLocation = Object.prototype.hasOwnProperty.call(data, "location") ||
    Object.prototype.hasOwnProperty.call(data, "locationId");
  const location = typeof data.location === "string"
    ? data.location
    : typeof data.locationId === "string" ? data.locationId : null;
  // Missing location remains valid for older clients.  Once a client sends the
  // field, however, it must name the room in which the socket currently lives.
  if (hasLocation && location !== currentLocation) {
    return { ignore: true, reason: "wrong-location", location, hasLocation: true };
  }

  const hasSequence = Object.prototype.hasOwnProperty.call(data, "seq");
  const sequence = hasSequence ? data.seq : null;
  // Missing seq remains valid for older clients.  A present sequence is strict:
  // accepting a string/float/negative value would make the ordering gate
  // ambiguous and would re-open the stale-packet seam.
  if (hasSequence && (!Number.isSafeInteger(sequence) || sequence < 0)) {
    return { ignore: true, reason: "invalid-sequence", location, hasLocation, hasSequence };
  }
  if (hasSequence && sequence <= lastSequence) {
    return { ignore: true, reason: "outdated-sequence", location, hasLocation, hasSequence, sequence };
  }
  return {
    ignore: false,
    location,
    hasLocation,
    hasSequence,
    sequence,
  };
}