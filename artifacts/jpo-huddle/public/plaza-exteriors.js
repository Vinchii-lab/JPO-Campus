// Individual transparent building sprites, not flattened map backgrounds.
// Native pixels remain sharp and door bottoms follow the shared world layout.
window.JpoPlazaExteriors = {
  ids: ['furniture-shop', 'garden-shop', 'decor-shop', 'cafe', 'diner', 'bakery', 'sushi', 'museum'],
  preload(scene) {
    this.ids.forEach(id => scene.load.image(
      `plaza_detailed_${id}`,
      `assets/neighborhood/plaza-detailed/${id}.png`,
    ));
  },
  draw(scene, { id, x, y, width, height, doorX, doorY }) {
    const key = `plaza_detailed_${id}`;
    if (!scene.textures.exists(key)) {
      console.error(`Missing plaza storefront artwork: ${id}`);
      return null;
    }
    const image = scene.textures.get(key).getSourceImage();
    // Roof overhang is visual only. Never stretch the building or move its
    // entrance away from the server-owned doorway.
    const scale = Math.min(width / image.width, (height + 120) / image.height, (doorY - 24) / image.height);
    return scene.add.image(doorX ?? x + width / 2, doorY ?? y + height, key)
      .setOrigin(0.5, 1).setScale(scale).setDepth(doorY - 0.1);
  },
};