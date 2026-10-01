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

// A correction changes the origin of client prediction. Samples already in
// flight still use the old origin and must not advance the server while the
// correction is travelling back. Otherwise the corrected client is rejected
// for moving *backwards* and the two origins can oscillate indefinitely.
// This is a transport fence, not a speed/collision allowance.
export function createMovementCorrectionFence() {
  let supported = false;
  let issued = 0;
  let required = 0;
  let location = null;
  return {
    inspect(data, currentLocation) {
      // Only call after the ordinary envelope's authoritative map check.
      // Travel/ejection owns a new anchor; an old map's fence cannot freeze it.
      if (location !== currentLocation) {
        location = currentLocation;
        required = 0;
      }
      const id = data.correctionId;
      if (id === undefined) return !supported; // pre-protocol browsers
      if (!Number.isSafeInteger(id) || id < 0 || id > issued) return false;
      supported = true;
      return id >= required;
    },
    issue(currentLocation) {
      if (!supported) return null;
      location = currentLocation;
      required = ++issued;
      return required;
    },
  };
}