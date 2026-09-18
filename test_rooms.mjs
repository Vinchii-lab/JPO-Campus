import { execSync } from 'child_process';
try {
  execSync('node artifacts/jpo-huddle/tests/neighborhood/commercial-navigation.mjs', { stdio: 'inherit' });
} catch(e) {
  console.log("Failed");
}
