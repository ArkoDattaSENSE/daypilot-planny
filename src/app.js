import { initFirebase, saveCloudState, loadCloudState, signIn, signOut } from "./firebase.js";
import {
  getCalendarClientId, setCalendarClientId, clearCalendarToken, hasValidToken,
  requestCalendarToken, ensurePlannyCalendar, insertEvent, patchEvent, deleteEvent,
  listEvents, eventToActivityFields, findInstance
} from "./gcal.js";

const storageKey = "daypilot-state-v2";
const firebaseKey = "daypilot-firebase-config";
const geminiKey = "daypilot-gemini-key";

const blankState = {
  view: "day",
  route: "home",
  mood: {
    label: "Okay",
    energy: 55,
    stress: 35
  },
  settings: {
    parserMode: "manual",
    workDone: 0,
    exhaustion: 20,
    checkinEnabled: false,
    checkinTime: "21:00",
    checkinText: ""
  },
  profile: {
    workStart: "",
    workEnd: "",
    peakStart: "",
    peakEnd: "",
    maxFocusMin: 90,
    breakMin: 15,
    drainingTasks: "",
    energizingTasks: ""
  },
  selectedProject: "Inbox",
  activities: [],
  projectNotes: [],
  branches: [],
  checkins: {},
  calendar: {
    calendarId: "",
    lastSync: ""
  },
  calendarTombstones: [],
  chatDraft: "",
  activeModal: null,
  editingId: null,
  pendingParse: null,
  chatClarify: null,
  questionnaireReturn: null,
  pendingRecurringEdit: null,
  lastMessage: "Blank slate ready. Add a task or dump into chat."
};

let state = loadState();
let firebaseRuntime = null;
let authNotice = "";

boot();

async function boot() {
  registerServiceWorker();
  render();
  firebaseRuntime = await initFirebase(readFirebaseConfig());
  if (firebaseRuntime.ready && firebaseRuntime.user) {
    try {
      const cloud = await loadCloudState(firebaseRuntime);
      if (cloud) {
        state = normalizeState(cloud);
        saveLocal();
      }
    } catch (error) {
      console.warn("Cloud state load failed", error);
      toast("Could not load cloud data. Working from this device's copy.");
    }
  }
  if (needsQuestionnaire()) {
    state.activeModal = "questionnaire";
  }
  render();
  if (calendarReady() && hasValidToken()) {
    syncCalendarNow(false);
  }
  scheduleCheckinLoop();
}

function loadState() {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) || "null");
    return normalizeState(stored || blankState);
  } catch {
    return normalizeState(blankState);
  }
}

function normalizeState(input) {
  const base = JSON.parse(JSON.stringify(blankState));
  const next = { ...base, ...(input || {}) };
  next.view = ["day", "week", "month"].includes(next.view) ? next.view : "day";
  next.mood = { ...base.mood, ...(input && input.mood ? input.mood : {}) };
  next.mood.label = String(next.mood.label || "Okay").slice(0, 60);
  next.mood.energy = clampNumber(next.mood.energy, 0, 100, 55);
  next.mood.stress = clampNumber(next.mood.stress, 0, 100, 35);
  next.settings = { ...base.settings, ...(input && input.settings ? input.settings : {}) };
  next.settings.parserMode = next.settings.parserMode === "gemini" ? "gemini" : "manual";
  next.settings.workDone = clampNumber(next.settings.workDone, 0, 100, 0);
  next.settings.exhaustion = clampNumber(next.settings.exhaustion, 0, 100, 20);
  next.settings.checkinEnabled = Boolean(next.settings.checkinEnabled);
  next.settings.checkinTime = sanitizeTime(next.settings.checkinTime, "21:00");
  next.settings.checkinText = String(next.settings.checkinText || "").slice(0, 120);
  next.profile = sanitizeProfile({ ...base.profile, ...(input && input.profile ? input.profile : {}) });
  next.activities = (Array.isArray(next.activities) ? next.activities : []).map(sanitizeActivity).filter(Boolean);
  next.projectNotes = (Array.isArray(next.projectNotes) ? next.projectNotes : []).map(sanitizeNote).filter(Boolean);
  next.branches = (Array.isArray(next.branches) ? next.branches : []).map(sanitizeBranchEntry).filter(Boolean);
  next.selectedProject = normalizeProject(next.selectedProject || firstProject(next));
  next.checkins = next.checkins && typeof next.checkins === "object" ? next.checkins : {};
  const calendarInput = next.calendar && typeof next.calendar === "object" ? next.calendar : {};
  next.calendar = {
    calendarId: typeof calendarInput.calendarId === "string" ? calendarInput.calendarId : "",
    lastSync: typeof calendarInput.lastSync === "string" ? calendarInput.lastSync : ""
  };
  next.calendarTombstones = (Array.isArray(next.calendarTombstones) ? next.calendarTombstones : []).filter((id) => typeof id === "string" && id);
  next.chatDraft = typeof next.chatDraft === "string" ? next.chatDraft : "";
  next.pendingParse = null;
  next.chatClarify = null;
  next.questionnaireReturn = null;
  next.pendingRecurringEdit = null;
  const checkinsInput = next.checkins && typeof next.checkins === "object" ? next.checkins : {};
  next.checkins = {};
  Object.keys(checkinsInput).slice(0, 400).forEach((key) => {
    const entry = checkinsInput[key];
    if (/^\d{4}-\d{2}-\d{2}$/.test(key) && entry && typeof entry === "object") {
      next.checkins[key] = {
        reminders: clampNumber(entry.reminders, 0, 3, 0),
        done: Boolean(entry.done)
      };
    }
  });
  next.activeModal = ["chat", "task", "questionnaire"].includes(next.activeModal) ? next.activeModal : null;
  if (next.editingId && !next.activities.some((activity) => activity.id === next.editingId)) {
    next.editingId = null;
    if (next.activeModal === "task") next.activeModal = null;
  }
  return next;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function sanitizeProfile(input) {
  const source = input && typeof input === "object" ? input : {};
  return {
    workStart: sanitizeTime(source.workStart, ""),
    workEnd: sanitizeTime(source.workEnd, ""),
    peakStart: sanitizeTime(source.peakStart, ""),
    peakEnd: sanitizeTime(source.peakEnd, ""),
    maxFocusMin: clampNumber(source.maxFocusMin, 15, 240, 90),
    breakMin: clampNumber(source.breakMin, 5, 60, 15),
    drainingTasks: String(source.drainingTasks || "").slice(0, 500),
    energizingTasks: String(source.energizingTasks || "").slice(0, 500)
  };
}

function profileComplete() {
  const profile = state.profile || {};
  return Boolean(
    profile.workStart && profile.workEnd && profile.peakStart && profile.peakEnd &&
    String(profile.drainingTasks || "").trim() && String(profile.energizingTasks || "").trim()
  );
}

function geminiConnected() {
  return Boolean(localStorage.getItem(geminiKey));
}

function needsQuestionnaire() {
  return geminiConnected() && !profileComplete();
}

function sanitizeDateKey(value, fallback) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return fallback;
  const date = new Date(`${text}T00:00:00`);
  return Number.isNaN(date.getTime()) ? fallback : dateToKey(date);
}

function sanitizeTime(value, fallback) {
  const match = String(value || "").trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return fallback;
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function sanitizeKind(value) {
  return ["focus", "admin", "routine", "personal"].includes(value) ? value : "focus";
}

function sanitizeStatus(value) {
  return ["planned", "done", "partial", "missed", "blocked"].includes(value) ? value : "planned";
}

function sanitizeActivity(item) {
  if (!item || typeof item !== "object") return null;
  const title = String(item.title || "").trim().slice(0, 200);
  if (!title) return null;
  const recurrence = normalizeRecurrence(item.recurrence);
  const date = alignDateToRecurrence(sanitizeDateKey(item.date, todayKey()), recurrence);
  return {
    id: typeof item.id === "string" && item.id ? item.id : makeId(),
    title,
    project: normalizeProject(item.project),
    branch: normalizeBranch(item.branch),
    date,
    start: sanitizeTime(item.start, "09:00"),
    durationMin: clampNumber(item.durationMin, 5, 600, 30),
    kind: sanitizeKind(item.kind),
    recurrence,
    note: String(item.note || "").slice(0, 2000),
    status: sanitizeStatus(item.status),
    locked: typeof item.locked === "boolean" ? item.locked : inferLockedActivity(item),
    notify: item.notify !== false,
    notifyMin: clampNumber(item.notifyMin, 0, 120, 10),
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date().toISOString(),
    gcalEventId: typeof item.gcalEventId === "string" && item.gcalEventId ? item.gcalEventId : undefined,
    gcalSyncedAt: typeof item.gcalSyncedAt === "string" && item.gcalSyncedAt ? item.gcalSyncedAt : undefined,
    gcalInstanceOf: typeof item.gcalInstanceOf === "string" && item.gcalInstanceOf ? item.gcalInstanceOf : undefined
  };
}

function sanitizeNote(item) {
  if (!item || typeof item !== "object") return null;
  const text = String(item.text || "").trim().slice(0, 2000);
  if (!text) return null;
  return {
    id: typeof item.id === "string" && item.id ? item.id : makeId(),
    project: normalizeProject(item.project),
    branch: normalizeBranch(item.branch),
    section: noteSections().includes(item.section) ? item.section : "task_seeds",
    text,
    priority: clampNumber(item.priority, 1, 5, 3),
    linkedActivityId: typeof item.linkedActivityId === "string" ? item.linkedActivityId : undefined,
    createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString()
  };
}

function sanitizeBranchEntry(item) {
  if (!item || typeof item !== "object") return null;
  const name = normalizeBranch(item.name);
  return {
    id: typeof item.id === "string" && item.id ? item.id : makeId(),
    project: normalizeProject(item.project),
    name,
    status: ["active", "paused"].includes(item.status) ? item.status : "active",
    priority: clampNumber(item.priority, 1, 5, 3),
    goal: String(item.goal || "").slice(0, 500),
    createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString()
  };
}

function saveLocal() {
  localStorage.setItem(storageKey, JSON.stringify(state));
}

function persist(syncCloud = true) {
  saveLocal();
  if (syncCloud && firebaseRuntime && firebaseRuntime.ready && firebaseRuntime.user) {
    saveCloudState(firebaseRuntime, state).catch(() => toast("Saved locally. Firebase sync did not complete."));
  }
}

function announce(message) {
  state.lastMessage = message;
  persist();
  render();
  toast(message);
}

function routeName() {
  const hashRoute = location.hash.replace("#/", "");
  const raw = hashRoute || location.pathname.split("/").filter(Boolean).pop() || "today";
  if (raw === "checkin" || raw === "stats") return "stats";
  if (raw === "settings") return "settings";
  return "home";
}

function routePath(route) {
  if (route === "stats") return "./checkin";
  if (route === "settings") return "./settings";
  return "./today";
}

function navigate(route) {
  history.pushState({}, "", routePath(route));
  state.route = route;
  render();
}

window.addEventListener("popstate", render);

function render() {
  state.route = routeName();
  if (state.route === "stats" && state.settings.checkinEnabled) {
    const record = state.checkins[todayKey()];
    if (record && !record.done) {
      const parts = state.settings.checkinTime.split(":").map(Number);
      const base = new Date();
      base.setHours(parts[0], parts[1], 0, 0);
      if (record.reminders > 0 || Date.now() >= base.getTime()) {
        record.done = true;
        saveLocal();
      }
    }
  }
  document.querySelector("#app").innerHTML = `
    <main class="app">
      ${renderHeader()}
      ${state.route === "stats" ? renderStatsPage() : state.route === "settings" ? renderSettingsPage() : renderHomePage()}
    </main>
    ${renderModal()}
    <div class="toast hidden" role="status" aria-live="polite"></div>
  `;
  bindEvents();
}

function renderHeader() {
  return `
    <header class="topbar">
      <div>
        <h1>DayPilot</h1>
        <p>${state.activities.length ? `${state.activities.length} planned activities` : "A blank slate for the day."}</p>
      </div>
      <nav class="topnav" aria-label="Main navigation">
        <button class="${state.route === "home" ? "active" : ""}" data-route="home">Plan</button>
        <button class="${state.route === "stats" ? "active" : ""}" data-route="stats">Stats</button>
        <button class="${state.route === "settings" ? "active" : ""}" data-route="settings">Settings</button>
      </nav>
    </header>
  `;
}

function renderHomePage() {
  return `
    <section class="home">
      ${renderMoodPanel()}
      ${renderFirebaseBanner()}
      <section class="planner-panel">
        <div class="planner-head">
          <div class="segmented" role="tablist" aria-label="Calendar view">
            ${["day", "week", "month"].map((view) => `<button class="${state.view === view ? "active" : ""}" data-view="${view}">${titleCase(view)}</button>`).join("")}
          </div>
          <div class="quick-actions">
            ${calendarReady() ? `<button class="icon-button" data-action="sync-gcal" aria-label="Sync Google Calendar">Sync</button>` : ""}
            <button class="icon-button primary" data-open-modal="chat" aria-label="Open chat dump">Chat</button>
            <button class="icon-button" data-open-modal="task" aria-label="Add task">+</button>
          </div>
        </div>
        ${renderActivityView()}
      </section>
      ${renderProjectPanel()}
    </section>
  `;
}

function renderMoodPanel() {
  return `
    <section class="mood-panel" aria-label="Mood tracking">
      <div>
        <h2>Mood</h2>
        <p data-mood-summary>${escapeHtml(state.mood.label)} - energy ${state.mood.energy}% - stress ${state.mood.stress}%</p>
      </div>
      <label>
        Feeling
        <input data-mood="label" maxlength="60" value="${escapeAttr(state.mood.label)}" aria-label="Mood label">
      </label>
      <label>
        Energy
        <input type="range" min="0" max="100" value="${state.mood.energy}" data-mood="energy" aria-label="Energy">
      </label>
      <label>
        Stress
        <input type="range" min="0" max="100" value="${state.mood.stress}" data-mood="stress" aria-label="Stress">
      </label>
    </section>
  `;
}

function renderFirebaseBanner() {
  if (firebaseRuntime && firebaseRuntime.ready && firebaseRuntime.user) {
    return `
      <section class="sync-banner good">
        <strong>Firebase sync on</strong>
        <span>${escapeHtml(firebaseRuntime.user.email || "Signed in")}</span>
      </section>
    `;
  }
  if (firebaseRuntime && firebaseRuntime.ready) {
    return `
      <section class="sync-banner">
        <strong>Firebase configured, sign-in pending.</strong>
        <span>Cloud sync, cross-device restore, and account backup start after Google sign-in.</span>
        <button data-action="google-signin">Sign in</button>
      </section>
    `;
  }
  return `
    <section class="sync-banner warn">
      <strong>Firebase is not configured.</strong>
      <span>No cloud sync, no cross-device restore, no account backup, and no synced settings yet.</span>
      <button data-route="settings">Set up</button>
    </section>
  `;
}

function renderActivityView() {
  if (!state.activities.length) {
    return `
      <div class="empty-state">
        <h2>Nothing planned yet</h2>
        <p>Dump your day into chat, or add one task by hand.</p>
        <div class="button-row">
          <button class="primary" data-open-modal="chat">Open chat dump</button>
          <button data-open-modal="task">Add a task</button>
        </div>
      </div>
    `;
  }
  if (state.view === "week") return renderWeekView();
  if (state.view === "month") return renderMonthView();
  return renderDayView();
}

function renderDayView() {
  const today = todayKey();
  const items = sortedActivities().filter((activity) => activity.date === today);
  return renderActivityList(items.length ? items : sortedActivities(), "day-list");
}

function renderWeekView() {
  const days = weekKeys();
  return `
    <div class="week-view">
      ${days.map((day) => `
        <section class="day-column">
          <h3>${formatDay(day)}</h3>
          ${renderActivityList(sortedActivities().filter((activity) => activity.date === day), "compact-list")}
        </section>
      `).join("")}
    </div>
  `;
}

function renderMonthView() {
  const grouped = groupByDate(sortedActivities());
  const days = Object.keys(grouped).sort();
  return `
    <div class="month-view">
      ${days.length ? days.map((day) => `
        <section>
          <h3>${formatDay(day)}</h3>
          ${renderActivityList(grouped[day], "compact-list")}
        </section>
      `).join("") : `<p class="muted">Nothing scheduled this month.</p>`}
    </div>
  `;
}

function renderActivityList(items, className) {
  if (!items.length) return `<p class="muted">Free.</p>`;
  return `
    <div class="${className}">
      ${items.map((activity) => `
        <button class="activity-card ${escapeAttr(activity.kind)}" data-edit="${escapeAttr(activity.id)}">
          <span>${formatTime(activity.start)}</span>
          <strong>${escapeHtml(activity.title)}</strong>
          <em>${escapeHtml(activity.project || "Inbox")} / ${escapeHtml(activity.branch || "Main")} - ${activity.durationMin}m - ${escapeHtml(activity.status || "planned")}${activity.locked ? " - fixed" : ""}${activity.recurrence ? ` - ${escapeHtml(recurrenceLabel(activity.recurrence))}` : ""}</em>
        </button>
      `).join("")}
    </div>
  `;
}

function renderProjectPanel() {
  const projects = projectNames();
  const selected = projects.includes(state.selectedProject) ? state.selectedProject : projects[0];
  const notes = state.projectNotes.filter((note) => note.project === selected);
  const branches = state.branches.filter((branch) => branch.project === selected);
  return `
    <section class="project-panel">
      <div class="project-head">
        <div>
          <h2>Projects & notes</h2>
          <p>Thinking board, not a database.</p>
        </div>
        <label>
          Project
          <select data-project-select>
            ${projects.map((project) => `<option value="${escapeAttr(project)}" ${selected === project ? "selected" : ""}>${escapeHtml(project)}</option>`).join("")}
          </select>
        </label>
      </div>
      <div class="project-grid">
        <section>
          <h3>Notes board</h3>
          <form class="note-form" data-form="project-note">
            <select name="section" aria-label="Note section">
              ${noteSections().map((section) => `<option value="${section}">${sectionLabel(section)}</option>`).join("")}
            </select>
            <textarea name="text" placeholder="decision: use calibration as optional contribution&#10;blocked: waiting for reply"></textarea>
            <div class="button-row">
              <button class="primary" type="submit">Save note</button>
              <button type="button" data-action="note-to-task">Turn latest into task</button>
            </div>
          </form>
          <div class="notes-board">
            ${notes.length
              ? noteSections().map((section) => renderNoteSection(section, notes)).join("")
              : `<p class="muted board-hint">No notes for this project yet. Save one above - decisions, blockers, and ideas all get their own shelf.</p>`}
          </div>
        </section>
        <section>
          <h3>Branches</h3>
          <form class="branch-form" data-form="branch">
            <input name="name" placeholder="Paper submission, calibration extension...">
            <button class="primary" type="submit">Add branch</button>
          </form>
          <div class="branch-list">
            ${branches.length ? branches.map(renderBranch).join("") : `<p class="muted">No branches yet. Tasks can still use Main.</p>`}
          </div>
        </section>
      </div>
    </section>
  `;
}

function renderNoteSection(section, notes) {
  const sectionNotes = notes.filter((note) => note.section === section);
  if (!sectionNotes.length) return "";
  return `
    <section class="note-section">
      <h4>${sectionLabel(section)}</h4>
      ${sectionNotes.length ? sectionNotes.map((note) => `
        <article class="note-card">
          <p>${escapeHtml(note.text)}</p>
          <span>${escapeHtml(note.branch || "Main")} - ${note.priority || 3}/5</span>
        </article>
      `).join("") : `<p class="muted">Empty.</p>`}
    </section>
  `;
}

function renderBranch(branch) {
  return `
    <article class="branch-card">
      <div>
        <strong>${escapeHtml(branch.name)}</strong>
        <span>${escapeHtml(branch.status)} - priority ${branch.priority}</span>
      </div>
      <div class="branch-actions">
        <button data-branch-action="boost" data-branch-id="${escapeAttr(branch.id)}">Boost</button>
        <button data-branch-action="pause" data-branch-id="${escapeAttr(branch.id)}">Pause</button>
        <button data-branch-action="plan" data-branch-id="${escapeAttr(branch.id)}">Plan next week</button>
        <button data-branch-action="next" data-branch-id="${escapeAttr(branch.id)}">Next action</button>
      </div>
    </article>
  `;
}

function renderStatsPage() {
  const completeCount = state.activities.filter((activity) => activity.status === "done").length;
  const count = state.activities.length;
  const computed = count ? Math.round((completeCount / count) * 100) : 0;
  const workDone = Number(state.settings.workDone || computed);
  const exhaustion = Number(state.settings.exhaustion || 0);
  return `
    <section class="stats-page">
      <div class="page-head">
        <h2>Accountability</h2>
        <p>Not guilt. Just capacity data.</p>
      </div>
      <section class="metric-grid">
        <div class="metric-card">
          <span>Work done</span>
          <strong>${workDone}%</strong>
          <input type="range" min="0" max="100" value="${workDone}" data-setting="workDone" aria-label="Work done percentage">
        </div>
        <div class="metric-card warm">
          <span>Exhaustion</span>
          <strong>${exhaustion}%</strong>
          <input type="range" min="0" max="100" value="${exhaustion}" data-setting="exhaustion" aria-label="Exhaustion percentage">
        </div>
        <div class="metric-card calm">
          <span>Completed</span>
          <strong>${completeCount}/${count}</strong>
          <p>${count ? "Tune tomorrow from what actually happened." : "Add tasks first, then check in here."}</p>
        </div>
      </section>
      <section class="planner-panel">
        <h3>Activity check-in</h3>
        ${state.activities.length ? state.activities.map((activity) => `
          <article class="check-row">
            <div>
              <strong>${escapeHtml(activity.title)}</strong>
              <span>${formatDate(activity.date)} ${formatTime(activity.start)}</span>
            </div>
            <div class="status-buttons">
              ${["done", "partial", "missed"].map((status) => `<button class="${activity.status === status ? "active" : ""}" data-status="${status}" data-status-id="${escapeAttr(activity.id)}">${titleCase(status)}</button>`).join("")}
            </div>
          </article>
        `).join("") : `<p class="muted">No activities to check in yet.</p>`}
      </section>
    </section>
  `;
}

function renderSettingsPage() {
  const firebaseConfig = localStorage.getItem(firebaseKey) || "";
  const token = localStorage.getItem(geminiKey) || "";
  const savedConfig = readFirebaseConfig();
  const projectId = savedConfig && savedConfig.projectId ? savedConfig.projectId : "";
  const authSettingsUrl = firebaseConsoleUrl(projectId, "authentication/settings");
  const authProvidersUrl = firebaseConsoleUrl(projectId, "authentication/providers");
  const firestoreUrl = firebaseConsoleUrl(projectId, "firestore/databases");
  return `
    <section class="settings-page">
      <div class="page-head">
        <h2>Settings</h2>
        <p>Follow these steps once. Firebase config and Gemini token stay in this browser.</p>
      </div>
      <section class="settings-card">
        <div class="settings-title">
          <div>
            <h3>Firebase sync</h3>
            <p class="muted">Use this for cloud sync, account backup, and settings sync.</p>
          </div>
          <a class="external-link" href="${authSettingsUrl}" target="_blank" rel="noreferrer">Open Firebase Console</a>
        </div>
        ${authNotice ? `
          <div class="setup-alert">
            <strong>Google sign-in needs one Firebase console fix.</strong>
            <span>${escapeHtml(authNotice)}</span>
            <div class="button-row">
              <a class="external-link" href="${authSettingsUrl}" target="_blank" rel="noreferrer">Open authorized domains</a>
              <button data-action="copy-auth-domain">Copy domain</button>
            </div>
          </div>
        ` : ""}
        <ol class="setup-steps">
          <li>
            <strong>Create or open your own Firebase project.</strong>
            <span>Click Add project if you do not have one. Keep it on the free Spark plan. Every user brings their own project - this app ships with no shared backend, so your data lives only in your project.</span>
          </li>
          <li>
            <strong>Enable Google sign-in.</strong>
            <span>Open <a href="${authProvidersUrl}" target="_blank" rel="noreferrer">Authentication -> Sign-in method</a>, click Google, enable it, and save.</span>
          </li>
          <li>
            <strong>Create a Web App.</strong>
            <span>Inside the project, go to Project settings -> General -> Your apps -> Web app (&lt;/&gt;).</span>
          </li>
          <li>
            <strong>Copy the Firebase config object.</strong>
            <span>Firebase shows code containing <code>const firebaseConfig = {...}</code>. Copy only the JSON-like object inside the braces.</span>
          </li>
          <li>
            <strong>Authorize this website for sign-in.</strong>
            <span>Open <a href="${authSettingsUrl}" target="_blank" rel="noreferrer">Authentication -> Settings -> Authorized domains</a>, click Add domain, and add exactly:</span>
            <span class="copy-line"><code>${escapeHtml(location.hostname)}</code><button data-action="copy-auth-domain">Copy</button></span>
          </li>
          <li>
            <strong>Create Firestore.</strong>
            <span>Open <a href="${firestoreUrl}" target="_blank" rel="noreferrer">Firestore Database</a>, click Create database, and keep the free defaults unless you know you need another region.</span>
          </li>
          <li>
            <strong>Paste it below and save.</strong>
            <span>Then click Google sign-in. If it fails, this page will show the exact Firebase console page and exact domain to add for this deployment.</span>
          </li>
        </ol>
        <div class="setup-hint">
          <strong>Current setup values</strong>
          <span>Firebase project: <code>${escapeHtml(projectId || "not saved yet")}</code></span>
          <span>Authorized domain for Firebase Auth: <code>${escapeHtml(location.hostname)}</code></span>
          <span>Authorized origin for Google Calendar OAuth: <code>${escapeHtml(location.origin)}</code></span>
        </div>
        <div class="example-box">
          <strong>Paste something shaped like this:</strong>
          <code>{"apiKey":"...","authDomain":"your-project.firebaseapp.com","projectId":"your-project","appId":"..."}</code>
        </div>
        <textarea class="code-input" data-config="firebase" placeholder='{"apiKey":"...","authDomain":"...","projectId":"...","appId":"..."}'>${escapeHtml(firebaseConfig)}</textarea>
        <div class="button-row">
          <button class="primary" data-action="save-firebase">Save Firebase config</button>
          <button data-action="google-signin">${firebaseRuntime && firebaseRuntime.user ? "Switch account" : "Google sign-in"}</button>
          <button data-action="google-signout">Sign out</button>
        </div>
      </section>
      <section class="settings-card" id="token">
        <div class="settings-title">
          <div>
            <h3>Gemini token</h3>
            <p class="muted">Needed only for Gemini chat parsing. No-LLM chat works without it.</p>
          </div>
          <a class="external-link" href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer">Open AI Studio keys</a>
        </div>
        <ol class="setup-steps">
          <li>
            <strong>Open Google AI Studio API keys.</strong>
            <span>Use the button above.</span>
          </li>
          <li>
            <strong>Create an API key.</strong>
            <span>Copy the key. It usually starts with <code>AIza...</code>.</span>
          </li>
          <li>
            <strong>Paste it below and save.</strong>
            <span>This token is stored only in this browser. It is not committed to the repo.</span>
          </li>
        </ol>
        <input type="password" data-secret="gemini" value="${escapeAttr(token)}" placeholder="Gemini API key">
        <div class="button-row">
          <button class="primary" data-action="save-gemini">Save token</button>
          <button data-action="clear-gemini">Clear token</button>
        </div>
      </section>
      <section class="settings-card">
        <div class="settings-title">
          <div>
            <h3>Google Calendar (2-way sync)</h3>
            <p class="muted">${calendarReady()
              ? `Linked to a calendar named "Planny".${state.calendar.lastSync ? ` Last sync ${new Date(state.calendar.lastSync).toLocaleString()}.` : ""}`
              : "Tasks push into a dedicated \"Planny\" calendar, and events you add or edit there flow back here. Uses the same Google account you sync with."}</p>
          </div>
          <a class="external-link" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Open Google Cloud credentials</a>
        </div>
        <ol class="setup-steps">
          <li>
            <strong>Enable the Calendar API once.</strong>
            <span>Open <a href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com" target="_blank" rel="noreferrer">Google Calendar API</a>, pick the same project as your Firebase setup (every Firebase project is also a Google Cloud project), and click Enable.</span>
          </li>
          <li>
            <strong>Create an OAuth client ID.</strong>
            <span>Use the credentials button above: Create credentials -> OAuth client ID -> Web application. If asked to configure a consent screen first, choose External, add yourself as a test user, and save.</span>
          </li>
          <li>
            <strong>Add this app as an authorized JavaScript origin.</strong>
            <span>Copy exactly:</span>
            <span class="copy-line"><code>${escapeHtml(location.origin)}</code><button data-action="copy-calendar-origin">Copy</button></span>
          </li>
          <li>
            <strong>Paste the client ID below, save, then connect.</strong>
            <span>Connect asks Google for calendar permission, then finds or creates your "Planny" calendar automatically.</span>
          </li>
        </ol>
        <input data-config="gcal-client" value="${escapeAttr(getCalendarClientId())}" placeholder="1234567890-abc123.apps.googleusercontent.com">
        <div class="button-row">
          <button class="primary" data-action="save-gcal-client">Save client ID</button>
          <button data-action="connect-gcal">${calendarReady() ? "Reconnect" : "Connect & create Planny calendar"}</button>
          ${calendarReady() ? `<button data-action="sync-gcal">Sync now</button><button data-action="disconnect-gcal">Disconnect</button>` : ""}
        </div>
      </section>
      <section class="settings-card">
        <div class="settings-title">
          <div>
            <h3>Planning profile</h3>
            <p class="muted">${profileComplete()
              ? `Work ${escapeHtml(state.profile.workStart)}-${escapeHtml(state.profile.workEnd)}, peak focus ${escapeHtml(state.profile.peakStart)}-${escapeHtml(state.profile.peakEnd)}, blocks up to ${state.profile.maxFocusMin}m.`
              : "Not filled in yet. Required before Gemini planning; the offline parser also uses it for productive slots."}</p>
          </div>
        </div>
        <div class="button-row">
          <button class="primary" data-action="edit-profile">${profileComplete() ? "Edit planning profile" : "Fill planning profile"}</button>
        </div>
      </section>
      <section class="settings-card">
        <div class="settings-title">
          <div>
            <h3>Daily check-in reminder</h3>
            <p class="muted">${state.settings.checkinEnabled
              ? `On - reminds at ${formatTime(state.settings.checkinTime)}${state.settings.checkinText ? ` ("${escapeHtml(state.settings.checkinText)}")` : ""}, then twice more 10 minutes apart if you have not checked in.`
              : "A web notification that opens the accountability page. Repeats up to 3 times, 10 minutes apart, until you check in. Works while DayPilot is open in a tab or installed as an app."}</p>
          </div>
        </div>
        <div class="form-grid">
          <label>Fixed time <input type="time" data-checkin-time value="${escapeAttr(state.settings.checkinTime)}"></label>
          <label>Or say it in words <input data-checkin-text maxlength="120" value="${escapeAttr(state.settings.checkinText)}" placeholder="quarter past 9 in the evening, after dinner..."></label>
        </div>
        <div class="button-row">
          <button class="primary" data-action="save-checkin">${state.settings.checkinEnabled ? "Update reminder" : "Turn on reminder"}</button>
          <button data-action="test-checkin">Send test notification</button>
          ${state.settings.checkinEnabled ? `<button data-action="disable-checkin">Turn off</button>` : ""}
        </div>
      </section>
      <section class="settings-card">
        <h3>Synced app settings</h3>
        <label>
          Default chat mode
          <select data-setting="parserMode">
            <option value="manual" ${state.settings.parserMode === "manual" ? "selected" : ""}>No-LLM</option>
            <option value="gemini" ${state.settings.parserMode === "gemini" ? "selected" : ""}>Gemini</option>
          </select>
        </label>
      </section>
    </section>
  `;
}

function renderModal() {
  if (state.activeModal === "chat") return renderChatModal();
  if (state.activeModal === "task") return renderTaskModal();
  if (state.activeModal === "questionnaire") return renderQuestionnaireModal();
  if (state.activeModal === "confirm-parse") return renderConfirmParseModal();
  if (state.activeModal === "recurring-scope") return renderRecurringScopeModal();
  return "";
}

function renderRecurringScopeModal() {
  const pending = state.pendingRecurringEdit;
  const title = pending && pending.updated ? pending.updated.title : "This task";
  return `
    <div class="modal-backdrop" role="presentation">
      <section class="modal" role="dialog" aria-modal="true" aria-label="Apply to series?">
        <header>
          <h2>This task repeats</h2>
        </header>
        <p class="muted">"${escapeHtml(title)}" is a recurring task. Where should these changes apply? This covers every setting, including the calendar alert.</p>
        <div class="button-row">
          <button class="primary" data-action="recurring-apply-one">Only this occurrence</button>
          <button data-action="recurring-apply-all">This and all future occurrences</button>
          <button data-action="recurring-cancel">Cancel</button>
        </div>
      </section>
    </div>
  `;
}

function renderQuestionnaireModal() {
  const profile = state.profile;
  return `
    <div class="modal-backdrop" role="presentation">
      <section class="modal" role="dialog" aria-modal="true" aria-label="Planning profile">
        <header>
          <h2>Tell the planner how you work</h2>
        </header>
        <p class="muted">Required once for Gemini planning. Answers sync to your account and power requests like "schedule four productive slots without draining me".</p>
        <form data-form="questionnaire">
          <div class="form-grid">
            <label>Work usually starts <input type="time" name="workStart" required value="${escapeAttr(profile.workStart)}"></label>
            <label>Work usually ends <input type="time" name="workEnd" required value="${escapeAttr(profile.workEnd)}"></label>
          </div>
          <div class="form-grid">
            <label>Peak focus from <input type="time" name="peakStart" required value="${escapeAttr(profile.peakStart)}"></label>
            <label>Peak focus until <input type="time" name="peakEnd" required value="${escapeAttr(profile.peakEnd)}"></label>
          </div>
          <div class="form-grid">
            <label>Max deep-focus minutes <input type="number" name="maxFocusMin" min="15" max="240" step="5" required value="${profile.maxFocusMin}"></label>
            <label>Break between slots (min) <input type="number" name="breakMin" min="5" max="60" step="5" required value="${profile.breakMin}"></label>
          </div>
          <label>Tasks that drain you <textarea name="drainingTasks" required placeholder="grading, admin email, long meetings, debugging without a plan...">${escapeHtml(profile.drainingTasks)}</textarea></label>
          <label>Work you can do tired or that energizes you <textarea name="energizingTasks" required placeholder="plotting results, light reading, tidying notes, quick replies...">${escapeHtml(profile.energizingTasks)}</textarea></label>
          <div class="button-row">
            <button class="primary" type="submit">Save profile</button>
            ${needsQuestionnaire()
              ? `<button type="button" data-action="disconnect-gemini">Disconnect Gemini instead</button>`
              : `<button type="button" data-close-modal="true">Cancel</button>`}
          </div>
        </form>
      </section>
    </div>
  `;
}

function renderConfirmParseModal() {
  const pending = state.pendingParse || { activities: [], notes: [] };
  return `
    <div class="modal-backdrop" role="presentation">
      <section class="modal" role="dialog" aria-modal="true" aria-label="Confirm parsed plan">
        <header>
          <h2>I made this - add it?</h2>
          <button data-action="discard-parse" aria-label="Back to chat">Back</button>
        </header>
        <p class="muted">Untick anything you do not want, then add. Nothing is saved until you confirm.</p>
        ${pending.activities.length ? `
          <h3>Tasks</h3>
          <div class="confirm-list">
            ${pending.activities.map((activity, index) => `
              <label class="confirm-item">
                <input type="checkbox" checked data-confirm-activity="${index}">
                <span>
                  <strong>${escapeHtml(activity.title)}</strong>
                  <em>${formatDate(activity.date)} ${formatTime(activity.start)} - ${activity.durationMin}m - ${escapeHtml(activity.project)} / ${escapeHtml(activity.branch)}${activity.locked ? " - fixed" : ""}${activity.recurrence ? ` - ${escapeHtml(recurrenceLabel(activity.recurrence))}` : ""}</em>
                </span>
              </label>
            `).join("")}
          </div>
        ` : ""}
        ${pending.notes.length ? `
          <h3>Notes</h3>
          <div class="confirm-list">
            ${pending.notes.map((note, index) => `
              <label class="confirm-item">
                <input type="checkbox" checked data-confirm-note="${index}">
                <span>
                  <strong>${escapeHtml(sectionLabel(note.section))}</strong>
                  <em>${escapeHtml(note.text.slice(0, 140))}</em>
                </span>
              </label>
            `).join("")}
          </div>
        ` : ""}
        ${!pending.activities.length && !pending.notes.length ? `<p class="muted">Nothing was parsed.</p>` : ""}
        <div class="button-row">
          <button class="primary" data-action="confirm-parse">Add selected</button>
          <button data-action="discard-parse">Discard</button>
        </div>
      </section>
    </div>
  `;
}

function renderChatModal() {
  const hasToken = Boolean(localStorage.getItem(geminiKey));
  const mode = state.settings.parserMode;
  return `
    <div class="modal-backdrop" role="presentation" data-close-modal="true">
      <section class="modal" role="dialog" aria-modal="true" aria-label="Chat dump">
        <header>
          <h2>Chat dump</h2>
          <button data-close-modal="true" aria-label="Close chat">Close</button>
        </header>
        <div class="segmented">
          <button class="${mode === "manual" ? "active" : ""}" data-chat-mode="manual">No-LLM</button>
          <button class="${mode === "gemini" ? "active" : ""}" data-chat-mode="gemini">Gemini</button>
        </div>
        ${mode === "gemini" && !hasToken ? `
          <div class="sync-banner warn">
            <strong>Gemini token missing.</strong>
            <span>Add a token to use natural-language parsing.</span>
            <button data-action="token-settings">Open token settings</button>
          </div>
        ` : ""}
        ${state.chatClarify ? `
          <div class="sync-banner">
            <strong>Gemini asks:</strong>
            <span>${escapeHtml(state.chatClarify.question)}</span>
          </div>
        ` : ""}
        <textarea data-chat-input placeholder="${state.chatClarify ? "Type your answer to the question above" : "Dump tasks, routines, edits, or reschedule requests. Example: tomorrow 9:30 write intro 90m, or: schedule four productive slots"}">${escapeHtml(state.chatDraft)}</textarea>
        <div class="button-row">
          <button class="primary" data-action="submit-chat">${state.chatClarify ? "Answer & plan" : "Add from chat"}</button>
          <button data-close-modal="true">Cancel</button>
        </div>
      </section>
    </div>
  `;
}

function renderTaskModal() {
  const editing = getEditingActivity();
  const activity = editing || emptyActivity();
  return `
    <div class="modal-backdrop" role="presentation" data-close-modal="true">
      <section class="modal" role="dialog" aria-modal="true" aria-label="${editing ? "Edit activity" : "Add activity"}">
        <header>
          <h2>${editing ? "Edit activity" : "Add activity"}</h2>
          <button data-close-modal="true" aria-label="Close task editor">Close</button>
        </header>
        <form data-form="task">
          <label>Title <input name="title" required value="${escapeAttr(activity.title)}"></label>
          <div class="form-grid">
            <label>Project <input name="project" value="${escapeAttr(activity.project || state.selectedProject || "Inbox")}"></label>
            <label>Branch <input name="branch" value="${escapeAttr(activity.branch || "Main")}"></label>
          </div>
          <div class="form-grid">
            <label>Date <input type="date" name="date" value="${escapeAttr(activity.date)}"></label>
            <label>Start <input type="time" name="start" value="${escapeAttr(activity.start)}"></label>
            <label>Minutes <input type="number" min="5" max="600" step="5" name="durationMin" value="${clampNumber(activity.durationMin, 5, 600, 30)}"></label>
            <label>Repeats <input name="recurrence" value="${escapeAttr(recurrenceInputValue(activity.recurrence))}" placeholder="every Wednesday, daily, weekly"></label>
            <label>Type
              <select name="kind">
                ${["focus", "admin", "routine", "personal"].map((kind) => `<option value="${kind}" ${activity.kind === kind ? "selected" : ""}>${titleCase(kind)}</option>`).join("")}
              </select>
            </label>
          </div>
          <div class="form-grid">
            <label>Calendar alert
              <select name="notify">
                <option value="yes" ${activity.notify !== false ? "selected" : ""}>On</option>
                <option value="no" ${activity.notify === false ? "selected" : ""}>Off</option>
              </select>
            </label>
            <label>Minutes before <input type="number" min="0" max="120" step="5" name="notifyMin" value="${clampNumber(activity.notifyMin, 0, 120, 10)}"></label>
            <label>Rescheduling
              <select name="locked">
                <option value="no" ${activity.locked ? "" : "selected"}>Flexible</option>
                <option value="yes" ${activity.locked ? "selected" : ""}>Fixed time</option>
              </select>
            </label>
          </div>
          <label>Task notes <textarea name="note" placeholder="Needs fresh brain. Blocked until reply. For next time start from table...">${escapeHtml(activity.note || "")}</textarea></label>
          ${editing ? `<div class="signal-box">${renderNoteSignals(activity.note || "")}</div>` : ""}
          <div class="button-row">
            <button class="primary" type="submit">${editing ? "Save changes" : "Add task"}</button>
            ${editing ? `<button type="button" data-action="task-note-subtask">Turn note into subtask</button><button type="button" data-action="task-note-project">Save as project note</button><button type="button" data-action="task-note-replan">Use note to replan</button>` : ""}
            ${editing ? `<button class="danger" type="button" data-action="delete-activity">Delete</button>` : ""}
            <button type="button" data-close-modal="true">Cancel</button>
          </div>
        </form>
      </section>
    </div>
  `;
}

function bindEvents() {
  document.querySelectorAll("[data-route]").forEach((button) => {
    button.addEventListener("click", () => navigate(button.dataset.route));
  });

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      persist();
      render();
    });
  });

  document.querySelectorAll("[data-mood]").forEach((input) => {
    const apply = () => {
      const key = input.dataset.mood;
      state.mood[key] = key === "label" ? input.value.slice(0, 60) : clampNumber(input.value, 0, 100, 50);
    };
    input.addEventListener("input", () => {
      apply();
      const summary = document.querySelector("[data-mood-summary]");
      if (summary) summary.textContent = `${state.mood.label} - energy ${state.mood.energy}% - stress ${state.mood.stress}%`;
    });
    input.addEventListener("change", () => {
      apply();
      persist();
      render();
    });
  });

  document.querySelectorAll("[data-open-modal]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeModal = button.dataset.openModal;
      state.editingId = null;
      render();
    });
  });

  document.querySelectorAll("[data-close-modal]").forEach((element) => {
    element.addEventListener("click", (event) => {
      if (event.target !== element && element.classList.contains("modal-backdrop")) return;
      state.activeModal = null;
      state.editingId = null;
      state.chatClarify = null;
      render();
    });
  });

  document.querySelectorAll("[data-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      state.editingId = button.dataset.edit;
      state.activeModal = "task";
      render();
    });
  });

  document.querySelectorAll("[data-chat-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      const chatField = document.querySelector("[data-chat-input]");
      if (chatField) state.chatDraft = chatField.value;
      state.settings.parserMode = button.dataset.chatMode;
      if (button.dataset.chatMode === "gemini" && needsQuestionnaire()) {
        state.questionnaireReturn = "chat";
        state.activeModal = "questionnaire";
        toast("Answer these once so Gemini can plan around your energy.");
      }
      persist();
      render();
    });
  });

  const chatInput = document.querySelector("[data-chat-input]");
  if (chatInput) {
    chatInput.addEventListener("input", () => {
      state.chatDraft = chatInput.value;
    });
    chatInput.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        submitChat();
      }
    });
  }

  const chatSubmit = document.querySelector("[data-action='submit-chat']");
  if (chatSubmit) chatSubmit.addEventListener("click", submitChat);
  const taskForm = document.querySelector("[data-form='task']");
  if (taskForm) taskForm.addEventListener("submit", submitTaskForm);

  document.querySelectorAll("[data-setting]").forEach((input) => {
    const apply = () => {
      state.settings[input.dataset.setting] = input.type === "range" ? clampNumber(input.value, 0, 100, 0) : input.value;
    };
    input.addEventListener("input", () => {
      apply();
      if (input.type === "range") {
        const readout = input.parentElement && input.parentElement.querySelector("strong");
        if (readout) readout.textContent = `${state.settings[input.dataset.setting]}%`;
      }
    });
    input.addEventListener("change", () => {
      apply();
      persist();
      render();
    });
  });

  document.querySelectorAll("[data-status-id]").forEach((button) => {
    button.addEventListener("click", () => {
      updateActivity(button.dataset.statusId, { status: button.dataset.status });
      markCheckinDone();
      announce("Check-in saved.");
    });
  });

  const projectSelect = document.querySelector("[data-project-select]");
  if (projectSelect) {
    projectSelect.addEventListener("change", () => {
      state.selectedProject = projectSelect.value;
      persist();
      render();
    });
  }

  const noteForm = document.querySelector("[data-form='project-note']");
  if (noteForm) noteForm.addEventListener("submit", submitProjectNote);
  const branchForm = document.querySelector("[data-form='branch']");
  if (branchForm) branchForm.addEventListener("submit", submitBranch);
  const questionnaireForm = document.querySelector("[data-form='questionnaire']");
  if (questionnaireForm) questionnaireForm.addEventListener("submit", submitQuestionnaire);

  document.querySelectorAll("[data-branch-action]").forEach((button) => {
    button.addEventListener("click", () => handleBranchAction(button.dataset.branchAction, button.dataset.branchId));
  });

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => handleAction(button.dataset.action));
  });
}

async function handleAction(action) {
  if (action === "token-settings") {
    state.activeModal = null;
    navigate("settings");
    setTimeout(() => {
      const tokenPanel = document.querySelector("#token");
      if (tokenPanel) tokenPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
    return;
  }
  if (action === "save-firebase") {
    saveFirebaseConfig();
    return;
  }
  if (action === "edit-profile") {
    state.questionnaireReturn = null;
    state.activeModal = "questionnaire";
    render();
    return;
  }
  if (action === "save-gemini") {
    const token = document.querySelector("[data-secret='gemini']").value.trim();
    if (!token) {
      toast("Paste a Gemini API key first, or use Clear token.");
      return;
    }
    localStorage.setItem(geminiKey, token);
    if (needsQuestionnaire()) {
      state.questionnaireReturn = null;
      state.activeModal = "questionnaire";
      toast("Token saved. Answer these once so Gemini can plan around your energy.");
      render();
      return;
    }
    toast("Gemini token saved locally.");
    return;
  }
  if (action === "clear-gemini" || action === "disconnect-gemini") {
    localStorage.removeItem(geminiKey);
    state.settings.parserMode = "manual";
    if (state.activeModal === "questionnaire") state.activeModal = null;
    state.questionnaireReturn = null;
    persist();
    render();
    toast("Gemini disconnected. No-LLM chat still works offline.");
    return;
  }
  if (action === "google-signin") {
    try {
      await signIn(firebaseRuntime);
      firebaseRuntime = await initFirebase(readFirebaseConfig());
      authNotice = "";
      persist();
      render();
    } catch (error) {
      authNotice = friendlyAuthError(error);
      navigate("settings");
      toast(authNotice);
    }
    return;
  }
  if (action === "copy-auth-domain") {
    await copyToClipboard(location.hostname, "Firebase Auth domain copied.");
    return;
  }
  if (action === "copy-calendar-origin") {
    await copyToClipboard(location.origin, "Google Calendar origin copied.");
    return;
  }
  if (action === "google-signout") {
    try {
      await signOut(firebaseRuntime);
      firebaseRuntime.user = null;
      render();
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  if (action === "delete-activity") {
    const target = getEditingActivity();
    if (target && target.gcalEventId) state.calendarTombstones.push(target.gcalEventId);
    state.activities = state.activities.filter((activity) => activity.id !== state.editingId);
    state.activeModal = null;
    state.editingId = null;
    announce("Activity deleted.");
    if (target && target.gcalEventId && calendarReady() && hasValidToken()) syncCalendarNow(false);
    return;
  }
  if (action === "save-gcal-client") {
    const value = document.querySelector("[data-config='gcal-client']").value.trim();
    if (!value) {
      setCalendarClientId("");
      clearCalendarToken();
      state.calendar = { calendarId: "", lastSync: "" };
      persist();
      render();
      toast("Google Calendar client ID cleared.");
      return;
    }
    if (!/\.apps\.googleusercontent\.com$/.test(value)) {
      toast("That does not look like an OAuth client ID. It ends with .apps.googleusercontent.com");
      return;
    }
    setCalendarClientId(value);
    render();
    toast("Client ID saved. Now click Connect & create Planny calendar.");
    return;
  }
  if (action === "connect-gcal" || action === "sync-gcal") {
    await syncCalendarNow(true);
    return;
  }
  if (action === "disconnect-gcal") {
    clearCalendarToken();
    state.calendar = { calendarId: "", lastSync: "" };
    state.activities.forEach((activity) => {
      delete activity.gcalEventId;
      delete activity.gcalSyncedAt;
    });
    state.calendarTombstones = [];
    persist();
    render();
    toast("Calendar disconnected. The Planny calendar stays in Google Calendar; events are no longer linked.");
    return;
  }
  if (action === "task-note-subtask") {
    createSubtaskFromEditingNote();
    return;
  }
  if (action === "task-note-project") {
    saveEditingNoteToProject();
    return;
  }
  if (action === "task-note-replan") {
    applyEditingNoteSignals();
    return;
  }
  if (action === "note-to-task") {
    createTaskFromLatestProjectNote();
    return;
  }
  if (action === "confirm-parse") {
    confirmPendingParse();
    return;
  }
  if (action === "recurring-apply-one") {
    applyRecurringEdit("one");
    return;
  }
  if (action === "recurring-apply-all") {
    applyRecurringEdit("all");
    return;
  }
  if (action === "recurring-cancel") {
    const pending = state.pendingRecurringEdit;
    state.pendingRecurringEdit = null;
    state.activeModal = "task";
    state.editingId = pending ? pending.originalId : state.editingId;
    render();
    return;
  }
  if (action === "save-checkin") {
    await saveCheckinReminder();
    return;
  }
  if (action === "test-checkin") {
    const granted = await ensureNotificationPermission();
    if (!granted) return;
    showWebNotification("DayPilot check-in", "This is how the check-in reminder will look. Tap to open the accountability page.");
    return;
  }
  if (action === "disable-checkin") {
    state.settings.checkinEnabled = false;
    clearTimeout(checkinTimer);
    persist();
    render();
    toast("Check-in reminder turned off.");
    return;
  }
  if (action === "discard-parse") {
    state.pendingParse = null;
    state.activeModal = "chat";
    render();
    toast("Discarded. Your chat text is still there.");
  }
}

function confirmPendingParse() {
  const pending = state.pendingParse;
  if (!pending) return;
  const picked = { activities: [], notes: [] };
  document.querySelectorAll("[data-confirm-activity]").forEach((box) => {
    if (box.checked && pending.activities[Number(box.dataset.confirmActivity)]) {
      picked.activities.push(pending.activities[Number(box.dataset.confirmActivity)]);
    }
  });
  document.querySelectorAll("[data-confirm-note]").forEach((box) => {
    if (box.checked && pending.notes[Number(box.dataset.confirmNote)]) {
      picked.notes.push(pending.notes[Number(box.dataset.confirmNote)]);
    }
  });
  state.pendingParse = null;
  if (!picked.activities.length && !picked.notes.length) {
    state.activeModal = "chat";
    render();
    toast("Nothing selected, nothing added.");
    return;
  }
  state.chatDraft = "";
  applyParsed(picked, "");
}

function applyParsed(parsed, suffix) {
  state.activities = [...state.activities, ...parsed.activities];
  state.projectNotes = [...state.projectNotes, ...parsed.notes];
  ensureBranchesForActivities(parsed.activities);
  ensureBranchesForNotes(parsed.notes);
  state.activeModal = null;
  const summary = `${parsed.activities.length} task${parsed.activities.length === 1 ? "" : "s"} and ${parsed.notes.length} note${parsed.notes.length === 1 ? "" : "s"} added from chat.`;
  announce(suffix ? `${summary} ${suffix}` : summary);
  if (parsed.activities.length && calendarReady() && hasValidToken()) syncCalendarNow(false);
}

function submitQuestionnaire(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const profile = sanitizeProfile({
    workStart: form.get("workStart"),
    workEnd: form.get("workEnd"),
    peakStart: form.get("peakStart"),
    peakEnd: form.get("peakEnd"),
    maxFocusMin: form.get("maxFocusMin"),
    breakMin: form.get("breakMin"),
    drainingTasks: String(form.get("drainingTasks") || "").trim(),
    energizingTasks: String(form.get("energizingTasks") || "").trim()
  });
  if (!profile.workStart || !profile.workEnd || !profile.peakStart || !profile.peakEnd || !profile.drainingTasks || !profile.energizingTasks) {
    toast("Please answer every question - the planner needs all of them.");
    return;
  }
  if (timeToMinutes(profile.workEnd) <= timeToMinutes(profile.workStart)) {
    toast("Work end must be after work start.");
    return;
  }
  if (timeToMinutes(profile.peakEnd) <= timeToMinutes(profile.peakStart)) {
    toast("Peak window end must be after its start.");
    return;
  }
  state.profile = profile;
  state.activeModal = state.questionnaireReturn === "chat" ? "chat" : null;
  state.questionnaireReturn = null;
  announce("Planning profile saved. Gemini and the offline parser will use it.");
}

async function submitChat() {
  const input = document.querySelector("[data-chat-input]");
  if (!input) return;
  const text = input.value.trim();
  if (!text) {
    toast("Type something to add first.");
    return;
  }
  const mode = state.settings.parserMode;
  const token = localStorage.getItem(geminiKey);
  if (mode === "gemini" && !token) {
    toast("Add a Gemini token first.");
    return;
  }
  if (mode === "gemini" && needsQuestionnaire()) {
    state.chatDraft = text;
    state.questionnaireReturn = "chat";
    state.activeModal = "questionnaire";
    render();
    toast("Answer these once so Gemini can plan around your energy.");
    return;
  }
  const button = document.querySelector("[data-action='submit-chat']");
  if (button) {
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = "Parsing...";
  }
  const resetButton = () => {
    if (button) {
      button.disabled = false;
      button.textContent = state.chatClarify ? "Answer & plan" : "Add from chat";
    }
  };
  const reschedule = applyRescheduleRequest(text);
  if (reschedule.handled) {
    resetButton();
    state.chatDraft = "";
    state.activeModal = null;
    announce(reschedule.message);
    if (calendarReady() && hasValidToken() && reschedule.changed) syncCalendarNow(false);
    return;
  }
  if (mode !== "gemini") {
    const parsed = parseNoLlm(text);
    if (!parsed.activities.length && !parsed.notes.length) {
      resetButton();
      toast("Could not find any task or note in that text.");
      return;
    }
    state.chatDraft = "";
    applyParsed(parsed, parsed.warning || "");
    return;
  }
  const clarify = state.chatClarify;
  const requestText = clarify
    ? `${clarify.originalText}\n\nYou asked: ${clarify.question}\nMy answer: ${text}`
    : text;
  let parsed;
  let fellBack = false;
  try {
    parsed = await parseWithGemini(requestText, token, { allowQuestion: !clarify });
  } catch (error) {
    console.warn("Gemini parse failed", error);
    parsed = parseNoLlm(clarify ? clarify.originalText : text);
    fellBack = true;
  }
  if (!fellBack && parsed.question && !clarify) {
    state.chatClarify = { question: parsed.question, originalText: text };
    state.chatDraft = "";
    render();
    toast("Gemini needs one detail before planning.");
    return;
  }
  state.chatClarify = null;
  if (!parsed.activities.length && !parsed.notes.length) {
    resetButton();
    toast(fellBack ? "Gemini failed and the offline parser found nothing either." : "Gemini could not find any task or note in that text.");
    return;
  }
  if (fellBack) {
    state.chatDraft = "";
    applyParsed(parsed, "(Gemini failed, used the offline parser.)");
    return;
  }
  state.pendingParse = { activities: parsed.activities, notes: parsed.notes };
  state.activeModal = "confirm-parse";
  render();
}

function submitTaskForm(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const editing = getEditingActivity();
  const activity = sanitizeActivity({
    id: state.editingId || makeId(),
    title: String(form.get("title") || ""),
    project: form.get("project"),
    branch: form.get("branch"),
    date: form.get("date") || todayKey(),
    start: form.get("start") || "09:00",
    durationMin: form.get("durationMin") || 30,
    kind: form.get("kind"),
    recurrence: parseRecurrence(form.get("recurrence")),
    locked: form.get("locked") === "yes",
    notify: form.get("notify") !== "no",
    notifyMin: form.get("notifyMin"),
    note: String(form.get("note") || "").trim(),
    status: (editing && editing.status) || "planned"
  });
  if (!activity) {
    toast("Give the task a title first.");
    return;
  }
  const wasEditing = Boolean(state.editingId);
  if (wasEditing && editing) {
    activity.gcalEventId = editing.gcalEventId;
    activity.gcalSyncedAt = editing.gcalSyncedAt;
    activity.gcalInstanceOf = editing.gcalInstanceOf;
    if (editing.recurrence && activityChanged(editing, activity)) {
      state.pendingRecurringEdit = { updated: activity, originalId: editing.id };
      state.activeModal = "recurring-scope";
      render();
      return;
    }
  }
  ensureBranch(activity.project, activity.branch);
  if (wasEditing) {
    state.activities = state.activities.map((item) => item.id === state.editingId ? activity : item);
  } else {
    state.activities.push(activity);
  }
  state.activeModal = null;
  state.editingId = null;
  announce(wasEditing ? "Activity updated." : "Activity added.");
  if (calendarReady() && hasValidToken()) syncCalendarNow(false);
}

function activityChanged(before, after) {
  const fields = ["title", "project", "branch", "date", "start", "durationMin", "kind", "note", "locked", "notify", "notifyMin"];
  if (fields.some((field) => before[field] !== after[field])) return true;
  return JSON.stringify(before.recurrence || null) !== JSON.stringify(after.recurrence || null);
}

function advanceRecurrenceDate(key, recurrence) {
  const date = new Date(`${key}T00:00:00`);
  if (recurrence.frequency === "weekly") date.setDate(date.getDate() + 7);
  else if (recurrence.frequency === "monthly") date.setMonth(date.getMonth() + 1);
  else date.setDate(date.getDate() + 1);
  return dateToKey(date);
}

function applyRecurringEdit(scope) {
  const pending = state.pendingRecurringEdit;
  if (!pending) return;
  const original = state.activities.find((item) => item.id === pending.originalId);
  state.pendingRecurringEdit = null;
  if (!original) {
    state.activeModal = null;
    state.editingId = null;
    render();
    return;
  }
  const updated = pending.updated;
  ensureBranch(updated.project, updated.branch);
  if (scope === "all") {
    state.activities = state.activities.map((item) => item.id === original.id ? updated : item);
  } else {
    const exception = { ...updated, id: makeId(), recurrence: null, gcalEventId: undefined, gcalSyncedAt: undefined };
    if (original.gcalEventId) exception.gcalInstanceOf = original.gcalEventId;
    state.activities.push(exception);
    // The series card moves on to its next occurrence so the exception isn't shown twice.
    state.activities = state.activities.map((item) => item.id === original.id
      ? { ...item, date: advanceRecurrenceDate(original.date, original.recurrence), updatedAt: item.updatedAt }
      : item);
  }
  state.activeModal = null;
  state.editingId = null;
  announce(scope === "all"
    ? "Changes applied to this and all occurrences."
    : "Changes applied to this occurrence only. The series is untouched.");
  if (calendarReady() && hasValidToken()) syncCalendarNow(false);
}

function applyRescheduleRequest(text) {
  const lines = String(text || "").split(/\n|;/).map((line) => line.trim()).filter(Boolean);
  const requests = lines.map(parseRescheduleLine).filter(Boolean);
  if (!requests.length) return { handled: false, changed: false, message: "" };
  const messages = [];
  let changed = 0;
  requests.forEach((request) => {
    const match = findActivityForRequest(request.target);
    if (!match) {
      messages.push(`Could not find "${request.target || "that task"}" to reschedule.`);
      return;
    }
    if (isLockedActivity(match)) {
      messages.push(`Skipped "${match.title}" because it is fixed/immovable.`);
      return;
    }
    const before = { ...match };
    const moved = applyRescheduleToActivity(match, request);
    if (!moved) {
      messages.push(`Could not find a new date or time for "${match.title}".`);
      return;
    }
    state.activities = state.activities.map((activity) => activity.id === moved.id ? moved : activity);
    settleFlexibleDay(moved.date, new Set([moved.id]));
    if (before.date !== moved.date) settleFlexibleDay(before.date, new Set());
    changed += 1;
    messages.push(`Rescheduled "${moved.title}" to ${formatDate(moved.date)} ${formatTime(moved.start)}.`);
  });
  return {
    handled: true,
    changed: changed > 0,
    message: messages.join(" ")
  };
}

function parseRescheduleLine(line) {
  const lower = line.toLowerCase();
  if (!/\b(reschedule|move|shift|push|postpone|bump|bring)\b/.test(lower)) return null;
  const target = extractRescheduleTarget(line);
  const date = parseDateFromText(lower);
  const time = parseTimeFromText(lower);
  const direction = /\b(up|earlier|bring)\b/.test(lower) ? -1 : /\b(down|later|push|postpone|bump)\b/.test(lower) ? 1 : 0;
  const shiftMin = direction ? parseDurationFromText(lower) : null;
  if (!target || (!date && !time && !shiftMin)) return null;
  return { target, date, time, shiftMin: shiftMin ? direction * shiftMin : 0 };
}

function extractRescheduleTarget(line) {
  const cleaned = line.replace(/\s+/g, " ").trim();
  const patterns = [
    /\b(?:reschedule|move|shift)\s+(.+?)\s+\b(?:to|for|on|at)\b/i,
    /\b(?:push|postpone|bump)\s+(.+?)\s+\b(?:by|down|later|to|for|on|at)\b/i,
    /\b(?:bring|move|shift)\s+(.+?)\s+\b(?:up|earlier)\b/i
  ];
  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match) return cleanTaskTitle(match[1]);
  }
  return "";
}

function findActivityForRequest(targetText) {
  const target = normalizeMatchText(targetText);
  if (!target) return null;
  const candidates = state.activities.map((activity) => ({
    activity,
    score: matchScore(target, normalizeMatchText(activity.title))
  })).filter((item) => item.score > 0);
  candidates.sort((a, b) => b.score - a.score || `${a.activity.date} ${a.activity.start}`.localeCompare(`${b.activity.date} ${b.activity.start}`));
  return candidates.length ? candidates[0].activity : null;
}

function matchScore(target, title) {
  if (!target || !title) return 0;
  if (title === target) return 100;
  if (title.includes(target) || target.includes(title)) return 70 + Math.min(target.length, title.length);
  const words = target.split(" ").filter((word) => word.length > 2);
  const hits = words.filter((word) => title.includes(word)).length;
  return hits ? hits * 10 : 0;
}

function normalizeMatchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(the|a|an|task|event|meeting)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function applyRescheduleToActivity(activity, request) {
  const next = { ...activity };
  if (request.date) next.date = request.date;
  if (request.time) next.start = request.time;
  if (request.shiftMin) next.start = minutesToTime(timeToMinutes(next.start) + request.shiftMin);
  const protectedMoved = avoidLockedConflicts(next);
  protectedMoved.updatedAt = new Date().toISOString();
  return sanitizeActivity(protectedMoved);
}

function avoidLockedConflicts(activity) {
  const next = { ...activity };
  let guard = 0;
  while (guard < 50) {
    guard += 1;
    const conflict = state.activities.find((candidate) => candidate.id !== next.id && candidate.date === next.date && isLockedActivity(candidate) && activitiesOverlap(next, candidate));
    if (!conflict) return next;
    next.start = minutesToTime(timeToMinutes(conflict.start) + clampNumber(conflict.durationMin, 5, 600, 30));
  }
  return next;
}

function settleFlexibleDay(date, protectedIds) {
  const occupied = state.activities
    .filter((activity) => activity.date === date && (isLockedActivity(activity) || protectedIds.has(activity.id)))
    .map((activity) => ({ ...activity }));
  const flexible = state.activities
    .filter((activity) => activity.date === date && !isLockedActivity(activity) && !protectedIds.has(activity.id))
    .sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));
  flexible.forEach((activity) => {
    let next = { ...activity };
    let guard = 0;
    while (guard < 100) {
      guard += 1;
      const conflict = occupied.find((item) => activitiesOverlap(next, item));
      if (!conflict) break;
      next.start = minutesToTime(timeToMinutes(conflict.start) + clampNumber(conflict.durationMin, 5, 600, 30));
      next.updatedAt = new Date().toISOString();
    }
    occupied.push(next);
    state.activities = state.activities.map((item) => item.id === next.id ? sanitizeActivity(next) : item);
  });
}

function activitiesOverlap(a, b) {
  const aStart = timeToMinutes(a.start);
  const aEnd = aStart + clampNumber(a.durationMin, 5, 600, 30);
  const bStart = timeToMinutes(b.start);
  const bEnd = bStart + clampNumber(b.durationMin, 5, 600, 30);
  return aStart < bEnd && aEnd > bStart;
}

function isLockedActivity(activity) {
  return Boolean(activity && (activity.locked || inferLockedActivity(activity)));
}

function parseNoLlm(text) {
  const lines = text.split(/\n|;/).map((line) => line.replace(/^[-*\d.)\s]+(?=[a-zA-Z#])/, "").trim()).filter(Boolean);
  const parsed = { activities: [], notes: [] };
  lines.forEach((line) => {
    const lower = line.toLowerCase();
    const project = projectFromText(lower);
    const branch = branchFromText(lower);
    if (isNoteLine(lower)) {
      const note = sanitizeNote({
        id: makeId(),
        project,
        branch,
        section: inferNoteSection(lower),
        text: cleanNoteText(line),
        priority: inferNotePriority(lower),
        createdAt: new Date().toISOString()
      });
      if (!note) return;
      parsed.notes.push(note);
      ensureBranch(project, branch);
      return;
    }
    const date = parseDateFromText(lower);
    const slotRequest = parseSlotRequest(lower);
    if (slotRequest) {
      const slots = generateFocusSlots(slotRequest.count, date || todayKey(), parseDurationFromText(lower), project);
      parsed.activities.push(...slots);
      if (slots.length) ensureBranch(project, "Main");
      if (slots.length < slotRequest.count) {
        parsed.warning = `(Only ${slots.length} of ${slotRequest.count} slots fit in your day window.)`;
      }
      return;
    }
    const recurrence = parseRecurrence(lower);
    const durationMin = parseDurationFromText(lower) || 30;
    const dateValue = alignDateToRecurrence(date || (recurrence ? nextDateForRecurrence(recurrence) : todayKey()), recurrence);
    const activity = sanitizeActivity({
      id: makeId(),
      title: cleanTaskTitle(line),
      project,
      branch,
      date: dateValue,
      start: parseTimeFromText(lower) || nextOpenTime(),
      durationMin,
      kind: inferKind(lower),
      recurrence,
      note: "",
      locked: inferLockedActivity({ title: line, kind: inferKind(lower), recurrence }),
      status: "planned"
    });
    if (!activity) return;
    parsed.activities.push(activity);
    ensureBranch(project, branch);
  });
  return parsed;
}

const wordNumbers = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

function wordToCount(value) {
  const number = Number(value);
  if (Number.isFinite(number)) return clampNumber(number, 1, 12, 1);
  return clampNumber(wordNumbers[String(value).toLowerCase()] || 1, 1, 12, 1);
}

function parseSlotRequest(lower) {
  const match = lower.match(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b(?:\s+\S+){0,3}?\s+(slots?|blocks?|sessions?)\b/);
  if (match) return { count: wordToCount(match[1]) };
  if (/\b(productive|focus|deep work|deep-work)\s+(slots?|blocks?|sessions?)\b/.test(lower)) return { count: 1 };
  return null;
}

function parseDateFromText(lower) {
  if (/\bday after tomorrow\b/.test(lower)) return addDays(todayKey(), 2);
  if (/\btomorrow\b/.test(lower)) return addDays(todayKey(), 1);
  if (/\btoday\b|\btonight\b/.test(lower)) return todayKey();
  const nextWeekday = lower.match(/\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (nextWeekday) return dateForWeekday(nextWeekday[1], true);
  const plainWeekday = lower.match(/\b(?:on\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (plainWeekday && !/\b(every|each)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/.test(lower)) {
    return dateForWeekday(plainWeekday[1], false);
  }
  if (/\bnext week\b/.test(lower)) return addDays(todayKey(), 7);
  const iso = lower.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return sanitizeDateKey(iso[1], null);
  return null;
}

function dateForWeekday(name, forceNextWeek) {
  const target = weekdayIndex(weekdayCode(name));
  const now = new Date(`${todayKey()}T00:00:00`);
  let offset = (target - now.getDay() + 7) % 7;
  if (forceNextWeek) offset += offset === 0 ? 7 : (offset < 7 ? 7 : 0);
  return addDays(todayKey(), offset);
}

function parseDurationFromText(lower) {
  const explicit = lower.match(/(\d+(?:\.\d+)?)\s?(m\b|min|minutes|h\b|hr|hours)/);
  if (explicit) return clampNumber(Number(explicit[1]) * (explicit[2].startsWith("h") ? 60 : 1), 5, 600, 30);
  if (/\bhalf\s+(an\s+)?hour\b/.test(lower)) return 30;
  if (/\bquarter\s+(of\s+an\s+)?hour\b/.test(lower)) return 15;
  if (/\b(an\s+)?hour\s+and\s+a\s+half\b/.test(lower)) return 90;
  if (/\ban\s+hour\b|\bone\s+hour\b/.test(lower)) return 60;
  const wordHours = lower.match(/\b(one|two|three|four|five|six)\s+hours?\b/);
  if (wordHours) return clampNumber(wordNumbers[wordHours[1]] * 60, 5, 600, 60);
  return null;
}

function generateFocusSlots(count, date, requestedDuration, project) {
  const profile = state.profile || {};
  const focusMin = clampNumber(requestedDuration || Math.min(profile.maxFocusMin || 90, 90), 15, 240, 90);
  const gap = clampNumber(profile.breakMin, 5, 60, 15);
  const peakStart = sanitizeTime(profile.peakStart, "") || sanitizeTime(profile.workStart, "") || "09:00";
  const dayEnd = sanitizeTime(profile.workEnd, "") || "18:00";
  const busy = state.activities
    .filter((activity) => activity.date === date)
    .map((activity) => [timeToMinutes(activity.start), timeToMinutes(activity.start) + clampNumber(activity.durationMin, 5, 600, 30)]);
  const slots = [];
  let cursor = timeToMinutes(peakStart);
  const hardStop = Math.min(Math.max(timeToMinutes(dayEnd), cursor + focusMin), 23 * 60 + 59);
  let guard = 0;
  while (slots.length < count && cursor + focusMin <= hardStop && guard < 100) {
    guard += 1;
    const conflict = busy.find(([start, end]) => cursor < end && cursor + focusMin > start);
    if (conflict) {
      cursor = conflict[1] + gap;
      continue;
    }
    slots.push(minutesToTime(cursor));
    cursor += focusMin + gap;
  }
  return slots.map((start, index) => sanitizeActivity({
    id: makeId(),
    title: count === 1 ? "Deep focus slot" : `Deep focus slot ${index + 1}`,
    project: project || state.selectedProject || "Inbox",
    branch: "Main",
    date,
    start,
    durationMin: focusMin,
    kind: "focus",
    note: "Protected productive slot. Keep draining work out of it.",
    status: "planned"
  })).filter(Boolean);
}

function minutesToTime(total) {
  const wrapped = ((Math.round(total) % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

function profilePromptBlock() {
  const profile = state.profile;
  if (!profileComplete()) return "";
  const busy = sortedActivities()
    .filter((activity) => activity.date >= todayKey())
    .slice(0, 30)
    .map((activity) => `${activity.date} ${activity.start} ${activity.durationMin}m ${activity.title}`)
    .join("; ") || "nothing scheduled yet";
  return `
About this user (use it - this is why they trust you):
- Work hours: ${profile.workStart}-${profile.workEnd}.
- Peak focus window (most productive, least drained): ${profile.peakStart}-${profile.peakEnd}.
- Max deep-focus block: ${profile.maxFocusMin} minutes. Needs ${profile.breakMin} minute breaks between focus blocks.
- Tasks that DRAIN them: ${profile.drainingTasks}.
- Tasks they can do tired / that energize them: ${profile.energizingTasks}.
- Already scheduled (avoid overlaps): ${busy}.

Scheduling rules:
- "Productive slots" / focus blocks go inside the peak window when possible, otherwise within work hours. Never overlap existing items, keep ${profile.breakMin} min gaps, cap each block at ${profile.maxFocusMin} minutes.
- If the user asks for N slots or blocks, return exactly N activities with kind "focus" and generic titles like "Deep focus slot 1" unless they named the work.
- Never stack draining tasks back to back; alternate with lighter or energizing work, and keep draining tasks out of the late-day low-energy zone.
`;
}

async function parseWithGemini(text, token, options = {}) {
  const allowQuestion = options.allowQuestion !== false;
  const prompt = `You are a scheduling parser and planner. Return only JSON with shape {"activities":[],"notes":[],"question":""}. Do not wrap in markdown.

For each activity:
- title: a short clean task title only. Do NOT copy the whole user prompt. Remove words like "add", "schedule", "every Wednesday", dates, times, duration, and filler. Example input "every Wednesday 9am do lab journal 30m" -> title "Lab journal".
- sourceText: the exact input line that created this activity.
- project, branch
- date: YYYY-MM-DD for the next occurrence, or empty if unknown.
- start: HH:MM 24-hour time, or empty.
- durationMin: number.
- kind: focus/admin/routine/personal.
- recurrence: null OR {"frequency":"daily|weekly|monthly","byDay":"MO|TU|WE|TH|FR|SA|SU"}. For "every Wednesday", use {"frequency":"weekly","byDay":"WE"}.
- locked: true for meetings/classes/appointments/exams/seminars/calls or anything the user says is fixed/immovable. false for flexible work.

Hard date rules:
- Today is ${todayKey()} (${weekdayName(weekdayCodeForDate(todayKey()))}).
- If recurrence.byDay is set, date MUST be the next occurrence of that exact weekday. A Wednesday recurrence can NEVER have a Thursday date.
- "On Wednesdays I have meeting X" means a weekly Wednesday fixed meeting: recurrence {"frequency":"weekly","byDay":"WE"}, locked true, and date equal to the next Wednesday.
- "on Wednesday" singular means one event on the upcoming Wednesday unless the user also says every/each/weekly/Wednesdays.
- If an item is fixed/locked, never move it to solve a conflict.

For notes:
- project, branch, section one of pinned_context/open_decisions/future_ideas/blocked_by/meeting_notes/task_seeds/someday_not_now, text, priority 1-5.
${profilePromptBlock()}
${allowQuestion
    ? `If the request is genuinely too ambiguous to schedule, set "question" to ONE short clarifying question and return empty activities and notes. Only do this when you truly cannot proceed - prefer reasonable assumptions.`
    : `Do NOT ask any question. Make reasonable assumptions and return your best JSON plan.`}

Today is ${todayKey()}.

Text:
${text}`;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" }
    })
  });
  if (!response.ok) throw new Error(`Gemini request failed (HTTP ${response.status})`);
  const data = await response.json();
  const raw = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
  if (!raw) throw new Error("Gemini returned no text");
  const parsed = JSON.parse(extractJsonBlock(raw));
  const activities = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.activities) ? parsed.activities : []);
  const notes = Array.isArray(parsed) ? [] : (Array.isArray(parsed.notes) ? parsed.notes : []);
  const question = !Array.isArray(parsed) && typeof parsed.question === "string" ? parsed.question.trim().slice(0, 300) : "";
  return {
    activities: activities.map((item) => normalizeParsedActivity(item, text)).filter(Boolean),
    notes: notes.map((note) => sanitizeNote({
      id: makeId(),
      project: normalizeProject(note && note.project),
      branch: normalizeBranch(note && note.branch),
      section: note && note.section,
      text: note && note.text,
      priority: note && note.priority,
      createdAt: new Date().toISOString()
    })).filter(Boolean),
    question
  };
}

function extractJsonBlock(raw) {
  const cleaned = String(raw).replace(/```json|```/gi, "").trim();
  if (cleaned.startsWith("{") || cleaned.startsWith("[")) return cleaned;
  const start = cleaned.search(/[{[]/);
  if (start === -1) return cleaned;
  const end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
  return end > start ? cleaned.slice(start, end + 1) : cleaned.slice(start);
}

function normalizeParsedActivity(item, originalText) {
  if (!item || typeof item !== "object") return null;
  const recurrence = normalizeRecurrence(item.recurrence) || parseRecurrence(`${item.sourceText || ""} ${item.title || ""} ${originalText || ""}`);
  const sourceText = item.sourceText || originalText || item.title || "";
  const date = alignDateToRecurrence(
    sanitizeDateKey(item.date, recurrence ? nextDateForRecurrence(recurrence) : todayKey()),
    recurrence
  );
  return sanitizeActivity({
    id: makeId(),
    title: cleanTaskTitle(item.title || sourceText),
    project: normalizeProject(item.project || projectFromText(sourceText.toLowerCase())),
    branch: normalizeBranch(item.branch || branchFromText(sourceText.toLowerCase())),
    date,
    start: sanitizeTime(item.start, nextOpenTime()),
    durationMin: item.durationMin,
    kind: item.kind || (recurrence ? "routine" : "focus"),
    recurrence,
    note: "",
    locked: typeof item.locked === "boolean" ? item.locked : inferLockedActivity({ ...item, title: item.title || sourceText, sourceText }),
    status: "planned"
  });
}

function saveFirebaseConfig() {
  const value = document.querySelector("[data-config='firebase']").value.trim();
  if (!value) {
    localStorage.removeItem(firebaseKey);
    firebaseRuntime = { ready: false, user: null };
    toast("Firebase config cleared.");
    render();
    return;
  }
  const parsed = parseFirebaseConfigText(value);
  if (!parsed) {
    toast("Could not read that config. Paste the {...} object Firebase shows for your web app.");
    return;
  }
  const missing = ["apiKey", "projectId", "appId"].filter((field) => !parsed[field]);
  if (missing.length) {
    toast(`Config is missing ${missing.join(", ")}. Copy the full firebaseConfig object.`);
    return;
  }
  localStorage.setItem(firebaseKey, JSON.stringify(parsed));
  authNotice = "";
  toast(`Firebase config saved. Before Google sign-in, add ${location.hostname} under Authentication -> Settings -> Authorized domains.`);
  boot();
}

function parseFirebaseConfigText(text) {
  let candidate = text
    .replace(/^\s*(?:const|var|let)\s+firebaseConfig\s*=\s*/i, "")
    .replace(/;\s*$/, "")
    .trim();
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidate = candidate.slice(firstBrace, lastBrace + 1);
  }
  try {
    return asPlainObject(JSON.parse(candidate));
  } catch {
    // Firebase console shows a JS object literal, not JSON: quote bare keys and swap quote style.
    const jsonish = candidate
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
      .replace(/'/g, '"')
      .replace(/,\s*}/g, "}");
    try {
      return asPlainObject(JSON.parse(jsonish));
    } catch {
      return null;
    }
  }
}

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function friendlyAuthError(error) {
  const code = (error && error.code) || "";
  const message = (error && error.message) || "Sign-in failed.";
  if (code.includes("unauthorized-domain") || /unauthorized.domain/i.test(message)) {
    return `This site is not authorized in this Firebase project yet. Add exactly ${location.hostname} in Authentication -> Settings -> Authorized domains, then try Google sign-in again.`;
  }
  if (code.includes("operation-not-allowed")) {
    return "Google sign-in is not enabled in your Firebase project. Open Authentication -> Sign-in method and enable Google.";
  }
  if (code.includes("configuration-not-found")) {
    return "Authentication is not set up in your Firebase project yet. Open Authentication in Firebase Console and click Get started, then enable Google.";
  }
  if (code.includes("popup-blocked")) {
    return "The browser blocked the sign-in popup. Allow popups for this site and try again.";
  }
  if (code.includes("popup-closed-by-user") || code.includes("cancelled-popup-request")) {
    return "Sign-in popup was closed before finishing. Try again.";
  }
  if (code.includes("invalid-api-key") || /invalid.api.key/i.test(message)) {
    return "The saved Firebase config has an invalid API key. Re-copy the config object from your Firebase project settings.";
  }
  if (code.includes("network-request-failed")) {
    return "Network problem while contacting Firebase. Check your connection and retry.";
  }
  return message;
}

function firebaseConsoleUrl(projectId, path = "") {
  const safeProject = projectId && /^[a-z0-9-]+$/i.test(projectId) ? projectId : "";
  const suffix = path ? `/${path}` : "";
  return safeProject
    ? `https://console.firebase.google.com/project/${encodeURIComponent(safeProject)}${suffix}`
    : "https://console.firebase.google.com/";
}

async function copyToClipboard(value, successMessage) {
  try {
    if (!navigator.clipboard) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(value);
    toast(successMessage);
  } catch {
    toast(`Copy this value: ${value}`);
  }
}

function readFirebaseConfig() {
  try {
    const text = localStorage.getItem(firebaseKey);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function submitProjectNote(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const text = form.get("text").trim();
  if (!text) return;
  const section = form.get("section") || inferNoteSection(text.toLowerCase());
  state.projectNotes.unshift({
    id: makeId(),
    project: state.selectedProject || "Inbox",
    branch: "Main",
    section: noteSections().includes(section) ? section : inferNoteSection(text.toLowerCase()),
    text: text.slice(0, 2000),
    priority: inferNotePriority(text.toLowerCase()),
    createdAt: new Date().toISOString()
  });
  announce("Project note saved.");
}

function submitBranch(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const raw = String(form.get("name") || "").trim();
  if (!raw) {
    toast("Give the branch a name first.");
    return;
  }
  const name = normalizeBranch(raw);
  ensureBranch(state.selectedProject || "Inbox", name);
  announce(`${name} branch added.`);
}

function handleBranchAction(action, id) {
  const branch = state.branches.find((item) => item.id === id);
  if (!branch) return;
  if (action === "boost") {
    branch.priority = Math.min(5, Number(branch.priority || 3) + 1);
    branch.status = "active";
    state.lastMessage = `${branch.name} boosted. Flexible work will favor it.`;
  }
  if (action === "pause") {
    branch.status = branch.status === "paused" ? "active" : "paused";
    state.lastMessage = `${branch.name} is now ${branch.status}.`;
  }
  if (action === "plan") {
    state.activities.push({
      id: makeId(),
      title: `Plan ${branch.name}`,
      project: branch.project,
      branch: branch.name,
      date: addDays(todayKey(), 7),
      start: "09:00",
      durationMin: 45,
      kind: "focus",
      note: "Plan next week from branch notes.",
      status: "planned"
    });
    state.lastMessage = `Next week planning block created for ${branch.name}.`;
  }
  if (action === "next") {
    state.activities.push({
      id: makeId(),
      title: `Next action for ${branch.name}`,
      project: branch.project,
      branch: branch.name,
      date: todayKey(),
      start: nextOpenTime(),
      durationMin: 30,
      kind: "focus",
      note: "Created from branch next-action control.",
      status: "planned"
    });
    state.lastMessage = `Next action created for ${branch.name}.`;
  }
  announce(state.lastMessage);
}

function editingNoteText(activity) {
  const field = document.querySelector("[data-form='task'] [name='note']");
  const live = field ? field.value.trim() : "";
  return live || String((activity && activity.note) || "").trim();
}

function createSubtaskFromEditingNote() {
  const activity = getEditingActivity();
  const noteText = editingNoteText(activity);
  if (!activity || !noteText) {
    toast("Write a task note first.");
    return;
  }
  state.activities.push({
    id: makeId(),
    title: firstUsefulLine(noteText, `Follow up: ${activity.title}`),
    project: activity.project || "Inbox",
    branch: activity.branch || "Main",
    date: activity.date || todayKey(),
    start: nextOpenTime(),
    durationMin: 30,
    kind: activity.kind || "focus",
    note: `From note on ${activity.title}`,
    status: "planned"
  });
  state.activeModal = null;
  state.editingId = null;
  announce("Subtask created from note.");
}

function saveEditingNoteToProject() {
  const activity = getEditingActivity();
  const noteText = editingNoteText(activity);
  if (!activity || !noteText) {
    toast("Write a task note first.");
    return;
  }
  state.projectNotes.unshift({
    id: makeId(),
    project: activity.project || "Inbox",
    branch: activity.branch || "Main",
    section: inferNoteSection(noteText.toLowerCase()),
    text: noteText.slice(0, 2000),
    priority: inferNotePriority(noteText.toLowerCase()),
    linkedActivityId: activity.id,
    createdAt: new Date().toISOString()
  });
  state.selectedProject = activity.project || "Inbox";
  state.activeModal = null;
  state.editingId = null;
  announce("Task note saved to project board.");
}

function applyEditingNoteSignals() {
  const activity = getEditingActivity();
  const noteText = editingNoteText(activity);
  if (!activity || !noteText) {
    toast("Write a task note first.");
    return;
  }
  const note = noteText.toLowerCase();
  const changes = { note: noteText };
  if (/fresh brain|quiet brain|deep|morning/.test(note)) {
    changes.start = "09:00";
    changes.kind = "focus";
  }
  if (/low energy|tired|can do tired|light/.test(note)) {
    changes.start = "14:00";
    changes.kind = "admin";
  }
  if (/blocked|waiting|until .* replies|reply/.test(note)) {
    changes.status = "blocked";
  }
  if (/deadline.*tomorrow|tomorrow.*deadline|due tomorrow/.test(note)) {
    changes.date = addDays(todayKey(), 1);
    changes.start = "09:00";
  }
  updateActivity(activity.id, changes);
  state.activeModal = null;
  state.editingId = null;
  announce(Object.keys(changes).length > 1 ? "Note signals applied to the schedule." : "Note saved, but no strong scheduling signal found in it.");
}

function createTaskFromLatestProjectNote() {
  const notes = state.projectNotes.filter((note) => note.project === state.selectedProject);
  if (!notes.length) {
    toast("No project note to turn into a task.");
    return;
  }
  const note = notes[0];
  state.activities.push({
    id: makeId(),
    title: firstUsefulLine(note.text, `Follow up ${note.project}`),
    project: note.project,
    branch: note.branch || "Main",
    date: todayKey(),
    start: nextOpenTime(),
    durationMin: 30,
    kind: note.section === "blocked_by" ? "admin" : "focus",
    note: note.text,
    status: "planned"
  });
  announce("Task created from latest project note.");
}

function emptyActivity() {
  return {
    title: "",
    project: state.selectedProject || "Inbox",
    branch: "Main",
    date: todayKey(),
    start: nextOpenTime(),
    durationMin: 30,
    kind: "focus",
    recurrence: null,
    note: "",
    status: "planned"
  };
}

function getEditingActivity() {
  return state.activities.find((activity) => activity.id === state.editingId);
}

function updateActivity(id, changes) {
  state.activities = state.activities.map((activity) => activity.id === id ? { ...activity, ...changes, updatedAt: new Date().toISOString() } : activity);
}

function calendarReady() {
  return Boolean(getCalendarClientId() && state.calendar.calendarId);
}

async function syncCalendarNow(interactive) {
  if (!getCalendarClientId()) {
    toast("Set up Google Calendar in Settings first.");
    return;
  }
  if (syncCalendarNow.busy) return;
  syncCalendarNow.busy = true;
  if (interactive) toast("Syncing with Google Calendar...");
  try {
    const token = await requestCalendarToken(interactive);
    let calendarId = state.calendar.calendarId;
    if (!calendarId) {
      calendarId = await ensurePlannyCalendar(token);
      state.calendar.calendarId = calendarId;
      persist();
    }
    for (const eventId of state.calendarTombstones) {
      await deleteEvent(token, calendarId, eventId);
    }
    state.calendarTombstones = [];
    const events = await listEvents(token, calendarId, state.calendar.lastSync || "");
    let pulled = 0;
    let removed = 0;
    events.forEach((event) => {
      const priv = (event.extendedProperties && event.extendedProperties.private) || {};
      const existing = state.activities.find((activity) => activity.gcalEventId === event.id || (priv.plannyId && activity.id === priv.plannyId));
      if (event.status === "cancelled") {
        if (existing) {
          state.activities = state.activities.filter((activity) => activity !== existing);
          removed += 1;
        }
        return;
      }
      const fields = eventToActivityFields(event);
      fields.locked = priv.plannyLocked === "true"
        ? true
        : priv.plannyLocked === "false"
          ? false
          : !priv.plannyId || inferLockedActivity(fields);
      if (!fields.date) return;
      const eventUpdated = event.updated || new Date().toISOString();
      if (existing) {
        if (eventUpdated > (existing.gcalSyncedAt || "")) {
          const merged = sanitizeActivity({ ...existing, ...fields, id: existing.id });
          if (merged) {
            merged.gcalEventId = event.id;
            merged.gcalSyncedAt = eventUpdated;
            merged.updatedAt = eventUpdated;
            state.activities = state.activities.map((activity) => activity.id === existing.id ? merged : activity);
            pulled += 1;
          }
        }
        return;
      }
      const activity = sanitizeActivity({
        id: priv.plannyId || makeId(),
        title: fields.title,
        note: fields.note,
        date: fields.date,
        start: fields.start,
        durationMin: fields.durationMin,
        recurrence: fields.recurrence,
        locked: fields.locked || !priv.plannyId,
        project: priv.plannyProject || "Calendar",
        branch: priv.plannyBranch || "Main",
        kind: priv.plannyKind,
        status: "planned"
      });
      if (activity) {
        activity.gcalEventId = event.id;
        activity.gcalSyncedAt = eventUpdated;
        activity.updatedAt = eventUpdated;
        state.activities.push(activity);
        ensureBranch(activity.project, activity.branch);
        pulled += 1;
      }
    });
    let pushed = 0;
    for (const activity of state.activities) {
      if (!activity.gcalEventId) {
        if (activity.gcalInstanceOf) {
          // Exception to a recurring series: patch that single instance, don't create a duplicate.
          const instance = await findInstance(token, calendarId, activity.gcalInstanceOf, activity.date);
          if (instance) {
            const event = await patchEvent(token, calendarId, instance.id, activity);
            activity.gcalEventId = instance.id;
            activity.gcalSyncedAt = (event && event.updated) || new Date().toISOString();
            pushed += 1;
            continue;
          }
          delete activity.gcalInstanceOf;
        }
        const event = await insertEvent(token, calendarId, activity);
        activity.gcalEventId = event.id;
        activity.gcalSyncedAt = event.updated || new Date().toISOString();
        pushed += 1;
      } else if ((activity.updatedAt || "") > (activity.gcalSyncedAt || "")) {
        const event = await patchEvent(token, calendarId, activity.gcalEventId, activity);
        activity.gcalSyncedAt = (event && event.updated) || new Date().toISOString();
        pushed += 1;
      }
    }
    state.calendar.lastSync = new Date().toISOString();
    announce(`Calendar synced: ${pushed} pushed, ${pulled} pulled${removed ? `, ${removed} removed` : ""}.`);
  } catch (error) {
    console.warn("Calendar sync failed", error);
    persist();
    render();
    toast(error.message);
  } finally {
    syncCalendarNow.busy = false;
  }
}

function projectNames() {
  const names = new Set(["Inbox"]);
  state.activities.forEach((activity) => names.add(activity.project || "Inbox"));
  state.projectNotes.forEach((note) => names.add(note.project || "Inbox"));
  state.branches.forEach((branch) => names.add(branch.project || "Inbox"));
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

function firstProject(input) {
  const projects = new Set();
  (input.activities || []).forEach((activity) => projects.add(activity.project || "Inbox"));
  (input.projectNotes || []).forEach((note) => projects.add(note.project || "Inbox"));
  return Array.from(projects)[0] || "Inbox";
}

function ensureBranchesForActivities(activities) {
  activities.forEach((activity) => ensureBranch(activity.project || "Inbox", activity.branch || "Main"));
}

function ensureBranchesForNotes(notes) {
  notes.forEach((note) => ensureBranch(note.project || "Inbox", note.branch || "Main"));
}

function ensureBranch(project, name) {
  const branchProject = normalizeProject(project);
  const branchName = normalizeBranch(name);
  const exists = state.branches.some((branch) => branch.project === branchProject && branch.name === branchName);
  if (!exists) {
    state.branches.push({
      id: makeId(),
      project: branchProject,
      name: branchName,
      status: "active",
      priority: 3,
      goal: "",
      createdAt: new Date().toISOString()
    });
  }
}

function sortedActivities() {
  return [...state.activities].sort((a, b) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`));
}

function groupByDate(items) {
  return items.reduce((groups, item) => {
    groups[item.date] = groups[item.date] || [];
    groups[item.date].push(item);
    return groups;
  }, {});
}

function noteSections() {
  return ["pinned_context", "open_decisions", "future_ideas", "blocked_by", "meeting_notes", "task_seeds", "someday_not_now"];
}

function sectionLabel(section) {
  return ({
    pinned_context: "Pinned context",
    open_decisions: "Open decisions",
    future_ideas: "Future ideas",
    blocked_by: "Blocked by",
    meeting_notes: "Meeting notes",
    task_seeds: "Task seeds",
    someday_not_now: "Someday / not now"
  })[section] || section;
}

function renderNoteSignals(text) {
  const signals = detectNoteSignals(text);
  if (!signals.length) return `<p class="muted">Signals detected from note: none yet.</p>`;
  return `<p class="muted">Signals detected from note: ${signals.map(escapeHtml).join(", ")}</p>`;
}

function detectNoteSignals(text) {
  const lower = String(text || "").toLowerCase();
  const signals = [];
  if (/fresh brain|quiet brain|deep|morning/.test(lower)) signals.push("prefer morning focus");
  if (/low energy|tired|can do tired|light/.test(lower)) signals.push("can move to light slot");
  if (/blocked|waiting|reply/.test(lower)) signals.push("blocked/follow-up");
  if (/deadline|due/.test(lower)) signals.push("deadline signal");
  if (/next week|next monday|future|for next/.test(lower)) signals.push("planning pointer");
  return signals;
}

function isNoteLine(lower) {
  return /^(note|remember|idea|blocked|decision|meeting|someday|for next time):/.test(lower) || /#note|#project-note|#future|#blocked|#waiting/.test(lower);
}

function inferNoteSection(lower) {
  if (/blocked|waiting|reply|#blocked|#waiting/.test(lower)) return "blocked_by";
  if (/decision/.test(lower)) return "open_decisions";
  if (/meeting|advisor|call/.test(lower)) return "meeting_notes";
  if (/idea|future|for next|next week/.test(lower)) return "future_ideas";
  if (/someday|not now|later/.test(lower)) return "someday_not_now";
  if (/context|remember|note/.test(lower)) return "pinned_context";
  return "task_seeds";
}

function cleanNoteText(line) {
  return line.replace(/^(note|remember|idea|blocked|decision|meeting|someday|for next time):\s*/i, "").trim();
}

function inferNotePriority(lower) {
  if (/urgent|deadline|high|#priority:high|tomorrow/.test(lower)) return 5;
  if (/low|someday|not now/.test(lower)) return 2;
  return 3;
}

function normalizeProject(value) {
  const text = String(value || "").trim();
  return text || "Inbox";
}

function normalizeBranch(value) {
  const text = String(value || "").trim();
  return text || "Main";
}

function projectFromText(lower) {
  const tag = lower.match(/#project:([a-z0-9_-]+)/i);
  if (tag) return titleCase(tag[1].replace(/[-_]/g, " "));
  if (lower.includes("kgp")) return "KGP";
  if (lower.includes("ruok") || lower.includes("bathroom")) return "RUOK";
  if (lower.includes("iaso") || lower.includes("leantopo")) return "IASO";
  if (lower.includes("gesture")) return "Gesture";
  if (lower.includes("admin") || lower.includes("mail")) return "Admin";
  return state.selectedProject || "Inbox";
}

function branchFromText(lower) {
  const tag = lower.match(/#branch:([a-z0-9_-]+)/i);
  if (tag) return titleCase(tag[1].replace(/[-_]/g, " "));
  if (lower.includes("calibration")) return "Calibration";
  if (lower.includes("submission") || lower.includes("paper")) return "Paper submission";
  if (lower.includes("dataset")) return "Dataset";
  return "Main";
}

function weekKeys() {
  const today = new Date(`${todayKey()}T00:00:00`);
  const day = today.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  return Array.from({ length: 7 }, (_, index) => addDays(todayKey(), mondayOffset + index));
}

function dateToKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function todayKey() {
  return dateToKey(new Date());
}

function addDays(key, amount) {
  const date = new Date(`${key}T00:00:00`);
  date.setDate(date.getDate() + amount);
  return dateToKey(date);
}

function nextOpenTime() {
  const todays = sortedActivities().filter((activity) => activity.date === todayKey());
  if (!todays.length) return state.profile && sanitizeTime(state.profile.workStart, "") || "09:00";
  const last = todays[todays.length - 1];
  return addMinutes(last.start, last.durationMin || 30);
}

function addMinutes(time, minutes) {
  const clean = sanitizeTime(time, "09:00");
  const parts = clean.split(":").map(Number);
  const total = parts[0] * 60 + parts[1] + (Number.isFinite(Number(minutes)) ? Number(minutes) : 30);
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function timeToMinutes(time) {
  const clean = sanitizeTime(time, "09:00");
  const parts = clean.split(":").map(Number);
  return parts[0] * 60 + parts[1];
}

function parseTimeFromText(lower) {
  const withMinutes = lower.match(/\b([01]?\d|2[0-3]):([0-5]\d)\s*(am|pm)?\b/);
  if (withMinutes) return composeTime(withMinutes[1], withMinutes[2], withMinutes[3]);
  const hourOnly = lower.match(/\b([1-9]|1[0-2])\s*(am|pm)\b/);
  if (hourOnly) return composeTime(hourOnly[1], "00", hourOnly[2]);
  const atHour = lower.match(/\bat\s+([01]?\d|2[0-3])\b/);
  if (atHour) return composeTime(atHour[1], "00", null);
  if (/\bnoon\b|\bmidday\b/.test(lower)) return "12:00";
  if (/\bmorning\b/.test(lower)) return sanitizeTime(state.profile && state.profile.peakStart, "") || "09:00";
  if (/\bafternoon\b/.test(lower)) return "14:00";
  if (/\bevening\b/.test(lower)) return "18:00";
  if (/\btonight\b/.test(lower)) return "20:00";
  return null;
}

function composeTime(hourText, minuteText, suffix) {
  let hour = Number(hourText);
  if (suffix === "pm" && hour < 12) hour += 12;
  if (suffix === "am" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${minuteText}`;
}

function inferKind(lower) {
  if (/meeting|standup|seminar|class|lecture|exam|appointment|interview/.test(lower)) return "routine";
  if (/walk|workout|sleep|call/.test(lower)) return "personal";
  if (/mail|send|admin|upload|print/.test(lower)) return "admin";
  if (/daily|every|routine/.test(lower)) return "routine";
  return "focus";
}

function inferLockedActivity(item) {
  const text = `${item && item.title ? item.title : ""} ${item && item.note ? item.note : ""} ${item && item.sourceText ? item.sourceText : ""}`.toLowerCase();
  if (/\b(flexible|movable|can move|reschedulable)\b/.test(text)) return false;
  if (/\b(fixed|immovable|do not move|don't move|cannot move|can't move|hard commitment)\b/.test(text)) return true;
  if (/\b(meeting|standup|sync|class|lecture|seminar|exam|appointment|interview|defen[cs]e|doctor|dentist)\b/.test(text)) return true;
  const kind = item && item.kind ? String(item.kind).toLowerCase() : "";
  return kind === "routine" && /\b(call|meeting|class|lecture|seminar)\b/.test(text);
}

function parseRecurrence(value) {
  const lower = String(value || "").toLowerCase().trim();
  if (!lower) return null;
  if (/\b(daily|every day|each day)\b/.test(lower)) return { frequency: "daily" };
  const weekday = lower.match(/\b(every|each)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/);
  if (weekday) return { frequency: "weekly", byDay: weekdayCode(weekday[2]) };
  const onPluralWeekday = lower.match(/\bon\s+(mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)\b/);
  if (onPluralWeekday) return { frequency: "weekly", byDay: weekdayCode(onPluralWeekday[1]) };
  const pluralWeekday = lower.match(/\b(mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)\b/);
  if (pluralWeekday && /\b(weekly|regular|recurring|have|happens|meets|meeting|class|lecture|seminar)\b/.test(lower)) {
    return { frequency: "weekly", byDay: weekdayCode(pluralWeekday[1]) };
  }
  if (/\bweekly\b/.test(lower)) return { frequency: "weekly" };
  if (/\bmonthly\b/.test(lower)) return { frequency: "monthly" };
  return null;
}

function normalizeRecurrence(value) {
  if (!value) return null;
  if (typeof value === "string") return parseRecurrence(value);
  const frequency = String(value.frequency || "").toLowerCase();
  if (!["daily", "weekly", "monthly"].includes(frequency)) return null;
  const recurrence = { frequency };
  if (value.byDay) recurrence.byDay = String(value.byDay).toUpperCase().slice(0, 2);
  return recurrence;
}

function alignDateToRecurrence(dateKey, recurrence) {
  const clean = sanitizeDateKey(dateKey, todayKey());
  if (!recurrence || recurrence.frequency !== "weekly" || !recurrence.byDay) return clean;
  return dateMatchesRecurrence(clean, recurrence) ? clean : nextDateForRecurrence(recurrence);
}

function dateMatchesRecurrence(dateKey, recurrence) {
  if (!recurrence || recurrence.frequency !== "weekly" || !recurrence.byDay) return true;
  return weekdayCodeForDate(dateKey) === String(recurrence.byDay || "").toUpperCase();
}

function recurrenceLabel(recurrence) {
  if (!recurrence) return "";
  if (recurrence.frequency === "daily") return "Repeats daily";
  if (recurrence.frequency === "monthly") return "Repeats monthly";
  if (recurrence.frequency === "weekly" && recurrence.byDay) return `Repeats ${weekdayName(recurrence.byDay)}`;
  if (recurrence.frequency === "weekly") return "Repeats weekly";
  return "";
}

function recurrenceInputValue(recurrence) {
  if (!recurrence) return "";
  if (recurrence.frequency === "weekly" && recurrence.byDay) return `every ${weekdayName(recurrence.byDay)}`;
  return recurrenceLabel(recurrence).replace(/^Repeats /, "");
}

function nextDateForRecurrence(recurrence) {
  if (!recurrence) return todayKey();
  if (recurrence.frequency === "daily") return todayKey();
  if (recurrence.frequency === "monthly") return todayKey();
  if (recurrence.frequency === "weekly" && recurrence.byDay) {
    const target = weekdayIndex(recurrence.byDay);
    const now = new Date(`${todayKey()}T00:00:00`);
    const current = now.getDay();
    const offset = (target - current + 7) % 7;
    return addDays(todayKey(), offset);
  }
  return todayKey();
}

function weekdayCode(dayName) {
  const key = String(dayName || "").slice(0, 3).toLowerCase();
  return ({ mon: "MO", tue: "TU", wed: "WE", thu: "TH", fri: "FR", sat: "SA", sun: "SU" })[key] || "";
}

function weekdayCodeForDate(dateKey) {
  const date = new Date(`${sanitizeDateKey(dateKey, todayKey())}T00:00:00`);
  return ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][date.getDay()];
}

function weekdayName(code) {
  return ({ MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday", FR: "Friday", SA: "Saturday", SU: "Sunday" })[String(code || "").toUpperCase()] || "week";
}

function weekdayIndex(code) {
  return ({ SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 })[String(code || "").toUpperCase()] || 0;
}

function cleanTitle(line) {
  return line
    .replace(/\b(today|tomorrow|tonight|daily|every day|weekly|monthly|next week)\b/gi, "")
    .replace(/\b(every|each|on|next)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/gi, "")
    .replace(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/gi, "")
    .replace(/\b\d+(?:\.\d+)?\s?(m|min|minutes|h|hr|hours)\b/gi, "")
    .replace(/\b([01]?\d|2[0-3]):[0-5]\d\s*(am|pm)?\b/gi, "")
    .replace(/\b\d{1,2}\s*(am|pm)\b/gi, "")
    .replace(/\bat\s+\d{1,2}\b/gi, "")
    .replace(/#\w+(?::[\w-]+)?/g, "")
    .replace(/\s+/g, " ")
    .trim() || "Untitled";
}

function cleanTaskTitle(value) {
  const cleaned = cleanTitle(String(value || "")
    .replace(/^(add|create|schedule|make|remind me to|i need to|i have|there is|please|can you)\s+/i, "")
    .replace(/\b(to my calendar|in my planner|as a task)\b/gi, ""));
  const trimmed = cleaned.replace(/^(i have|there is)\s+/i, "");
  return titleCase(trimmed.charAt(0).toLowerCase() === trimmed.charAt(0) ? trimmed : trimmed);
}

function firstUsefulLine(text, fallback) {
  const line = String(text || "").split(/\n/).map((item) => item.trim()).find(Boolean);
  if (!line) return fallback;
  return cleanTitle(line).slice(0, 80) || fallback;
}

function formatDay(key) {
  return new Date(`${key}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function formatDate(key) {
  return new Date(`${key}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatTime(time) {
  const clean = sanitizeTime(time, "");
  if (!clean) return "--:--";
  const parts = clean.split(":").map(Number);
  const suffix = parts[0] >= 12 ? "PM" : "AM";
  const hour = parts[0] % 12 || 12;
  return `${hour}:${String(parts[1]).padStart(2, "0")} ${suffix}`;
}

function titleCase(value) {
  return String(value).charAt(0).toUpperCase() + String(value).slice(1);
}

function makeId() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

let checkinTimer = null;

async function ensureNotificationPermission() {
  if (!("Notification" in window)) {
    toast("This browser does not support notifications.");
    return false;
  }
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") {
    toast("Notifications are blocked for this site. Allow them in the browser's site settings.");
    return false;
  }
  const result = await Notification.requestPermission();
  if (result !== "granted") {
    toast("Without permission the check-in reminder cannot notify you.");
    return false;
  }
  return true;
}

async function showWebNotification(title, body) {
  if (!("Notification" in window) || Notification.permission !== "granted") {
    toast(body);
    return;
  }
  const options = {
    body,
    icon: "./assets/icon.svg",
    badge: "./assets/icon.svg",
    tag: "daypilot-checkin",
    renotify: true,
    data: { url: "./checkin" }
  };
  try {
    const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (registration && registration.showNotification) {
      await registration.showNotification(title, options);
      return;
    }
  } catch (error) {
    console.warn("SW notification failed", error);
  }
  try {
    const note = new Notification(title, options);
    note.onclick = () => {
      window.focus();
      navigate("stats");
      note.close();
    };
  } catch (error) {
    toast(body);
  }
}

async function saveCheckinReminder() {
  const timeInput = document.querySelector("[data-checkin-time]");
  const textInput = document.querySelector("[data-checkin-text]");
  const text = textInput ? textInput.value.trim() : "";
  let time = timeInput ? sanitizeTime(timeInput.value, "") : "";
  if (text) {
    const resolved = await resolveCheckinTime(text);
    if (!resolved) {
      toast(`Could not understand "${text}" as a time. Try "9:15 pm" or set the fixed time instead.`);
      return;
    }
    time = resolved;
  }
  if (!time) {
    toast("Pick a fixed time or describe one in words.");
    return;
  }
  const granted = await ensureNotificationPermission();
  state.settings.checkinEnabled = true;
  state.settings.checkinTime = time;
  state.settings.checkinText = text;
  const today = todayKey();
  if (state.checkins[today]) state.checkins[today] = { reminders: 0, done: state.checkins[today].done };
  persist();
  render();
  toast(`Check-in reminder set for ${formatTime(time)} daily${granted ? "" : " (notifications not granted yet)"}.`);
  scheduleCheckinLoop();
}

async function resolveCheckinTime(text) {
  const local = parseTimeFromText(text.toLowerCase());
  if (local) return local;
  const token = localStorage.getItem(geminiKey);
  if (!token) return null;
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `Convert this phrase into a 24-hour clock time. Return only JSON {"time":"HH:MM"}. Phrase: ${text}` }] }],
        generationConfig: { responseMimeType: "application/json" }
      })
    });
    if (!response.ok) return null;
    const data = await response.json();
    const raw = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
    if (!raw) return null;
    const parsed = JSON.parse(extractJsonBlock(raw));
    return sanitizeTime(parsed && parsed.time, "") || null;
  } catch {
    return null;
  }
}

function checkinRecord(dateKey) {
  if (!state.checkins[dateKey]) state.checkins[dateKey] = { reminders: 0, done: false };
  return state.checkins[dateKey];
}

function scheduleCheckinLoop() {
  clearTimeout(checkinTimer);
  if (!state.settings.checkinEnabled) return;
  const today = todayKey();
  const record = checkinRecord(today);
  const parts = state.settings.checkinTime.split(":").map(Number);
  const base = new Date();
  base.setHours(parts[0], parts[1], 0, 0);
  if (record.done || record.reminders >= 3) {
    // Done for today: arm tomorrow's first reminder.
    const tomorrow = new Date(base.getTime() + 24 * 3600000);
    checkinTimer = setTimeout(scheduleCheckinLoop, Math.min(tomorrow.getTime() - Date.now(), 6 * 3600000));
    return;
  }
  const nextAt = base.getTime() + record.reminders * 10 * 60000;
  const delay = Math.max(0, nextAt - Date.now());
  if (delay > 6 * 3600000) {
    // Timers drift badly at long horizons; re-evaluate closer to the target.
    checkinTimer = setTimeout(scheduleCheckinLoop, 6 * 3600000);
    return;
  }
  checkinTimer = setTimeout(fireCheckinReminder, delay);
}

function fireCheckinReminder() {
  if (!state.settings.checkinEnabled) return;
  const record = checkinRecord(todayKey());
  if (record.done || record.reminders >= 3) {
    scheduleCheckinLoop();
    return;
  }
  const parts = state.settings.checkinTime.split(":").map(Number);
  const base = new Date();
  base.setHours(parts[0], parts[1], 0, 0);
  if (Date.now() < base.getTime() + record.reminders * 10 * 60000) {
    // Fired early (timer drift); re-arm instead of nagging ahead of time.
    scheduleCheckinLoop();
    return;
  }
  record.reminders += 1;
  persist();
  const nth = record.reminders;
  showWebNotification(
    nth === 1 ? "Check-in time" : `Check-in reminder ${nth} of 3`,
    "How did today actually go? Tap to open the accountability page and log it."
  );
  scheduleCheckinLoop();
}

function markCheckinDone() {
  const record = checkinRecord(todayKey());
  if (!record.done) {
    record.done = true;
    persist();
  }
}

function toast(message) {
  const element = document.querySelector(".toast");
  if (!element) return;
  element.textContent = message;
  element.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add("hidden"), message.length > 120 ? 10000 : 2800);
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}
