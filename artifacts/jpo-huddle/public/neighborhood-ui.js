// Cashier conversations live in DOM so their controls remain accessible on
// touch devices, but their position follows the Phaser world rather than the
// HUD. Keep the projection/clamping math free of Phaser and DOM concerns so it
// can be regression-tested without a browser.
window.JpoCashierSpeechBubble = (() => {
  const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

  function worldToClientPoint(point, camera, canvasRect, canvasWidth, canvasHeight) {
    if (!point || !camera || !canvasRect) return null;
    const internalWidth = finite(canvasWidth, finite(camera.width, canvasRect.width)) || canvasRect.width;
    const internalHeight = finite(canvasHeight, finite(camera.height, canvasRect.height)) || canvasRect.height;
    const scaleX = canvasRect.width / Math.max(1, internalWidth);
    const scaleY = canvasRect.height / Math.max(1, internalHeight);
    const zoom = finite(camera.zoom, 1) || 1;
    // Phaser keeps scrollX/scrollY in its unzoomed camera space while the
    // viewport origin is zoom-adjusted around originX/originY. This mirrors
    // the world-view calculation used by the scene's pooled tile renderer;
    // using scrollX directly would drift the DOM bubble toward a corner at
    // zoom levels below 1.
    const worldLeft = finite(camera.scrollX) +
      internalWidth * finite(camera.originX, 0.5) * (1 - 1 / zoom);
    const worldTop = finite(camera.scrollY) +
      internalHeight * finite(camera.originY, 0.5) * (1 - 1 / zoom);
    return {
      x: canvasRect.left + (finite(camera.x) + (finite(point.x) - worldLeft) * zoom) * scaleX,
      y: canvasRect.top + (finite(camera.y) + (finite(point.y) - worldTop) * zoom) * scaleY,
    };
  }

  function computeBubblePosition(anchor, size, viewport, options = {}) {
    if (!anchor || !size || !viewport) return null;
    const width = Math.max(1, finite(size.width, 1));
    const height = Math.max(1, finite(size.height, 1));
    const padding = Math.max(0, finite(options.padding, 12));
    const gap = Math.max(0, finite(options.gap, 10));
    const leftBound = finite(viewport.left);
    const topBound = finite(viewport.top);
    const rightBound = Math.max(leftBound, finite(viewport.right, leftBound + width));
    const bottomBound = Math.max(topBound, finite(viewport.bottom, topBound + height));
    const anchorX = finite(anchor.x);
    const anchorY = finite(anchor.y);
    const preferredLeft = anchorX - width / 2;
    const left = clamp(preferredLeft, leftBound + padding, rightBound - width - padding);
    const canPlaceAbove = !options.preferBelow &&
      anchorY - gap - height >= topBound + padding;
    const placement = canPlaceAbove ? 'bottom' : 'top';
    const preferredTop = canPlaceAbove ? anchorY - gap - height : anchorY + gap;
    const top = clamp(preferredTop, topBound + padding, bottomBound - height - padding);
    return {
      left,
      top,
      tailX: clamp(anchorX - left, 16, Math.max(16, width - 16)),
      tailY: canPlaceAbove ? height + gap : -gap,
      placement,
    };
  }

  function position(element, options = {}) {
    if (!element || !options.anchor || !options.camera || !options.canvasRect) return null;
    const canvasRect = options.canvasRect;
    const point = worldToClientPoint(
      options.anchor,
      options.camera,
      canvasRect,
      options.canvasWidth,
      options.canvasHeight,
    );
    if (!point) return null;
    const viewport = options.viewport || {
      left: 0, top: 0,
      right: document.documentElement?.clientWidth || window.innerWidth,
      bottom: 0,
    };
    if (!viewport.bottom) viewport.bottom = document.documentElement?.clientHeight || window.innerHeight;
    const canvasViewport = options.canvasViewport || {
      left: canvasRect.left, top: canvasRect.top,
      right: canvasRect.right, bottom: canvasRect.bottom,
    };
    const offscreen = point.x < canvasViewport.left - 2 ||
      point.x > canvasViewport.right + 2 ||
      point.y < canvasViewport.top - 2 ||
      point.y > canvasViewport.bottom + 2;
    if (offscreen) {
      element.hidden = true;
      element.style.visibility = 'hidden';
      return { offscreen: true, anchor: point };
    }
    // A catalog can be taller than the space above a cashier, especially on a
    // phone. Give it the larger side's available height before choosing the
    // tail direction so the scrollable bubble still has a real edge touching
    // the NPC instead of clamping over the actor with a tail pointing away.
    element.style.removeProperty('max-height');
    const scrollContent = element.querySelector('.cashier-speech-content');
    scrollContent?.style.removeProperty('max-height');
    let rect = element.getBoundingClientRect();
    const padding = Math.max(0, finite(options.padding, 12));
    const gap = Math.max(0, finite(options.gap, 10));
    const aboveSpace = Math.max(0, point.y - viewport.top - padding - gap);
    const belowSpace = Math.max(0, viewport.bottom - point.y - padding - gap);
    // Preserve the requested "above the head" composition whenever a useful
    // scroll viewport can fit there. Only use below placement when the NPC is
    // genuinely near the top edge, where even a compact conversation would
    // cover the actor.
    const preferBelow = aboveSpace < 180 && belowSpace >= aboveSpace;
    const available = preferBelow ? belowSpace : aboveSpace;
    if (rect.height > available && available > 0) {
      const contentHeight = scrollContent?.getBoundingClientRect().height || rect.height;
      const chromeHeight = Math.max(0, rect.height - contentHeight);
      if (scrollContent) {
        scrollContent.style.maxHeight = `${Math.max(80, available - chromeHeight)}px`;
      }
      rect = element.getBoundingClientRect();
    }
    const computed = computeBubblePosition(point, rect, viewport, {
      ...options, preferBelow,
    });
    if (!computed) return null;
    element.hidden = false;
    element.style.left = `${computed.left}px`;
    element.style.top = `${computed.top}px`;
    element.style.setProperty('--cashier-tail-x', `${computed.tailX}px`);
    element.dataset.tail = computed.placement;
    element.style.visibility = 'visible';
    return { ...computed, anchor: point };
  }

  return { clamp, worldToClientPoint, computeBubblePosition, position };
})();

window.JpoUIBuilder = {
  renderHomePanel: function(panel, ctx) {
    if (!ctx.isHome || !ctx.homeState) {
      if (!ctx.isResidentialBlock) {
        panel.hidden = true;
        window.jpoHouseColors?.render(panel);
        return;
      }
      panel.hidden = false;
      panel.innerHTML = this._buildOutsideMarkup(ctx);
      this._attachOutsideHandlers(panel, ctx);
      return;
    }
    
    panel.hidden = false;
    panel.innerHTML = this._buildInsideMarkup(ctx);
    this._attachInsideHandlers(panel, ctx);
  },

  renderShopPanel: function(panel, ctx) {
    if (!ctx.isShop || !ctx.cashierOpen || !ctx.cashier) {
      if (panel) {
        panel.hidden = true;
        panel.innerHTML = '';
        panel.style.visibility = 'hidden';
        panel.removeAttribute('data-tail');
      }
      return;
    }
    panel.hidden = false;
    panel.className = 'cashier-speech-bubble';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', `${ctx.cashier.name || 'Cashier'} conversation`);
    panel.style.visibility = 'hidden';
    panel.innerHTML = `<div class="cashier-speech-content">${this._buildShopMarkup(ctx)}</div>`;
    this._attachShopHandlers(panel, ctx);
    ctx.positionBubble?.();
  },

  _buildOutsideMarkup: function(ctx) {
    const homes = ctx.directory || [];
    let html = '<div class="home-panel-head"><b>Willow Walk</b><button type="button" data-collapse>Hide</button></div>';
    html += '<div class="home-section home-directory"><small>' + homes.length + ' approved homes</small>';
    html += homes.length ? homes.map(h => '<span class="home-directory-item"><small>Lot ' + h.lotIndex + ' &middot; </small>' + this._escape(h.name || h.ownerEmail) + '</span>').join('') : '<small>No homes yet.</small>';
    html += '</div>';
    
    if (ctx.constructionMarkup) html += ctx.constructionMarkup;
    
    if (ctx.homeState?.canEdit) {
      html += '<div class="home-section"><small>Your fenced yard</small>';
      
      const inventory = ctx.homeState.inventory || [];
      if (inventory.length) {
        html += inventory.map(item => {
          const name = ctx.catalog?.[item.furnitureId]?.name || item.furnitureId;
          return `<span class="home-item ${ctx.selectedInstance === item.id ? 'selected' : ''}">` +
                 `<span>${this._escape(name)}</span>` +
                 `<button type="button" data-yard-select="${this._escape(item.id)}">Place outside</button></span>`;
        }).join('');
      } else {
        html += '<small>No unplaced furniture.</small>';
      }
      
      const yard = ctx.homeState.yard || [];
      if (yard.length) {
        html += '<small>Yard items</small>';
        html += yard.map(item => {
          const name = ctx.catalog?.[item.furnitureId]?.name || item.furnitureId;
          return `<span class="home-item"><span>${this._escape(name)}</span>` +
                 `<button type="button" data-yard-move="${this._escape(item.id)}">Move</button>` +
                 `<button type="button" data-return="${this._escape(item.id)}"${ctx.pendingReturns?.has(String(item.id)) ? ' disabled' : ''}>` +
                 `${ctx.pendingReturns?.has(String(item.id)) ? 'Storing…' : 'Store'}</button></span>`;
        }).join('');
      }
      html += '</div>';
    }
    
    html += '<small class="home-panel-note">Walk to a lit front door to visit.</small>';
    return html;
  },

  _attachOutsideHandlers: function(panel, ctx) {
    panel.querySelector('[data-collapse]')?.addEventListener('click', () => { panel.hidden = true; });
    
    // Directory toggle logic
    const directoryBody = panel.querySelector('.home-directory');
    const directoryNote = panel.querySelector('.home-panel-note');
    const toggleDirectory = panel.querySelector('[data-collapse]');
    if (directoryBody && toggleDirectory && directoryNote) {
      directoryBody.hidden = true;
      directoryNote.hidden = true;
      toggleDirectory.textContent = 'Open';
      toggleDirectory.onclick = () => {
        directoryBody.hidden = !directoryBody.hidden;
        directoryNote.hidden = directoryBody.hidden;
        toggleDirectory.textContent = directoryBody.hidden ? 'Open' : 'Close';
        if (typeof ctx.scheduleHudReservation === 'function') ctx.scheduleHudReservation();
      };
    }

    panel.querySelectorAll('[data-yard-select]').forEach(btn => {
      btn.onclick = () => ctx.onSelect?.(btn.dataset.yardSelect, 'yard');
    });
    panel.querySelectorAll('[data-yard-move]').forEach(btn => {
      btn.onclick = () => ctx.onSelect?.(btn.dataset.yardMove, 'yard');
    });
    panel.querySelectorAll('[data-return]').forEach(btn => {
      btn.onclick = () => ctx.onReturn?.(btn.dataset.return);
    });
    panel.querySelectorAll('[data-build]').forEach(btn => {
      btn.onclick = () => {
        if (window.confirm('Build this component with coins?')) {
          ctx.onBuild?.(btn.dataset.build);
        }
      };
    });
    window.jpoHouseColors?.render(panel);
  },

  _buildInsideMarkup: function(ctx) {
    const canEdit = ctx.homeState.canEdit;
    let html = '<div class="home-panel-head"><b>' + (canEdit ? 'Your starter home' : 'Visiting a home') + '</b>';
    html += '<button type="button" data-collapse>' + (ctx.editorOpen ? 'Collapse' : 'Open panel') + '</button></div>';

    // Directory
    const homes = ctx.directory || [];
    let dirHtml = homes.length ? homes.map(h => '<span class="home-directory-item">' + this._escape(h.name || h.ownerEmail) + ' <small>(' + this._escape(h.accessMode) + ')</small></span>').join('') : '<small>No homes.</small>';
    html += '<details class="home-section"><summary>Willow Walk neighbors</summary><div class="home-directory">' + dirHtml + '</div></details>';

    if (!ctx.editorOpen) {
      if (canEdit) html += '<small class="home-panel-note">Open panel to place, store, or manage your home.</small>';
      return html;
    }

    if (!canEdit) {
      html += '<div class="home-section"><small>The owner controls this room.</small></div>';
      return html;
    }

    // Editor controls
    html += '<div class="home-section home-editor-controls">';
    
    // Access dropdown
    html += '<label>Access <select id="home-access">';
    html += '<option value="private">Only me</option>';
    html += '<option value="invite_only">Selected people</option>';
    html += '<option value="public">All approved players</option>';
    html += '</select></label>';
    html += '<button type="button" data-access style="margin-left: 5px;">Save</button>';

    // People picker for invites (shown if invite_only). The list is an
    // owner-only server projection; it is intentionally not inferred from the
    // office roster cache.
    html += '<div id="home-invite-section" style="display:none; margin-top: 8px;">';
    html += '<div style="display:flex; gap:5px;"><input id="home-invite-search" type="text" placeholder="Search people..."><button type="button" id="home-invite-btn">Invite</button></div>';
    html += '<div id="home-invite-results" style="max-height:100px; overflow-y:auto; background:#111e2b; margin-top:4px;"></div>';
    
    if (ctx.homeState.invitations?.length) {
      html += '<small>Invited</small>';
      html += ctx.homeState.invitations.map(inv => 
        `<span class="home-item">${this._escape(inv.name || inv.email)} <button type="button" data-revoke="${this._escape(inv.email)}">Revoke</button></span>`
      ).join('');
    }
    html += '</div>';

    html += '<hr style="border-color:#427a9b; margin:12px 0;">';
    
    // Categorized Inventory
    html += this._buildCategorizedInventory(ctx);

    html += '</div>';
    return html;
  },

  _buildCategorizedInventory: function(ctx) {
    const categories = ['Kitchen', 'Living', 'Bedroom', 'Bathroom', 'Miscellaneous'];
    const itemsByCat = {};
    categories.forEach(c => itemsByCat[c] = { inventory: [], layout: [] });

    const inv = ctx.homeState.inventory || [];
    const layout = ctx.homeState.layout || [];

    const getCat = (fId) => {
      const def = ctx.catalog?.[fId];
      const category = String(def?.category || '').trim().toLowerCase();
      const match = categories.find((candidate) => candidate.toLowerCase() === category);
      if (match) return match;
      return 'Miscellaneous';
    };

    inv.forEach(i => itemsByCat[getCat(i.furnitureId)].inventory.push(i));
    layout.forEach(i => itemsByCat[getCat(i.furnitureId)].layout.push(i));

    let html = '';
    categories.forEach(cat => {
      const catInv = itemsByCat[cat].inventory;
      const catLay = itemsByCat[cat].layout;
      if (catInv.length === 0 && catLay.length === 0) return;

      html += `<small style="margin-top:10px; color:#f5ce64;">${cat} (${catLay.length} placed, ${catInv.length} stored)</small>`;
      
      catInv.forEach(item => {
        const def = ctx.catalog?.[item.furnitureId];
        const name = def?.name || item.furnitureId;
        const sel = ctx.selectedInstance === item.id ? 'selected' : '';
        html += `<span class="home-item ${sel}" style="display:flex; justify-content:space-between;">`;
        html += `<span style="display:flex; align-items:center; gap:8px;">`;
        html += this._thumbnail(def, item.furnitureId);
        html += `<span>${this._escape(name)}</span></span>`;
        html += `<button type="button" data-select="${this._escape(item.id)}">Place</button>`;
        html += `</span>`;
      });
      
      catLay.forEach(item => {
        const def = ctx.catalog?.[item.furnitureId];
        const name = def?.name || item.furnitureId;
        const sel = ctx.selectedInstance === item.id ? 'selected' : '';
        html += `<span class="home-item ${sel}" style="display:flex; justify-content:space-between;">`;
        html += `<span style="display:flex; align-items:center; gap:8px;">`;
        html += this._thumbnail(def, item.furnitureId);
        html += `<span>${this._escape(name)}</span></span>`;
        html += `<span><button type="button" data-move="${this._escape(item.id)}">Move</button> `;
        html += `<button type="button" data-return="${this._escape(item.id)}"${ctx.pendingReturns?.has(String(item.id)) ? ' disabled' : ''}>` +
          `${ctx.pendingReturns?.has(String(item.id)) ? 'Storing…' : 'Store'}</button></span>`;
        html += `</span>`;
      });
    });

    if (!html) html = '<small>No furniture owned yet.</small>';
    return html;
  },

  _attachInsideHandlers: function(panel, ctx) {
    panel.querySelector('[data-collapse]')?.addEventListener('click', () => {
      if (typeof ctx.toggleEditor === 'function') ctx.toggleEditor();
    });

    panel.querySelectorAll('[data-select]').forEach(btn => {
      btn.onclick = () => ctx.onSelect?.(btn.dataset.select, 'indoor');
    });
    panel.querySelectorAll('[data-move]').forEach(btn => {
      btn.onclick = () => ctx.onSelect?.(btn.dataset.move, 'indoor');
    });
    panel.querySelectorAll('[data-return]').forEach(btn => {
      btn.onclick = () => ctx.onReturn?.(btn.dataset.return);
    });

    const access = panel.querySelector('#home-access');
    if (access) {
      access.value = ctx.homeState.accessMode || 'public';
      const inviteSection = panel.querySelector('#home-invite-section');
      
      const updateInviteVisibility = () => {
        inviteSection.style.display = access.value === 'invite_only' ? 'block' : 'none';
      };
      updateInviteVisibility();
      access.addEventListener('change', updateInviteVisibility);

      panel.querySelector('[data-access]')?.addEventListener('click', () => {
        ctx.onAccessSet?.(access.value);
      });

      // People Picker logic
      const searchInput = panel.querySelector('#home-invite-search');
      const resultsDiv = panel.querySelector('#home-invite-results');
      let selectedEmail = '';

      const people = Array.isArray(ctx.people) ? ctx.people : [];
      const requestPeople = () => {
        if (!ctx.peopleLoaded && typeof ctx.onPeopleRequest === 'function') ctx.onPeopleRequest();
      };
      const renderPeople = () => {
        if (!searchInput || !resultsDiv) return;
        const q = searchInput.value.toLowerCase().trim();
        if (!q) {
          resultsDiv.innerHTML = '';
          return;
        }
        const matches = people.filter((person) => {
          const email = person.accountIdentifier || person.email || '';
          const name = person.displayName || person.name || person.fullName || '';
          return [email, name].some((value) => String(value).toLowerCase().includes(q));
        }).slice(0, 8);
        resultsDiv.innerHTML = matches.map((person) => {
          const email = person.accountIdentifier || person.email || '';
          const name = person.displayName || person.name || person.fullName || email;
          return `<div class="invite-result-item" data-email="${this._escape(email)}" style="padding:4px; cursor:pointer; border-bottom:1px solid #427a9b;">${this._escape(name)} <small>${this._escape(email)}</small></div>`;
        }).join('') || '<small style="display:block;padding:4px;">No approved people found.</small>';
        resultsDiv.querySelectorAll('.invite-result-item').forEach((item) => {
          item.onclick = () => {
            searchInput.value = item.dataset.email || '';
            selectedEmail = item.dataset.email || '';
            resultsDiv.innerHTML = '';
          };
        });
      };

      if (searchInput && resultsDiv) {
        searchInput.addEventListener('focus', requestPeople);
        searchInput.addEventListener('input', () => {
          requestPeople();
          selectedEmail = '';
          renderPeople();
        });
        requestPeople();
      }

      panel.querySelector('#home-invite-btn')?.addEventListener('click', () => {
        const email = selectedEmail || searchInput?.value?.trim();
        if (email) {
          ctx.onInvite?.(email);
          if (searchInput) searchInput.value = '';
          if (resultsDiv) resultsDiv.innerHTML = '';
          selectedEmail = '';
        }
      });

      panel.querySelectorAll('[data-revoke]').forEach(btn => {
        btn.onclick = () => ctx.onRevoke?.(btn.dataset.revoke);
      });
    }

    window.jpoHouseColors?.render(panel);
  },

  _buildShopMarkup: function(ctx) {
    const cashier = ctx.cashier;
    const menu = ctx.cashierMenu;
    const isFood = cashier.kind === 'food';
    let html = `<div class="home-panel-head"><b>${this._escape(cashier.name)} · Cashier</b><button type="button" data-goodbye>Goodbye</button></div>`;
    html += `<small class="home-panel-note">${this._escape(cashier.greeting || 'Welcome!')}</small>`;
    if (cashier.info) html += `<small class="home-panel-note">${this._escape(cashier.info)}</small>`;
    if (!menu) {
      html += '<div class="home-section cashier-options">';
      html += '<small>What would you like to do?</small>';
      html += '<button type="button" data-browse>Browse</button> ';
      html += '<button type="button" data-buy-menu>Buy</button>';
      html += '</div>';
    } else if (isFood) {
      html += `<div class="home-section"><small>${this._escape(menu.title || 'Menu')}</small>`;
      for (const item of menu.items || []) {
        html += `<span class="home-item" style="display:flex; justify-content:space-between;">`;
        html += `<span>${this._escape(item.icon || '🍽️')} ${this._escape(item.name || item.id)} &middot; ${Number(item.price || 0).toLocaleString()} coins</span>`;
        html += `<button type="button" data-food-buy="${this._escape(item.id)}">Buy</button></span>`;
      }
      if (!menu.items?.length) html += '<small>The menu is empty.</small>';
      html += '</div>';
    } else {
      const categories = ['Kitchen', 'Living', 'Bedroom', 'Bathroom', 'Miscellaneous'];
      const itemsByCat = {};
      categories.forEach(c => itemsByCat[c] = []);
      (menu.items || []).forEach(item => {
        const key = String(item?.category || '').trim().toLowerCase();
        const cat = categories.find((candidate) => candidate.toLowerCase() === key) || 'Miscellaneous';
        itemsByCat[cat].push(item);
      });
      html += '<div class="home-section">';
      let hasAny = false;
      categories.forEach(cat => {
        if (itemsByCat[cat].length > 0) {
          hasAny = true;
          html += `<small style="margin-top:10px; color:#f5ce64;">${cat}</small>`;
          itemsByCat[cat].forEach(item => {
            html += `<span class="home-item" style="display:flex; justify-content:space-between;">`;
            html += `<span style="display:flex; align-items:center; gap:8px;">`;
            html += this._thumbnail(ctx.catalog?.[item.id], item.id);
            html += `<span>${this._escape(item.name || item.id)} &middot; ${Number(item.price || 0).toLocaleString()} coins</span></span>`;
            html += `<button type="button" data-buy="${this._escape(item.id)}">Buy</button></span>`;
          });
        }
      });
      if (!hasAny) html += '<small>The catalog is empty.</small>';
      html += '</div>';
    }
    if (ctx.location === 'furniture-shop' && menu) html += this._buildShowroomMarkup(ctx);
    return html;
  },

  _buildShowroomMarkup: function(ctx) {
    const demos = Array.isArray(ctx.showroom) ? ctx.showroom : [];
    let html = '<div class="home-section showroom-section">';
    html += '<small style="margin-top:10px; color:#f5ce64;">Try before you buy</small>';
    html += '<small class="home-panel-note">Walk to a display and press [E]. Shift+[E] selects a second action when available.</small>';
    if (!demos.length) {
      html += '<small>Showroom displays are loading.</small></div>';
      return html;
    }
    for (const demo of demos) {
      const definition = ctx.catalog?.[demo.furnitureId];
      const actions = Array.isArray(demo.actions) ? demo.actions : [];
      const labels = actions.map((action) => action?.label || action?.id || action).filter(Boolean);
      html += '<span class="home-item showroom-item" style="display:flex; align-items:center; gap:8px;">';
      html += this._thumbnail(definition, demo.furnitureId);
      html += `<span>${this._escape(demo.name || definition?.name || demo.furnitureId)}<small style="display:block;">${this._escape(labels.join(' · '))}</small></span>`;
      html += '</span>';
    }
    html += '</div>';
    return html;
  },

  _attachShopHandlers: function(panel, ctx) {
    // The bubble is a real interaction surface over the canvas. Keep pointer
    // and keyboard events inside it so a touch/click cannot also pan the map or
    // trigger the scene's E action.
    if (!panel._cashierEventGuard) {
      const guard = (event) => event.stopPropagation();
      ['pointerdown', 'pointerup', 'click', 'touchstart', 'touchend'].forEach((type) => {
        panel.addEventListener(type, guard);
      });
      panel.addEventListener('keydown', (event) => {
        const key = String(event.key || '').toLowerCase();
        if (key === 'escape') {
          event.preventDefault();
          event.stopPropagation();
          ctx.onGoodbye?.();
        } else if (key === 'e') {
          event.preventDefault();
          event.stopPropagation();
        }
      });
      panel._cashierEventGuard = true;
    }
    panel.querySelector('[data-goodbye]')?.addEventListener('click', () => ctx.onGoodbye?.());
    panel.querySelector('[data-browse]')?.addEventListener('click', () => ctx.onOpenMenu?.());
    panel.querySelector('[data-buy-menu]')?.addEventListener('click', () => ctx.onOpenMenu?.());
    panel.querySelectorAll('[data-buy]').forEach(btn => {
      btn.onclick = () => this._confirmShopPurchase(panel, ctx, btn.dataset.buy, 'furniture');
    });
    panel.querySelectorAll('[data-food-buy]').forEach(btn => {
      btn.onclick = () => this._confirmShopPurchase(panel, ctx, btn.dataset.foodBuy, 'food');
    });
  },

  _confirmShopPurchase: function(panel, ctx, itemId, kind) {
    const item = ctx.cashierMenu?.items?.find(candidate => candidate.id === itemId);
    if (!item || panel.hidden) return;
    const price = Number(item.price);
    if (!Number.isFinite(price) || price < 0) return;
    panel.innerHTML = `<div class="cashier-speech-content">
      <div class="home-panel-head"><b>${this._escape(ctx.cashier.name)} · Cashier</b></div>
      <div class="home-section" role="group" aria-label="Confirm purchase">
        <p>Buy <strong>${this._escape(item.name || item.id)}</strong> for
          <strong>${price.toLocaleString()} coins</strong>?</p>
        <button type="button" data-confirm-purchase>Buy · ${price.toLocaleString()} coins</button>
        <button type="button" data-cancel-purchase>Cancel</button>
      </div>
    </div>`;
    let settled = false;
    const finish = (purchase) => {
      if (settled || panel.hidden || !panel.querySelector('[data-confirm-purchase]')) return;
      settled = true;
      this.renderShopPanel(panel, ctx);
      if (purchase) ctx.onBuy?.(itemId, kind);
    };
    panel.querySelector('[data-confirm-purchase]').onclick = () => finish(true);
    panel.querySelector('[data-cancel-purchase]').onclick = () => finish(false);
    ctx.positionBubble?.();
    // Start on the safe choice; focusing never scrolls the game viewport.
    panel.querySelector('[data-cancel-purchase]')?.focus({ preventScroll: true });
  },

  renderPlacementControls: function(container, ctx) {
    if (!ctx.active) {
      container.hidden = true;
      container.innerHTML = '';
      return;
    }
    container.hidden = false;
    container.innerHTML = `
      <div style="background:rgba(21, 36, 56, 0.95); border:2px solid #86b9d8; border-radius:8px; padding:10px; display:flex; gap:10px; pointer-events:auto; margin-bottom: 20px;">
        <button id="ghost-rotate">Rotate</button>
        <button id="ghost-confirm" ${!ctx.isValid ? 'disabled' : ''}>Confirm</button>
        <button id="ghost-cancel">Cancel</button>
        ${ctx.canReturn ? '<button id="ghost-return">Store</button>' : ''}
      </div>
      <small id="ghost-placement-status" style="display:block; color:#fff4dc; text-align:center; text-shadow:1px 1px #111;">${this._escape(ctx.placementMessage || 'Click a floor tile, then Confirm or Cancel.')}</small>
    `;
    container.querySelector('#ghost-rotate')?.addEventListener('click', () => ctx.onRotate?.());
    container.querySelector('#ghost-confirm')?.addEventListener('click', () => ctx.onConfirm?.());
    container.querySelector('#ghost-cancel')?.addEventListener('click', () => ctx.onCancel?.());
    const retBtn = container.querySelector('#ghost-return');
    if (retBtn) retBtn.onclick = () => ctx.onReturn?.();
  },

  _thumbnail: function(definition, id) {
    const path = definition?.path || definition?.assetPath || definition?.url || '';
    if (!path) return `<span class="furniture-thumb furniture-thumb-missing" data-thumb="${this._escape(id)}" aria-hidden="true">?</span>`;
    const frames = definition.frames || {};
    const width = Math.max(1, Number(frames.frameWidth) || 16);
    const height = Math.max(1, Number(frames.frameHeight) || 16);
    const count = Math.max(1, Number(frames.frameCount) || 1);
    const frame = Math.min(count - 1, Math.max(0, Number(frames.initialFrame) || 0));
    const scale = Math.min(36 / width, 42 / height);
    const w = width * scale, h = height * scale;
    // Catalog sheets are horizontal strips. Clip one authored frame rather
    // than shrinking the entire animation into an unreadable row of objects.
    return `<span class="furniture-thumb" data-thumb="${this._escape(id)}" aria-hidden="true" style="display:inline-flex;align-items:center;justify-content:center;flex:0 0 40px;width:40px;height:44px;"><span style="display:block;position:relative;overflow:hidden;width:${w}px;height:${h}px;"><img src="${this._escape(path)}" alt="" loading="lazy" draggable="false" style="position:absolute;left:${-frame*w}px;top:0;width:${w*count}px;height:${h}px;max-width:none;image-rendering:pixelated;"></span></span>`;
  },

  _escape: function(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
};
