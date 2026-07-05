const fs = require("fs");
const path = require("path");

const root = process.cwd();
const dist = path.join(root, "dist");
const files = [
  "index.html",
  "styles.css",
  "manifest.webmanifest",
  "sw.js",
  ".nojekyll",
  "assets/icon.svg",
  "src/app.js",
  "src/firebase.js",
  "src/firebase-config.js",
  "today/index.html",
  "dump/index.html",
  "week/index.html",
  "now/index.html",
  "checkin/index.html",
  "settings/index.html"
];

removeDir(dist);
for (const file of files) {
  const from = path.join(root, file);
  const to = path.join(dist, file);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

console.log(`Built ${files.length} files into dist/.`);

function removeDir(target) {
  if (!fs.existsSync(target)) return;
  for (const entry of fs.readdirSync(target)) {
    const fullPath = path.join(target, entry);
    const stat = fs.lstatSync(fullPath);
    if (stat.isDirectory()) removeDir(fullPath);
    else fs.unlinkSync(fullPath);
  }
  fs.rmdirSync(target);
}
