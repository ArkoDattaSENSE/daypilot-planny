const fs = require("fs");
const path = require("path");

const root = process.cwd();
const required = [
  "index.html",
  "styles.css",
  "src/app.js",
  "src/firebase.js",
  "src/gemini-parser.js",
  "src/gcal.js",
  "sw.js",
  "manifest.webmanifest",
  "firestore.rules",
  ".github/workflows/deploy-pages.yml",
  "today/index.html",
  "dump/index.html",
  "week/index.html",
  "now/index.html",
  "notes/index.html",
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
for (const route of ["home", "notes", "stats", "settings"]) {
  if (!app.includes(`"${route}"`)) throw new Error(`Route ${route} is not registered`);
}
for (const phrase of ["Planny", "mascot-bot", "chat-sidekick", "Thinking...", "Ta-da", "Chat dump", "Firebase is not configured", "Add activity", "Accountability", "Projects & notes", "Create event", "Task notes", "Boost", "Open Firebase Console", "Open AI Studio keys", "every Wednesday", "weekdays", "weekends", "recurrence", "Google Calendar (2-way sync)", "Planning profile", "Daily check-in reminder", "Only this occurrence", "Fixed time", "buildGeminiPrompt"]) {
  if (!app.includes(phrase)) throw new Error(`Missing UI phrase: ${phrase}`);
}
for (const guard of ["expandedActivitiesForRange", "alignDateToRecurrence", "dateMatchesRecurrence", "weekdayCodes", "applyRescheduleRequest", "settleFlexibleDay", "isLockedActivity"]) {
  if (!app.includes(`function ${guard}`)) throw new Error(`Missing scheduling guard: ${guard}`);
}
const gcal = fs.readFileSync(path.join(root, "src/gcal.js"), "utf8");
if (!gcal.includes("plannyLocked")) throw new Error("Calendar sync must preserve fixed/flexible metadata");
if (fs.existsSync(path.join(root, "src/firebase-config.js"))) {
  throw new Error("Repo must not include a committed Firebase config");
}

const rules = fs.readFileSync(path.join(root, "firestore.rules"), "utf8");
if (!rules.includes("request.auth.uid == userId")) throw new Error("Firestore rules do not enforce per-user access");

console.log("Smoke test passed: static app, routes, Firebase rules, and deploy workflow are present.");
