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
      if (panel) panel.hidden = true;
      return;
    }
    panel.hidden = false;
    panel.innerHTML = this._buildShopMarkup(ctx);
    this._attachShopHandlers(panel, ctx);
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
                 `<button type="button" data-return="${this._escape(item.id)}">Store</button></span>`;
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
        html += `<button type="button" data-return="${this._escape(item.id)}">Store</button></span>`;
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
    panel.querySelector('[data-goodbye]')?.addEventListener('click', () => ctx.onGoodbye?.());
    panel.querySelector('[data-browse]')?.addEventListener('click', () => ctx.onOpenMenu?.());
    panel.querySelector('[data-buy-menu]')?.addEventListener('click', () => ctx.onOpenMenu?.());
    panel.querySelectorAll('[data-buy]').forEach(btn => {
      btn.onclick = () => {
        if (window.confirm('Buy this item with coins?')) {
          ctx.onBuy?.(btn.dataset.buy, 'furniture');
        }
      };
    });
    panel.querySelectorAll('[data-food-buy]').forEach(btn => {
      btn.onclick = () => ctx.onBuy?.(btn.dataset.foodBuy, 'food');
    });
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
