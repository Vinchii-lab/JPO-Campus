// Focused movement transport.  The game still renders local movement
// immediately and the server still owns validation; this helper only prevents
// Socket.IO from replaying an old movement packet after a connection/map seam.
(function (root) {
  'use strict';

  const socketStates = new WeakMap();
  const PERIOD_MS = 50;

  function connected(socket) {
    return socket?.connected === true;
  }

  function stateFor(socket) {
    let state = socketStates.get(socket);
    if (state) return state;
    state = { sequence: 0, transports: new Set(), lifecycleBound: false };
    socketStates.set(socket, state);
    const pause = () => state.transports.forEach((transport) => transport.pause());
    const visibilityPause = () => {
      if (root.document?.hidden) pause();
    };
    // These are transport lifecycle boundaries, not gameplay state changes.
    // Each scene's callback only zeros its local velocity/accumulator.
    if (root.addEventListener) {
      root.addEventListener('blur', pause);
      root.addEventListener('visibilitychange', visibilityPause);
    }
    root.document?.addEventListener?.('visibilitychange', visibilityPause);
    socket.on?.('disconnect', pause);
    state.lifecycleBound = true;
    return state;
  }

  function locationOf(payload, explicit) {
    return typeof explicit === 'string' && explicit
      ? explicit
      : typeof payload?.location === 'string' ? payload.location
        : typeof payload?.locationId === 'string' ? payload.locationId : '';
  }

  function validSequence(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function locationMatches(payload, expectedLocation) {
    const actual = typeof payload?.location === 'string'
      ? payload.location
      : typeof payload?.locationId === 'string' ? payload.locationId : null;
    return !actual || !expectedLocation || actual === expectedLocation;
  }

  function shouldApplyCorrection(payload, expectedLocation, lastSequence = -1) {
    if (!payload || !Number.isFinite(payload.x) || !Number.isFinite(payload.y)) return false;
    if (!locationMatches(payload, expectedLocation)) return false;
    if (payload.seq !== undefined && (!validSequence(payload.seq) || payload.seq <= lastSequence)) return false;
    return true;
  }

  function shouldApplyRemote(payload, expectedLocation, lastSequence = -1) {
    if (!payload || !locationMatches(payload, expectedLocation)) return false;
    return payload.seq === undefined || (validSequence(payload.seq) && payload.seq >= lastSequence);
  }

  function create(socket, options = {}) {
    const state = stateFor(socket);
    const entry = {
      accumulator: 0,
      onPause: typeof options.onPause === 'function' ? options.onPause : () => {},
    };
    state.transports.add(entry);

    const clear = () => { entry.accumulator = 0; };
    const pause = () => {
      clear();
      entry.onPause();
    };
    entry.pause = pause;

    const envelope = (location, payload) => {
      const room = locationOf(payload, location);
      if (!room || !connected(socket)) return null;
      state.sequence += 1;
      return { ...payload, location: room, seq: state.sequence };
    };
    const send = (location, payload, reliable) => {
      const packet = envelope(location, payload);
      if (!packet) return false;
      // Special transitions/interactions are reliable, while ordinary position
      // samples are volatile and must never queue while disconnected.
      const channel = reliable ? socket : socket.volatile;
      if (!channel?.emit) return false;
      channel.emit('playerMove', packet);
      return true;
    };
    const sendEvent = (event, location, payload) => {
      const packet = envelope(location, payload);
      if (!packet || !socket.emit) return false;
      socket.emit(event, packet);
      return true;
    };

    return {
      sendReliable(location, payload) {
        return send(location, payload, true);
      },
      sendPeriodic(location, payload) {
        return send(location, payload, false);
      },
      sendReliableEvent(event, location, payload) {
        return sendEvent(event, location, payload);
      },
      tick(delta, location, payload) {
        if (!connected(socket)) {
          clear();
          return false;
        }
        entry.accumulator += Math.max(0, Number(delta) || 0);
        if (entry.accumulator < PERIOD_MS) return false;
        // Send at most one sample.  A background-tab/lag spike must not replay
        // every missed 50ms slot as a burst of stale positions.
        entry.accumulator = 0;
        return send(location, payload, false);
      },
      clear,
      pause,
      get sequence() { return state.sequence; },
      dispose() {
        clear();
        state.transports.delete(entry);
      },
    };
  }

  root.JpoFocusedMovement = { PERIOD_MS, create, shouldApplyCorrection, shouldApplyRemote };
}(window));