const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const endpoint = process.argv[2];
if (!endpoint) {
  console.error("Usage: node scripts/capture-readme-screenshots.cjs ws://127.0.0.1:9222/devtools/page/<id>");
  process.exit(1);
}

const root = path.resolve(__dirname, "..");
const docs = path.join(root, "docs");
fs.mkdirSync(docs, { recursive: true });

const today = "2026-07-05";
const demoState = {
  view: "day",
  route: "home",
  mood: { label: "Focused", energy: 72, stress: 28 },
  settings: {
    parserMode: "manual",
    workDone: 68,
    exhaustion: 34,
    checkinEnabled: true,
    checkinTime: "21:15",
    checkinText: "quarter past 9 in the evening"
  },
  profile: {
    workStart: "09:00",
    workEnd: "18:00",
    peakStart: "09:30",
    peakEnd: "12:30",
    maxFocusMin: 90,
    breakMin: 15,
    drainingTasks: "long admin threads, context switching, unplanned meetings",
    energizingTasks: "writing, plotting results, tidy literature notes"
  },
  selectedProject: "Thesis",
  activities: [
    {
      id: "demo-intro",
      title: "Write introduction",
      project: "Thesis",
      branch: "Paper draft",
      date: today,
      start: "09:30",
      durationMin: 90,
      kind: "focus",
      recurrence: null,
      note: "Needs fresh brain. Start from the outline and keep citations light.",
      status: "planned",
      notify: true,
      notifyMin: 10,
      updatedAt: "2026-07-05T08:00:00.000Z"
    },
    {
      id: "demo-lab-journal",
      title: "Lab journal",
      project: "Research",
      branch: "Weekly rhythm",
      date: "2026-07-08",
      start: "16:00",
      durationMin: 30,
      kind: "routine",
      recurrence: { frequency: "weekly", byDay: "WE" },
      note: "Capture what changed, what failed, and next run parameters.",
      status: "planned",
      notify: true,
      notifyMin: 10,
      updatedAt: "2026-07-05T08:00:00.000Z"
    },
    {
      id: "demo-admin",
      title: "Email advisor update",
      project: "Thesis",
      branch: "Paper draft",
      date: today,
      start: "14:30",
      durationMin: 25,
      kind: "admin",
      recurrence: null,
      note: "Blocked until the plot export finishes.",
      status: "partial",
      notify: true,
      notifyMin: 20,
      updatedAt: "2026-07-05T08:00:00.000Z"
    },
    {
      id: "demo-walk",
      title: "Walk and reset",
      project: "Life",
      branch: "Energy",
      date: "2026-07-06",
      start: "18:15",
      durationMin: 30,
      kind: "personal",
      recurrence: null,
      note: "Light slot after the hard work.",
      status: "planned",
      notify: false,
      notifyMin: 10,
      updatedAt: "2026-07-05T08:00:00.000Z"
    }
  ],
  projectNotes: [
    {
      id: "note-context",
      project: "Thesis",
      branch: "Paper draft",
      section: "pinned_context",
      text: "Main story: lightweight planning that survives real research days.",
      priority: 4,
      createdAt: "2026-07-05T08:00:00.000Z"
    },
    {
      id: "note-blocked",
      project: "Thesis",
      branch: "Paper draft",
      section: "blocked_by",
      text: "Waiting for final ablation plot before writing the limitations paragraph.",
      priority: 5,
      createdAt: "2026-07-05T08:00:00.000Z"
    },
    {
      id: "note-seed",
      project: "Thesis",
      branch: "Paper draft",
      section: "task_seeds",
      text: "Tomorrow: turn reviewer notes into three concrete edits.",
      priority: 3,
      createdAt: "2026-07-05T08:00:00.000Z"
    }
  ],
  branches: [
    {
      id: "branch-paper",
      project: "Thesis",
      name: "Paper draft",
      status: "active",
      boost: 2,
      nextAction: "Rewrite motivation paragraph",
      createdAt: "2026-07-05T08:00:00.000Z"
    }
  ],
  checkins: {
    [today]: { reminders: 1, done: false }
  },
  calendar: { calendarId: "", lastSync: "" },
  calendarTombstones: [],
  chatDraft: "tomorrow 9:30 write introduction 90m\nevery Wednesday lab journal 30m\nnote: waiting for advisor reply",
  activeModal: null,
  editingId: null,
  pendingParse: null,
  chatClarify: null,
  questionnaireReturn: null,
  pendingRecurringEdit: null,
  lastMessage: "Demo plan ready."
};

let id = 0;
const ws = new WebSocket(endpoint);

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const requestId = ++id;
    const onMessage = (message) => {
      const data = JSON.parse(message);
      if (data.id !== requestId) return;
      ws.off("message", onMessage);
      data.error ? reject(new Error(JSON.stringify(data.error))) : resolve(data.result);
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ id: requestId, method, params }));
  });
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setState(overrides, url) {
  const state = { ...demoState, ...overrides };
  await send("Page.navigate", { url });
  await wait(300);
  await send("Runtime.evaluate", {
    expression: `
      localStorage.setItem("daypilot-state-v2", ${JSON.stringify(JSON.stringify(state))});
      localStorage.setItem("daypilot-firebase-config", JSON.stringify({
        apiKey: "demo-api-key-not-secret",
        authDomain: "demo-planny.firebaseapp.com",
        projectId: "demo-planny",
        appId: "1:123456789:web:demo"
      }));
      localStorage.removeItem("daypilot-gemini-key");
    `,
    awaitPromise: true
  });
  await send("Page.reload", { ignoreCache: true });
  await wait(750);
}

async function shot(name, height = 1050) {
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height,
    deviceScaleFactor: 1,
    mobile: false
  });
  await wait(250);
  const result = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false
  });
  fs.writeFileSync(path.join(docs, name), Buffer.from(result.data, "base64"));
}

ws.on("open", async () => {
  try {
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Network.enable");
    await send("Network.setBypassServiceWorker", { bypass: true });

    const base = "http://localhost:8000/index.html#";
    await setState({ view: "day", activeModal: null, editingId: null }, `${base}/today`);
    await shot("planner.png");

    await setState({ view: "week", activeModal: null, editingId: null }, `${base}/today`);
    await shot("weekview.png");

    await setState({ view: "day", activeModal: "chat", editingId: null }, `${base}/today`);
    await shot("chatmodal.png");

    await setState({ view: "day", activeModal: "task", editingId: "demo-intro" }, `${base}/today`);
    await shot("taskmodal.png");

    await setState({ activeModal: "questionnaire", questionnaireReturn: "chat" }, `${base}/today`);
    await shot("questionnaire.png");

    await setState({ activeModal: null, editingId: null }, `${base}/checkin`);
    await shot("statspage.png");

    await setState({ activeModal: null, editingId: null }, `${base}/settings`);
    await shot("settingspage.png", 1280);

    ws.close();
  } catch (error) {
    console.error(error);
    ws.close();
    process.exitCode = 1;
  }
});
