const fs = require('fs');
let content = fs.readFileSync('artifacts/jpo-huddle/public/neighborhood.js', 'utf8');

content = content.replace(
  /panelToggle\.hidden = !\(currentLocation === 'neighborhood' \|\| currentLocation\.startsWith\('home:'\) \|\| currentLocation\.endsWith\('-shop'\)\);/,
  "panelToggle.hidden = !(currentLocation === 'neighborhood' || currentLocation.startsWith('home:') || currentLocation.endsWith('-shop') || ['cafe', 'diner', 'bakery', 'sushi'].includes(currentLocation));"
);

content = content.replace(
  /if \(typeof currentLocation !== 'string' \|\| !currentLocation\.endsWith\('-shop'\)\) \{/,
  "if (typeof currentLocation !== 'string' || (!currentLocation.endsWith('-shop') && !['cafe', 'diner', 'bakery', 'sushi'].includes(currentLocation))) {"
);

const shopCopyInjection = `
    const isRestaurant = ['cafe', 'diner', 'bakery', 'sushi'].includes(currentLocation);
    const shopCopy = {
      'furniture-shop': { title: 'Huddle Home', category: 'Furnishings', copy: 'Comfort pieces for your Willow Walk home.' },
      'garden-shop': { title: 'Willow & Green', category: 'Garden goods', copy: 'Leafy accents and a sunny seat for your home or yard.' },
      'decor-shop': { title: 'Plaza Decor', category: 'Living-room accents', copy: 'Statement pieces for a warm, lived-in room.' },
      'cafe': { title: 'The Daily Grind', category: 'Cafe', copy: 'Fresh coffee and pastries. Have a seat and enjoy the vibe!', isMenu: true },
      'diner': { title: 'Neon Diner', category: 'American Diner', copy: 'Classic burgers and milkshakes.', isMenu: true },
      'bakery': { title: 'Sweet Crust', category: 'Bakery', copy: 'Artisan bread and delicious cakes baked daily.', isMenu: true },
      'sushi': { title: 'Sakura Sushi', category: 'Sushi Restaurant', copy: 'Fresh rolls directly from the conveyor.', isMenu: true },
    }[currentLocation] || { title: 'Huddle shop', category: 'Home goods', copy: 'Furniture for your Willow Walk home.' };

    const menuItems = {
      cafe: ['Espresso', 'Latte', 'Matcha', 'Croissant', 'Muffin'],
      diner: ['Classic Burger', 'Cheeseburger', 'Fries', 'Vanilla Shake', 'Cherry Pie'],
      bakery: ['Sourdough', 'Baguette', 'Cupcake', 'Chocolate Cake', 'Macaron'],
      sushi: ['Salmon Nigiri', 'Tuna Sashimi', 'Dragon Roll', 'Edamame', 'Green Tea']
    };

    let rows = '';
    if (isRestaurant) {
       rows = (menuItems[currentLocation] || []).map(item => 
         '<span class="home-item"><span>' + escapeHtml(item) + '</span><small class="menu-only-label">Menu Only</small></span>'
       ).join('');
    } else {
       rows = Object.values(furnitureCatalog).map((item) =>
         '<span class="home-item"><span>' + escapeHtml(item.name) + ' · ' +
         Number(item.price).toLocaleString() + ' coins</span><button type="button" data-buy="' +
         escapeHtml(item.id) + '">Buy</button></span>',
       ).join('') || '<small>The catalog is loading.</small>';
    }

    const tipCopy = isRestaurant ? 'This is a reference menu. Food purchasing is not yet supported, but please enjoy the ambiance.' : 'Prices are coins; Buy adds the item to your home Inventory. Leave through the glowing PLAZA exit, walk to your permanent Willow Walk lot, then place it indoors or in your yard.';
`;

content = content.replace(
  /const rows = Object\.values\(furnitureCatalog\).[\s\S]*?(?=panel\.innerHTML = )/,
  shopCopyInjection
);

content = content.replace(
  /panel\.innerHTML = '<div class="home-panel-head"><b>' \+ escapeHtml\(shopCopy\.title\) \+ ' · ' \+ escapeHtml\(shopCopy\.category\) \+ '<\/b><button type="button" data-close>Close<\/button><\/div>' \+\n        '<div class="home-section"><small>' \+ escapeHtml\(shopCopy\.copy\) \+ ' Prices are coins; Buy adds the item to your home Inventory\. Leave through the glowing PLAZA exit, walk to your permanent Willow Walk lot, then place it indoors or in your yard\.<\/small>' \+ rows \+ '<\/div>';/,
  "panel.innerHTML = '<div class=\"home-panel-head\"><b>' + escapeHtml(shopCopy.title) + ' · ' + escapeHtml(shopCopy.category) + '</b><button type=\"button\" data-close>Close</button></div>' +\n        '<div class=\"home-section\"><small>' + escapeHtml(shopCopy.copy) + ' ' + tipCopy + '</small>' + rows + '</div>';"
);

fs.writeFileSync('artifacts/jpo-huddle/public/neighborhood.js', content);
