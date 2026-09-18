import fs from 'fs';

let content = fs.readFileSync('artifacts/jpo-huddle/generate_layouts.mjs', 'utf8');

content = content.replace(
  `  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
    manifest.assets[key] = \`assets/neighborhood/commercial/\${key}.png\`;
  }`,
  `  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
    manifest.assets[key] = \`assets/neighborhood/commercial/\${key}.png\`;
  } else {
    console.error("Missing art:", src);
    process.exit(1);
  }`
);

fs.writeFileSync('artifacts/jpo-huddle/generate_layouts.mjs', content);
