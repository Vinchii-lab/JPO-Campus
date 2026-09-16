(function installInventoryScope(global) {
  'use strict';

  // These are server location ids, not scene keys. `office` is JPO HQ;
  // `neighborhood` is Willow Walk; `city` is Huddle Plaza. Homes use
  // `home:<owner email>` and the yard is rendered on Willow Walk.
  const HQ_LOCATION_ID = 'office';
  const HQ_CATEGORIES = Object.freeze(['all', 'wearables', 'pets', 'usables', 'furniture']);
  const NEIGHBORHOOD_CATEGORIES = Object.freeze(['furniture']);

  function scopeForLocation(location) {
    // Unknown/missing location must keep the established HQ behavior rather
    // than hiding a collection during initial client boot. Every
    // server-confirmed non-office location is part of the neighborhood map
    // surface, including homes, yards, Plaza and commercial interiors.
    if (typeof location !== 'string' || !location.trim()) return 'hq';
    return location.trim() === HQ_LOCATION_ID ? 'hq' : 'neighborhood';
  }

  function categoriesForScope(scope) {
    return scope === 'neighborhood' ? NEIGHBORHOOD_CATEGORIES : HQ_CATEGORIES;
  }

  function normalizeCategory(category, scope) {
    return categoriesForScope(scope).includes(category)
      ? category
      : categoriesForScope(scope)[0];
  }

  global.JpoInventoryScope = Object.freeze({
    HQ_LOCATION_ID,
    scopeForLocation,
    categoriesForScope,
    normalizeCategory,
  });
})(window);