(function() {
  let socket, getGlobals;
  let hotbarEl, toggleBtn, contentEl;
  let furnitureInventory = [];
  let furnitureCatalog = {};
  let isOpen = false;
  let isLoading = false;
  let isError = false;
  let errorMessage = '';
  let isStale = false;
  let requestIdCounter = 0;
  let activeRequestId = 0;
  let lastOwnerEmail = null;
  let lastRevision = -1;
  let refreshQueued = false;
  let requestTimeout = null;
  let selectedCategory = 'all'; // HQ: all/wearables/pets/usables/furniture; neighborhood: furniture
  let currentLocation = 'office';

  const CATEGORIES = [
    { id: 'all', icon: '🎒', label: 'All' },
    { id: 'wearables', icon: '🎩', label: 'Wearables' },
    { id: 'pets', icon: '🐶', label: 'Pets' },
    { id: 'usables', icon: '🍕', label: 'Usables' },
    { id: 'furniture', icon: '🛋️', label: 'Furniture' }
  ];

  const categoryById = Object.freeze(Object.fromEntries(CATEGORIES.map(category => [category.id, category])));
  const inventoryScope = () => window.JpoInventoryScope?.scopeForLocation?.(currentLocation) || 'hq';
  const visibleCategories = () => {
    const ids = window.JpoInventoryScope?.categoriesForScope?.(inventoryScope()) || CATEGORIES.map(category => category.id);
    return ids.map(id => categoryById[id]).filter(Boolean);
  };
  const normalizeSelectedCategory = () => {
    const fallback = visibleCategories()[0]?.id || 'furniture';
    selectedCategory = window.JpoInventoryScope?.normalizeCategory?.(selectedCategory, inventoryScope()) || fallback;
  };
  const setLocation = (location) => {
    if (typeof location !== 'string' || !location.trim()) return;
    const nextLocation = location.trim();
    const previousScope = inventoryScope();
    currentLocation = nextLocation;
    // A category that exists only at HQ must never survive navigation into
    // Willow Walk, Huddle Plaza, a home, or its yard.
    const nextScope = inventoryScope();
    const previousCategory = selectedCategory;
    // Returning to HQ restores the established complete-collection entry
    // point. Staying in HQ preserves a deliberate tab choice.
    if (previousScope !== nextScope && nextScope === 'hq') selectedCategory = 'all';
    else normalizeSelectedCategory();
    if (previousScope !== nextScope || previousCategory !== selectedCategory) selectedItem = null;
    if (isOpen) render();
  };

  let selectedItem = null;

  function _escape(str) {
    return String(str ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  function _getThumbnail(definition, id) {
    const path = definition?.path || definition?.assetPath || definition?.url || '';
    if (!path) return `<div class="hotbar-item-icon">🛋️</div>`;
    const frames = definition.frames || {};
    const width = Math.max(1, Number(frames.frameWidth) || 16);
    const height = Math.max(1, Number(frames.frameHeight) || 16);
    const count = Math.max(1, Number(frames.frameCount) || 1);
    const frame = Math.max(0, Math.min(count - 1, Number(frames.thumbnailFrame) || 0));
    const maxDim = Math.max(width, height);
    const scale = maxDim > 24 ? 24 / maxDim : 1;
    const w = width * scale, h = height * scale;
    return `<div class="hotbar-item-icon" style="display:flex;align-items:center;justify-content:center;">
      <span style="display:block;position:relative;overflow:hidden;width:${w}px;height:${h}px;">
        <img src="${_escape(path)}" alt="" loading="lazy" draggable="false" style="position:absolute;left:${-frame*w}px;top:0;width:${w*count}px;height:${h}px;max-width:none;image-rendering:pixelated;">
      </span>
    </div>`;
  }

  function render() {
    if (!hotbarEl) return;
    normalizeSelectedCategory();
    toggleBtn.setAttribute('aria-expanded', String(isOpen));
    
    if (!isOpen) {
      hotbarEl.classList.remove('open');
      toggleBtn.innerHTML = '🎒 <span class="hotbar-label">Inventory</span>';
      return;
    }
    
    hotbarEl.classList.add('open');
    toggleBtn.innerHTML = '⬇️ <span class="hotbar-label">Close</span>';
    
    const globals = getGlobals();
    const {
      _ownedItems = [],
      _playerItems = {},
      _equippedCosmetic,
      _equippedWings,
      _equippedSlots,
      _equippedPet,
      _equippedPetAcc,
      COSMETICS = [],
      PETS = [],
      PET_ACCESSORIES = [],
      USABLES = [],
      WEAR_SLOT = {}
    } = globals;

    // Collect all items
    let items = [];
    
    // HQ owns the character collection. Neighborhood maps intentionally show
    // only durable home furniture, so pets/cosmetics/food/emotes cannot leak
    // into the Willow Walk, Plaza, home, or yard inventory surface.
    if (inventoryScope() === 'hq') {
      // Wearables
      COSMETICS.forEach(c => {
        if (_ownedItems.includes(c.id)) {
          let isEquipped = (_equippedCosmetic === c.id || _equippedWings === c.id || Object.values(_equippedSlots || {}).includes(c.id));
          items.push({
            type: 'wearable',
            cat: 'wearables',
            id: c.id,
            name: c.name,
            emoji: c.emoji,
            htmlIcon: `<div class="hotbar-item-icon">${c.emoji}</div>`,
            isEquipped,
            desc: c.desc,
            raw: c
          });
        }
      });

      // Pets
      PETS.forEach(p => {
        if (_ownedItems.includes(p.id)) {
          items.push({
            type: 'pet',
            cat: 'pets',
            id: p.id,
            name: p.name,
            emoji: p.emoji,
            htmlIcon: `<div class="hotbar-item-icon">${p.emoji}</div>`,
            isEquipped: _equippedPet === p.id,
            desc: p.desc,
            raw: p
          });
        }
      });

      // Pet Accessories
      PET_ACCESSORIES.forEach(a => {
        if (_ownedItems.includes(a.id)) {
          items.push({
            type: 'petacc',
            cat: 'pets',
            id: a.id,
            name: a.name,
            emoji: a.emoji,
            htmlIcon: `<div class="hotbar-item-icon">${a.emoji}</div>`,
            isEquipped: _equippedPetAcc === a.id,
            desc: a.desc,
            raw: a
          });
        }
      });

      // Usables
      USABLES.forEach(u => {
        const count = _playerItems[u.id] || 0;
        if (count > 0) {
          items.push({
            type: 'usable',
            cat: 'usables',
            id: u.id,
            name: u.name,
            emoji: u.emoji,
            htmlIcon: `<div class="hotbar-item-icon">${u.emoji}</div>`,
            count: count,
            verb: u.verb,
            desc: u.desc,
            raw: u
          });
        }
      });
    }
    
    // Furniture (unplaced only)
    if (furnitureInventory.length > 0) {
      // Deduplicate furniture by furnitureId to group counts
      const furnMap = {};
      furnitureInventory.forEach(inst => {
        const catItem = furnitureCatalog[inst.furnitureId];
        if (catItem) {
          if (!furnMap[inst.furnitureId]) {
            furnMap[inst.furnitureId] = {
              type: 'furniture',
              cat: 'furniture',
              id: inst.furnitureId,
              name: catItem.name,
              emoji: catItem.emoji || '🛋️',
              htmlIcon: _getThumbnail(catItem, inst.furnitureId),
              count: 0,
              desc: catItem.desc || 'Placeable furniture',
              instances: [],
              raw: catItem
            };
          }
          furnMap[inst.furnitureId].count++;
          furnMap[inst.furnitureId].instances.push(inst.id);
        }
      });
      Object.values(furnMap).forEach(f => items.push(f));
    }
    
    // Filter
    if (selectedCategory !== 'all') {
      items = items.filter(i => i.cat === selectedCategory);
    }
    
    let html = `<div class="hotbar-categories">`;
    visibleCategories().forEach(c => {
      html += `<button type="button" class="hotbar-cat-btn ${selectedCategory === c.id ? 'active' : ''}" data-cat="${c.id}" title="${c.label}">${c.icon}</button>`;
    });
    html += `</div>`;
    
    html += `<div class="hotbar-items">`;
    if (isLoading && items.length === 0) {
      html += `<div class="hotbar-msg">Loading...</div>`;
    } else if (isError && items.length === 0) {
      html += `<div class="hotbar-msg error">${errorMessage || 'Error loading inventory'}<br><button type="button" class="hotbar-retry-btn" style="margin-top:8px;padding:4px 8px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);border-radius:4px;color:white;cursor:pointer;">Retry</button></div>`;
    } else if (items.length === 0) {
      html += `<div class="hotbar-msg">${selectedCategory === 'furniture'
        ? 'No stored furniture. Use Store in your home to return items here.'
        : `No items${selectedCategory !== 'all' ? ' in this category' : ''}.`}</div>`;
    } else {
      if (isStale) {
         html += `<div class="hotbar-msg warning" style="width:100%;text-align:center;padding:4px;background:rgba(230,126,34,0.2);color:#e67e22;font-size:11px;border-radius:4px;margin-bottom:4px;">Inventory may be outdated.<br><button type="button" class="hotbar-retry-btn" style="background:transparent;border:none;color:white;text-decoration:underline;cursor:pointer;font-size:11px;">Refresh</button></div>`;
      }
      items.forEach(i => {
        const isSel = selectedItem && selectedItem.id === i.id;
        html += `<button type="button" class="hotbar-item ${isSel ? 'selected' : ''} ${i.isEquipped ? 'equipped' : ''}" data-id="${i.id}" data-type="${i.type}" aria-label="${_escape(i.name)}">`;
        html += i.htmlIcon;
        if (i.count >= 1) {
          html += `<div class="hotbar-item-count">${i.count}</div>`;
        }
        if (i.isEquipped) {
          html += `<div class="hotbar-item-badge">✓</div>`;
        }
        html += `</button>`;
      });
    }
    html += `</div>`;
    
    // Popover for selected
    if (selectedItem) {
      const match = items.find(i => i.id === selectedItem.id && i.type === selectedItem.type);
      if (match) {
        html += `<div class="hotbar-popover">`;
        html += `<div class="hotbar-popover-title">${match.emoji} ${_escape(match.name)}</div>`;
        html += `<div class="hotbar-popover-desc">${_escape(match.desc || '')}</div>`;
        html += `<div class="hotbar-popover-actions">`;
        
        let actionDisabled = false;
        let disabledReason = '';

        if (match.type === 'furniture' && window.JpoNeighborhood && window.JpoNeighborhood.canPlaceFurniture) {
          if (!window.JpoNeighborhood.canPlaceFurniture()) {
            actionDisabled = true;
            disabledReason = 'You can only place furniture in your own home or yard.';
          }
        }
        
        if (match.type === 'wearable') {
          if (match.isEquipped) {
            html += `<button type="button" class="hotbar-action-btn" data-action="unequip">Take Off</button>`;
          } else {
            html += `<button type="button" class="hotbar-action-btn" data-action="equip">Wear</button>`;
          }
        } else if (match.type === 'pet') {
          if (match.isEquipped) {
            html += `<button type="button" class="hotbar-action-btn" data-action="unequippet">Send Home</button>`;
          } else {
            html += `<button type="button" class="hotbar-action-btn" data-action="equippet">Bring</button>`;
          }
        } else if (match.type === 'petacc') {
          if (match.isEquipped) {
            html += `<button type="button" class="hotbar-action-btn" data-action="unequippetacc">Take Off</button>`;
          } else {
            html += `<button type="button" class="hotbar-action-btn" data-action="equippetacc">Put On</button>`;
          }
        } else if (match.type === 'usable') {
          html += `<button type="button" class="hotbar-action-btn" data-action="use">${match.verb || 'Use'}</button>`;
        } else if (match.type === 'furniture') {
          html += `<button type="button" class="hotbar-action-btn" data-action="place" ${actionDisabled ? 'disabled' : ''} ${actionDisabled ? 'style="opacity:0.5;cursor:not-allowed;"' : ''}>Place</button>`;
        }
        
        html += `</div>`;
        if (disabledReason) {
           html += `<div style="color:#e74c3c;font-size:10px;margin-top:4px;">${_escape(disabledReason)}</div>`;
        }
        html += `<button type="button" class="hotbar-popover-close">×</button>`;
        html += `</div>`;
      } else {
        selectedItem = null;
      }
    }
    
    contentEl.innerHTML = html;
    
    // Bind events
    contentEl.querySelectorAll('.hotbar-cat-btn').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        selectedCategory = b.getAttribute('data-cat');
        selectedItem = null;
        render();
      };
    });
    
    contentEl.querySelectorAll('.hotbar-item').forEach(el => {
      el.onclick = (e) => {
        e.stopPropagation();
        const id = el.getAttribute('data-id');
        const type = el.getAttribute('data-type');
        if (selectedItem && selectedItem.id === id && selectedItem.type === type) {
          selectedItem = null;
        } else {
          selectedItem = { id, type };
        }
        render();
      };
    });
    
    contentEl.querySelectorAll('.hotbar-popover-close').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        selectedItem = null;
        render();
      };
    });
    
    contentEl.querySelectorAll('.hotbar-retry-btn').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        fetchFurniture();
      };
    });
    
    contentEl.querySelectorAll('.hotbar-action-btn').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        if (b.disabled) return;
        const action = b.getAttribute('data-action');
        const match = items.find(i => i.id === selectedItem.id && i.type === selectedItem.type);
        if (!match) return;
        
        const g = getGlobals();
        
        if (action === 'equip') {
          g.equipItem(match.id);
        } else if (action === 'unequip') {
          const slot = match.raw.wings ? 'wings' : (g.WEAR_SLOT[match.id] || 'wear');
          g.equipItem('', slot);
        } else if (action === 'equippet') {
          g.equipPet(match.id);
        } else if (action === 'unequippet') {
          g.equipPet('');
        } else if (action === 'equippetacc') {
          g.equipPetAcc(match.id);
        } else if (action === 'unequippetacc') {
          g.equipPetAcc('');
        } else if (action === 'use') {
          g.useItem(match.id);
          selectedItem = null;
        } else if (action === 'place') {
          if (window.JpoNeighborhood && window.JpoNeighborhood.canPlaceFurniture) {
            if (!window.JpoNeighborhood.canPlaceFurniture()) {
              if (window._rpsToast) window._rpsToast("You can only place furniture in your own home or yard.");
              return;
            }
            // Use the first instance id available for this furniture type
            const instanceId = match.instances[0];
            if (instanceId && window.JpoNeighborhood.placeFurniture) {
              window.JpoNeighborhood.placeFurniture(instanceId);
              // Auto-minimize so they can see to place
              isOpen = false;
              selectedItem = null;
            }
          }
        }
        
        render();
        // Return focus to game so they can move
        const canvas = document.querySelector('canvas');
        if (canvas) canvas.focus();
      };
    });
  }

  function fetchFurniture() {
    if (!socket || !isOpen) return;
    if (isLoading) {
      refreshQueued = true;
      return;
    }
    activeRequestId = ++requestIdCounter;
    isLoading = true;
    isError = false;
    errorMessage = '';
    render();
    socket.emit('playerFurnitureInventoryRequest', { requestId: activeRequestId });
    
    if (requestTimeout) clearTimeout(requestTimeout);
    requestTimeout = setTimeout(() => {
      if (isLoading && activeRequestId === requestIdCounter) {
        isLoading = false;
        isError = true;
        isStale = true;
        errorMessage = 'Request timed out.';
        render();
      }
    }, 15000);
  }

  function resetIdentity() {
    if (requestTimeout) clearTimeout(requestTimeout);
    activeRequestId = ++requestIdCounter;
    isLoading = false;
    refreshQueued = false;
    selectedItem = null;
    furnitureInventory = [];
    furnitureCatalog = {};
    lastOwnerEmail = null;
    lastRevision = -1;
    isStale = false;
    isError = false;
    errorMessage = '';
  }

  window.initInventoryHotbar = function(s, globalsProvider) {
    if (document.getElementById('inventory-hotbar')) return;
    socket = s;
    getGlobals = globalsProvider;
    
    hotbarEl = document.createElement('div');
    hotbarEl.id = 'inventory-hotbar';
    
    toggleBtn = document.createElement('button');
    toggleBtn.id = 'inventory-toggle-btn';
    toggleBtn.type = 'button';
    toggleBtn.innerHTML = '🎒 <span class="hotbar-label">Inventory</span>';
    toggleBtn.onclick = () => {
      isOpen = !isOpen;
      if (isOpen) {
        selectedItem = null;
        fetchFurniture();
      }
      render();
    };
    
    contentEl = document.createElement('div');
    contentEl.id = 'inventory-content';
    
    hotbarEl.appendChild(toggleBtn);
    hotbarEl.appendChild(contentEl);
    document.body.appendChild(hotbarEl);

    // The map scene can already have received its authoritative snapshot if
    // this UI initializes late (for example after a reconnect/build handoff).
    // Prefer that server-derived marker, then the live neighborhood controller;
    // socket listeners below still keep it current after initialization.
    setLocation(window._jpoAuthoritativeLocation ||
      window.JpoNeighborhood?.getCurrentLocation?.());
    
    // Prevent canvas from stealing clicks
    hotbarEl.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
    });
    
    socket.on('playerFurnitureInventoryResult', (result) => {
      if (result.requestId !== activeRequestId) return;
      
      const myEmail = String(getGlobals()._playerEmail || '').trim().toLowerCase();
      const ownerEmail = String(result.ownerEmail || '').trim().toLowerCase();
      
      if (myEmail && ownerEmail !== myEmail) {
        return; // Explicitly reject foreign owner data
      }
      
      if (requestTimeout) clearTimeout(requestTimeout);
      isLoading = false;
      
      const shouldRetry = refreshQueued;
      refreshQueued = false;
      
      if (!result.ok) {
        isError = true;
        isStale = true;
        errorMessage = result.message || 'Could not load furniture.';
        if (shouldRetry) setTimeout(fetchFurniture, 1000);
      } else {
        const ownerEmail = String(result.ownerEmail || '').trim().toLowerCase();
        const revision = Number(result.revision);
        
        // Gate on ownerEmail + revision
        if (lastOwnerEmail && lastOwnerEmail === ownerEmail) {
          if (Number.isSafeInteger(revision) && Number.isSafeInteger(lastRevision) && revision < lastRevision) {
             // Stale, ignore
             if (shouldRetry) fetchFurniture();
             else render();
             return;
          }
        }
        
        lastOwnerEmail = ownerEmail;
        lastRevision = revision;
        isError = false;
        isStale = false;
        
        if (result.catalog) furnitureCatalog = result.catalog;
        const allInventory = result.inventory || [];
        const layoutSet = new Set((result.layout || []).map(i => String(i.id)));
        const yardSet = new Set((result.yard || []).map(i => String(i.id)));
        
        furnitureInventory = allInventory.filter(i => !layoutSet.has(String(i.id)) && !yardSet.has(String(i.id)));
        
        if (shouldRetry) fetchFurniture();
      }
      render();
    });
    
    // Hook into global refreshShopUI to catch all item updates unconditionally
    const originalRefresh = window._refreshShopUI;
    if (typeof originalRefresh === 'function') {
      window._refreshShopUI = function() {
        originalRefresh.apply(this, arguments);
        if (isOpen) render();
      };
    }
    
    socket.on('homeActionResult', (result) => {
      if (result && result.ok && isOpen) fetchFurniture();
    });
    // Consumables update through _renderItemBar, not _refreshShopUI.
    // Wait until the existing listeners have adopted the server's counts.
    for (const event of ['itemsUpdate', 'usableBought']) {
      socket.on(event, () => queueMicrotask(render));
    }
    socket.on('homeSnapshot', (snap) => {
      if (isOpen) fetchFurniture();
    });
    socket.on('homePurchaseResult', (result) => {
      if (result?.ok && isOpen) fetchFurniture();
    });
    // Location comes from server-confirmed lifecycle payloads. Do not infer it
    // from a still-alive Phaser scene: the shared NeighborhoodScene can remain
    // active for a frame while office/home/plaza transitions settle.
    socket.on('approved', (result) => setLocation(result?.location || result?.locationId));
    socket.on('locationTransitionResult', (result) => {
      if (result?.ok) setLocation(result.location);
    });
    socket.on('currentPlayers', (players) => {
      const own = players?.[socket.id];
      setLocation(own?.locationId || own?.location);
    });
    
    const resetAndFetch = () => {
      resetIdentity();
      if (isOpen) fetchFurniture();
      else render();
    };
    socket.on('approved', resetAndFetch);
    socket.on('resumeSuccess', resetAndFetch);
    socket.on('disconnect', () => {
      if (requestTimeout) clearTimeout(requestTimeout);
      activeRequestId = ++requestIdCounter;
      refreshQueued = false;
      isLoading = false;
      isError = true;
      isStale = true;
      errorMessage = 'Disconnected.';
      if (isOpen) render();
    });
    
    // Global keyboard shortcut to toggle inventory (like I)
    window.addEventListener('keydown', (e) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey ||
          !document.body.classList.contains('playing')) return;
      if (e.key === 'i' || e.key === 'I') {
        const ae = document.activeElement;
        if (ae?.closest('input, textarea, select, [contenteditable="true"]')) return;
        if (document.body.classList.contains('chatting')) return;
        isOpen = !isOpen;
        if (isOpen) {
          selectedItem = null;
          fetchFurniture();
        }
        render();
      }
    });

    render();
  };
})();