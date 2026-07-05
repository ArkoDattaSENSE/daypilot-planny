const fs = require("fs");
const path = require("path");

const root = process.cwd();
const required = [
  "index.html",
  "styles.css",
  "src/app.js",
  "src/firebase.js",
  "src/firebase-config.js",
  "sw.js",
  "manifest.webmanifest",
  "firestore.rules",
  ".github/workflows/deploy-pages.yml",
  "today/index.html",
  "dump/index.html",
  "week/index.html",
  "now/index.html",
  "checkin/index.html",
  "settings/index.html"
];

for (const file of required) {
  const target = path.join(root, file);
  if (!fs.existsSync(target)) {
    throw new Error(`Missing ${file}`);
  }
}

const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
if (!html.includes("./src/app.js")) throw new Error("index.html does not load app.js");

const app = fs.readFileSync(path.join(root, "src/app.js"), "utf8");
for (const route of ["today", "dump", "week", "now", "checkin", "settings"]) {
  if (!app.includes(`"${route}"`)) throw new Error(`Route ${route} is not registered`);
}
for (const phrase of ["Move future task?", "DayPilot Timetable", "Google sign-in", "Multi-add task intake"]) {
  if (!app.includes(phrase)) throw new Error(`Missing UI phrase: ${phrase}`);
}
const config = fs.readFileSync(path.join(root, "src/firebase-config.js"), "utf8");
if (!config.includes("labtrack-559e9")) throw new Error("Default Firebase config is not wired");

const rules = fs.readFileSync(path.join(root, "firestore.rules"), "utf8");
if (!rules.includes("request.auth.uid == userId")) throw new Error("Firestore rules do not enforce per-user access");

console.log("Smoke test passed: static app, routes, Firebase rules, and deploy workflow are present.");
