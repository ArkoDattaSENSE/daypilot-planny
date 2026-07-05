const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = process.cwd();
const firebaserc = path.join(root, ".firebaserc");
const firebaseBin = path.join(root, "node_modules", ".bin", "firebase");
const buildScript = path.join(root, "scripts", "build-pages.cjs");
const projectFromEnv = process.env.FIREBASE_PROJECT || process.env.GCLOUD_PROJECT || "";
const projectFromFile = readProjectId();
const projectId = projectFromEnv || projectFromFile;

if (!projectId) {
  console.error("");
  console.error("Firebase project id is missing.");
  console.error("");
  console.error("Use one of these:");
  console.error("  1. FIREBASE_PROJECT=your-project-id npm run deploy:firebase");
  console.error("  2. cp .firebaserc.example .firebaserc, then edit .firebaserc");
  console.error("");
  console.error("To see projects for your account:");
  console.error("  FIREBASE_CLI_DISABLE_UPDATE_CHECK=true ./node_modules/.bin/firebase projects:list");
  console.error("");
  process.exit(1);
}

const args = [
  "deploy",
  "--only",
  "firestore:rules,hosting",
  "--project",
  projectId
];

const build = spawnSync(process.execPath, [buildScript], {
  stdio: "inherit",
  env: process.env
});

if (build.status !== 0) {
  process.exit(build.status == null ? 1 : build.status);
}

const result = spawnSync(firebaseBin, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    FIREBASE_CLI_DISABLE_UPDATE_CHECK: "true",
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || "/tmp/firebase-cache"
  }
});

process.exit(result.status == null ? 1 : result.status);

function readProjectId() {
  if (!fs.existsSync(firebaserc)) return "";
  try {
    const config = JSON.parse(fs.readFileSync(firebaserc, "utf8"));
    const id = config && config.projects && config.projects.default;
    return id && id !== "your-firebase-project-id" ? id : "";
  } catch (error) {
    console.error(`Could not parse .firebaserc: ${error.message}`);
    process.exit(1);
  }
}
