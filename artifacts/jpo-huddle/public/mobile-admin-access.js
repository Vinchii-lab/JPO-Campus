(function () {
  'use strict';

  // The gesture only opens the existing unlock flow. Authorization remains
  // entirely with the normal server-side adminAuth handler.
  function bind({ target, ready, open, holdMs = 2000 }) {
    let press = null, timer = null, suppressUntil = 0;
    const pointers = new Set();
    function cancel() {
      clearTimeout(timer);
      timer = null;
      press = null;
    }
    function down(event) {
      pointers.add(event.pointerId);
      if (pointers.size > 1) cancel();
    }
    function begin(event) {
      if (!['touch', 'pen'].includes(event.pointerType) || event.button !== 0 ||
          event.isPrimary === false || pointers.size !== 1 || !ready()) return;
      cancel();
      press = { id: event.pointerId, x: event.clientX, y: event.clientY };
      timer = setTimeout(() => {
        timer = null;
        if (!press || !ready() || document.hidden) { cancel(); return; }
        suppressUntil = Date.now() + 1000;
        cancel();
        open();
      }, holdMs);
    }
    function move(event) {
      if (press && event.pointerId === press.id &&
          Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) cancel();
    }
    function end(event) {
      pointers.delete(event.pointerId);
      if (press && press.id === event.pointerId) cancel();
    }
    function interrupt() { pointers.clear(); cancel(); }
    function scroll(event) {
      // A busy chat feed can scroll itself while someone holds the HUD.
      // Only scrolling the page or this target's ancestors interrupts it.
      const scroller = event.target;
      if (!scroller || scroller === document || scroller === window ||
          scroller === document.scrollingElement || scroller.contains?.(target)) cancel();
    }
    function context(event) {
      if (press || Date.now() < suppressUntil) event.preventDefault();
    }
    document.addEventListener('pointerdown', down, { capture: true, passive: true });
    target.addEventListener('pointerdown', begin, { passive: true });
    document.addEventListener('pointermove', move, { capture: true, passive: true });
    document.addEventListener('pointerup', end, { capture: true, passive: true });
    document.addEventListener('pointercancel', end, { capture: true, passive: true });
    document.addEventListener('scroll', scroll, { capture: true, passive: true });
    document.addEventListener('visibilitychange', interrupt);
    window.addEventListener('blur', interrupt);
    window.addEventListener('pagehide', interrupt);
    target.addEventListener('contextmenu', context);
    return () => {
      interrupt();
      document.removeEventListener('pointerdown', down, true);
      target.removeEventListener('pointerdown', begin);
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', end, true);
      document.removeEventListener('pointercancel', end, true);
      document.removeEventListener('scroll', scroll, true);
      document.removeEventListener('visibilitychange', interrupt);
      window.removeEventListener('blur', interrupt);
      window.removeEventListener('pagehide', interrupt);
      target.removeEventListener('contextmenu', context);
    };
  }

  function fitViewport() {
    const viewport = window.visualViewport;
    const update = () => {
      for (const id of ['owner-panel', 'owner-pwd-modal']) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.style.setProperty('--admin-vv-height', `${viewport?.height || window.innerHeight}px`);
        el.style.setProperty('--admin-vv-width', `${viewport?.width || window.innerWidth}px`);
        el.style.setProperty('--admin-vv-top', `${viewport?.offsetTop || 0}px`);
        el.style.setProperty('--admin-vv-left', `${viewport?.offsetLeft || 0}px`);
      }
    };
    window.addEventListener('resize', update);
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    update();
    // Give wide registration/roster tables their own horizontal scroll area;
    // they must never push the panel or its Close button outside the viewport.
    document.querySelectorAll('#owner-panel .owner-table').forEach(table => {
      if (table.parentElement.classList.contains('owner-table-scroll')) return;
      const wrapper = document.createElement('div');
      wrapper.className = 'owner-table-scroll';
      table.parentNode.insertBefore(wrapper, table);
      wrapper.appendChild(table);
    });
  }
  window.JpoMobileAdmin = { bind, fitViewport };
})();
