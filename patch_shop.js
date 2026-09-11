const fs = require('fs');
let code = fs.readFileSync('artifacts/jpo-huddle/public/neighborhood.js', 'utf8');

const renderHomePatch = `function renderHome() {
    if (!homeState || !currentLocation.startsWith('home:')) { homePanel.hidden = true; return; }
    homePanel.hidden = false;
    const placed = homeState.layout || [];
    const inv = homeState.inventory || [];
    const dirList = window._homeDirectory || [];

    const dirCard = dirList.length ? '<div><small>Visit Coworkers:</small>' + dirList.map(h => '<button data-visit="' + esc(h.ownerEmail) + '">' + esc(h.name || h.ownerEmail) + ' (' + esc(h.accessMode) + ')</button>').join('') + '</div><br>' : '';

    const invCard = inv.map((i) => {
      const name = furnitureCatalog[i.furnitureId]?.name || i.furnitureId;
      return '<span class="home-item ' + (selectedInstance === i.id ? 'selected':'') + '"><span>' + esc(name) + '</span><button data-select="' + i.id + '">Place</button></span>';
    }).join('') || '<small>No unplaced furniture yet.</small>';
    
    const placedCard = placed.map((i) => 
      '<span class="home-item"><span>' + esc(furnitureCatalog[i.furnitureId]?.name || i.furnitureId) + ' (' + i.gridX + ',' + i.gridY + ')</span><button data-return="' + i.id + '">Store</button></span>'
    ).join('') || '<small>Your room is open and ready to furnish.</small>';
    
    homePanel.innerHTML = '<b>' + (homeState.canEdit ? 'Your Starter Home' : 'Visiting this home') + ' · ' + esc(homeState.accessMode) + '</b>' +
      dirCard +
      (homeState.canEdit ? 
      '<div class="home-section"><button data-close>Close Panel</button><button data-rotate>Rotate ' + selectedRotation + '°</button><br><br><select id="home-access"><option value="public">Public</option><option value="invite_only">Invite Only</option><option value="private">Private</option></select><button data-access>Save Access</button><br><br><input id="home-invite-email" type="email" placeholder="coworker@email.com"><button data-invite>Invite</button>' +
      (homeState.invitations && homeState.invitations.length ? '<div style="margin-top:8px"><small>Active Invitations:</small>' + homeState.invitations.map(i => '<span class="home-item">' + esc(i.name) + ' <button data-revoke="' + esc(i.email) + '">Revoke</button></span>').join('') + '</div>' : '') +
      '</div><div class="home-section"><small>Inventory — select to place</small>' + invCard + '</div><div class="home-section"><small>Placed Items</small>' + placedCard + '</div>' : 
      '<div class="home-section"><small>The owner controls this room. Furniture is synchronized live.</small><button data-close>Close Panel</button></div>');
    
    homePanel.querySelector('[data-close]')?.addEventListener('click', () => { homePanel.hidden = true; });
    homePanel.querySelectorAll('[data-select]').forEach((b) => b.onclick = () => { selectedInstance=b.dataset.select; selectedRotation=0; renderHome(); });
    homePanel.querySelectorAll('[data-return]').forEach((b) => b.onclick = () => socket.emit('homeLayoutReturn', { instanceId:b.dataset.return }));
    homePanel.querySelector('[data-rotate]')?.addEventListener('click', () => { selectedRotation=(selectedRotation+90)%360; renderHome(); });
    homePanel.querySelector('[data-access]')?.addEventListener('click', () => socket.emit('homeAccessSet', { mode:homePanel.querySelector('#home-access').value }));
    if (homePanel.querySelector('#home-access')) {
      homePanel.querySelector('#home-access').value = homeState.accessMode;
    }
    homePanel.querySelector('[data-invite]')?.addEventListener('click', () => socket.emit('homeInvite', { email:homePanel.querySelector('#home-invite-email').value }));
    homePanel.querySelectorAll('[data-revoke]').forEach(b => b.onclick = () => socket.emit('homeInviteRevoke', { email:b.dataset.revoke }));
    homePanel.querySelectorAll('[data-visit]').forEach(b => b.onclick = () => travel('home:' + b.dataset.visit));
  }
  
  function renderShop() {
    if (currentLocation !== 'furniture-shop') { 
       const sh = document.getElementById('shop-panel');
       if (sh) sh.hidden = true; 
       return; 
    }
    let sh = document.getElementById('shop-panel');
    if (!sh) {
       sh = document.createElement('div');
       sh.id = 'shop-panel';
       document.getElementById('neighborhood-ui').appendChild(sh);
    }
    sh.hidden = false;
    const catalogCard = Object.values(furnitureCatalog).map((f) =>
      '<span class="home-item"><span>' + esc(f.name) + ' · ' + Number(f.price).toLocaleString() + ' Coins</span><button data-buy="' + esc(f.id) + '">Buy</button></span>'
    ).join('');
    sh.innerHTML = '<b>Huddle Home Shop</b><div class="home-section"><small>Furniture Catalog</small>' + catalogCard + '</div><button data-close>Close Panel</button>';
    sh.querySelectorAll('[data-buy]').forEach((b) => b.onclick = () => socket.emit('homePurchase', { furnitureId:b.dataset.buy }));
    sh.querySelector('[data-close]')?.addEventListener('click', () => { sh.hidden = true; });
  }`;

code = code.replace(/function renderHome\(\) \{[\s\S]*?socket\.on\('homeSnapshot'/m, renderHomePatch + "\n\n  socket.on('homeSnapshot'");

const dEventPatch = `socket.on('homeDirectory', (list) => { window._homeDirectory = list; renderHome(); });
  socket.on('homeSnapshot'`;
code = code.replace(/socket\.on\('homeSnapshot'/, dEventPatch);

const requestDirPatch = `    if (d.location.startsWith('home:')) {
      homeState = d.home || homeState;
      socket.emit('homeDirectoryRequest');
      renderHome();
    } else {
      homePanel.hidden = true;
      if (this.ghostObj) { this.ghostObj.destroy(); this.ghostObj = null; }
    }
    renderShop();`;

code = code.replace(/    if \(d\.location\.startsWith\('home:'\)\) \{[\s\S]*?if \(this\.ghostObj\) \{ this\.ghostObj\.destroy\(\); this\.ghostObj = null; \}\n    \}/, requestDirPatch);

fs.writeFileSync('artifacts/jpo-huddle/public/neighborhood.js', code);
