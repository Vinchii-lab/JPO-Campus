const fs = require('fs');
let content = fs.readFileSync('artifacts/jpo-huddle/public/neighborhood.js', 'utf8');

content = content.replace(
  /else if \(typeof this\.location === 'string' && this\.location\.endsWith\('-shop'\)\) this\._drawShop\(\);/,
  "else if (typeof this.location === 'string' && this.location.endsWith('-shop')) this._drawShop();\n      else if (typeof this.location === 'string' && ['cafe', 'diner', 'bakery', 'sushi'].includes(this.location)) this._drawRestaurant();"
);

const restaurantMethod = `
    _drawRestaurant() {
      this._interiorTileField('shop_floor', 'shop_wall', { x: 408, width: 144 });
      if (window.JpoInteriors?.drawRestaurantVignettes) {
        window.JpoInteriors.drawRestaurantVignettes(this, INTERIOR_ART_SCALE, this.location);
      }
    }
`;

content = content.replace(
  /    _drawShop\(\) \{/,
  restaurantMethod + '\n    _drawShop() {'
);

fs.writeFileSync('artifacts/jpo-huddle/public/neighborhood.js', content);
