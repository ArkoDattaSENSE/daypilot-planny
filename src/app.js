import { initFirebase, saveCloudState, loadCloudState, signIn, signOut } from "./firebase.js";

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
    exhaustion: 20
  },
  selectedProject: "Inbox",
  activities: [],
  projectNotes: [],
  branches: [],
  checkins: {},
  chatDraft: "",
  activeModal: null,
  editingId: null,
  lastMessage: "Blank slate ready. Add a task or dump into chat."
};

let state = loadState();
let firebaseRuntime = null;

boot();

async function boot() {
  registerServiceWorker();
  firebaseRuntime = await initFirebase(readFirebaseConfig());
  if (firebaseRuntime.ready && firebaseRuntime.user) {
    const cloud = await loadCloudState(firebaseRuntime);
    if (cloud) {
      state = normalizeState(cloud);
      saveLocal();
    }
  }
  render();
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
  next.activities = (Array.isArray(next.activities) ? next.activities : []).map(sanitizeActivity).filter(Boolean);
  next.projectNotes = (Array.isArray(next.projectNotes) ? next.projectNotes : []).map(sanitizeNote).filter(Boolean);
  next.branches = (Array.isArray(next.branches) ? next.branches : []).map(sanitizeBranchEntry).filter(Boolean);
  next.selectedProject = normalizeProject(next.selectedProject || firstProject(next));
  next.checkins = next.checkins && typeof next.checkins === "object" ? next.checkins : {};
  next.chatDraft = typeof next.chatDraft === "string" ? next.chatDraft : "";
  return next;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
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
  return {
    id: typeof item.id === "string" && item.id ? item.id : makeId(),
    title,
    project: normalizeProject(item.project),
    branch: normalizeBranch(item.branch),
    date: sanitizeDateKey(item.date, todayKey()),
    start: sanitizeTime(item.start, "09:00"),
    durationMin: clampNumber(item.durationMin, 5, 600, 30),
    kind: sanitizeKind(item.kind),
    note: String(item.note || "").slice(0, 2000),
    status: sanitizeStatus(item.status)
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
        <p>${escapeHtml(state.mood.label)} - energy ${state.mood.energy}% - stress ${state.mood.stress}%</p>
      </div>
      <label>
        Mood
        <input data-mood="label" value="${escapeAttr(state.mood.label)}" aria-label="Mood label">
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
        <h2>No activities yet</h2>
        <p>Use Chat for a dump, or + for a manual task.</p>
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
        <button class="activity-card ${escapeAttr(activity.kind)}" data-edit="${activity.id}">
          <span>${formatTime(activity.start)}</span>
          <strong>${escapeHtml(activity.title)}</strong>
          <em>${escapeHtml(activity.project || "Inbox")} / ${escapeHtml(activity.branch || "Main")} - ${activity.durationMin}m - ${escapeHtml(activity.status || "planned")}${activity.recurrence ? ` - ${escapeHtml(recurrenceLabel(activity.recurrence))}` : ""}</em>
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
            ${noteSections().map((section) => renderNoteSection(section, notes)).join("")}
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
        <button data-branch-action="boost" data-branch-id="${branch.id}">Boost</button>
        <button data-branch-action="pause" data-branch-id="${branch.id}">Pause</button>
        <button data-branch-action="plan" data-branch-id="${branch.id}">Plan next week</button>
        <button data-branch-action="next" data-branch-id="${branch.id}">Next action</button>
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
              ${["done", "partial", "missed"].map((status) => `<button class="${activity.status === status ? "active" : ""}" data-status="${status}" data-status-id="${activity.id}">${titleCase(status)}</button>`).join("")}
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
          <a class="external-link" href="https://console.firebase.google.com/" target="_blank" rel="noreferrer">Open Firebase Console</a>
        </div>
        <ol class="setup-steps">
          <li>
            <strong>Create or open a Firebase project.</strong>
            <span>Click Add project if you do not have one. Keep it on the free Spark plan.</span>
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
            <strong>Paste it below and save.</strong>
            <span>Then click Google sign-in. If Google sign-in fails, enable Authentication -> Sign-in method -> Google in Firebase Console.</span>
          </li>
        </ol>
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
  return "";
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
        <textarea data-chat-input placeholder="Dump tasks, routines, edits, or reschedule requests. Example: tomorrow 9:30 write intro 90m"></textarea>
        <div class="button-row">
          <button class="primary" data-action="submit-chat">Add from chat</button>
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
            <label>Minutes <input type="number" min="5" step="5" name="durationMin" value="${activity.durationMin}"></label>
            <label>Repeats <input name="recurrence" value="${escapeAttr(recurrenceInputValue(activity.recurrence))}" placeholder="every Wednesday, daily, weekly"></label>
            <label>Type
              <select name="kind">
                ${["focus", "admin", "routine", "personal"].map((kind) => `<option value="${kind}" ${activity.kind === kind ? "selected" : ""}>${titleCase(kind)}</option>`).join("")}
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
    input.addEventListener("input", () => {
      const key = input.dataset.mood;
      state.mood[key] = key === "label" ? input.value : Number(input.value);
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
      state.settings.parserMode = button.dataset.chatMode;
      persist();
      render();
    });
  });

  const chatSubmit = document.querySelector("[data-action='submit-chat']");
  if (chatSubmit) chatSubmit.addEventListener("click", submitChat);
  const taskForm = document.querySelector("[data-form='task']");
  if (taskForm) taskForm.addEventListener("submit", submitTaskForm);

  document.querySelectorAll("[data-setting]").forEach((input) => {
    input.addEventListener("input", () => {
      state.settings[input.dataset.setting] = input.type === "range" ? Number(input.value) : input.value;
      persist();
      render();
    });
  });

  document.querySelectorAll("[data-status-id]").forEach((button) => {
    button.addEventListener("click", () => {
      updateActivity(button.dataset.statusId, { status: button.dataset.status });
      state.lastMessage = "Check-in saved.";
      persist();
      render();
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
  if (action === "save-gemini") {
    localStorage.setItem(geminiKey, document.querySelector("[data-secret='gemini']").value.trim());
    toast("Gemini token saved locally.");
    return;
  }
  if (action === "clear-gemini") {
    localStorage.removeItem(geminiKey);
    render();
    return;
  }
  if (action === "google-signin") {
    try {
      await signIn(firebaseRuntime);
      firebaseRuntime = await initFirebase(readFirebaseConfig());
      persist();
      render();
    } catch (error) {
      toast(error.message);
    }
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
    state.activities = state.activities.filter((activity) => activity.id !== state.editingId);
    state.activeModal = null;
    state.editingId = null;
    state.lastMessage = "Activity deleted.";
    persist();
    render();
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
  }
}

async function submitChat() {
  const input = document.querySelector("[data-chat-input]");
  const text = input.value.trim();
  if (!text) return;
  const mode = state.settings.parserMode;
  const token = localStorage.getItem(geminiKey);
  if (mode === "gemini" && !token) {
    toast("Add a Gemini token first.");
    return;
  }
  let parsed = { activities: [], notes: [] };
  if (mode === "gemini") {
    parsed = await parseWithGemini(text, token).catch(() => parseNoLlm(text));
  } else {
    parsed = parseNoLlm(text);
  }
  state.activities = [...state.activities, ...parsed.activities];
  state.projectNotes = [...state.projectNotes, ...parsed.notes];
  ensureBranchesForActivities(parsed.activities);
  ensureBranchesForNotes(parsed.notes);
  state.activeModal = null;
  state.lastMessage = `${parsed.activities.length} task${parsed.activities.length === 1 ? "" : "s"} and ${parsed.notes.length} note${parsed.notes.length === 1 ? "" : "s"} added from chat.`;
  persist();
  render();
}

function submitTaskForm(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const activity = {
    id: state.editingId || makeId(),
    title: form.get("title").trim(),
    project: normalizeProject(form.get("project")),
    branch: normalizeBranch(form.get("branch")),
    date: form.get("date") || todayKey(),
    start: form.get("start") || "09:00",
    durationMin: Number(form.get("durationMin") || 30),
    kind: form.get("kind") || "focus",
    recurrence: parseRecurrence(form.get("recurrence")),
    note: form.get("note").trim(),
    status: (getEditingActivity() && getEditingActivity().status) || "planned"
  };
  ensureBranch(activity.project, activity.branch);
  if (state.editingId) {
    state.activities = state.activities.map((item) => item.id === state.editingId ? activity : item);
    state.lastMessage = "Activity updated.";
  } else {
    state.activities.push(activity);
    state.lastMessage = "Activity added.";
  }
  state.activeModal = null;
  state.editingId = null;
  persist();
  render();
}

function parseNoLlm(text) {
  const lines = text.split(/\n|;/).map((line) => line.replace(/^[-*\d.)\s]+/, "").trim()).filter(Boolean);
  const parsed = { activities: [], notes: [] };
  lines.forEach((line) => {
    const lower = line.toLowerCase();
    const project = projectFromText(lower);
    const branch = branchFromText(lower);
    if (isNoteLine(lower)) {
      parsed.notes.push({
        id: makeId(),
        project,
        branch,
        section: inferNoteSection(lower),
        text: cleanNoteText(line),
        priority: inferNotePriority(lower),
        createdAt: new Date().toISOString()
      });
      ensureBranch(project, branch);
      return;
    }
    const duration = lower.match(/(\d+)\s?(m|min|minutes|h|hr|hours)/);
    const time = lower.match(/\b([01]?\d|2[0-3])(?::([0-5]\d))?\s?(am|pm)?\b/);
    const recurrence = parseRecurrence(lower);
    const durationMin = duration ? Number(duration[1]) * (duration[2].startsWith("h") ? 60 : 1) : 30;
    const date = lower.includes("tomorrow") ? addDays(todayKey(), 1) : recurrence ? nextDateForRecurrence(recurrence) : todayKey();
    parsed.activities.push({
      id: makeId(),
      title: cleanTaskTitle(line),
      project,
      branch,
      date,
      start: time ? normalizeTime(time) : nextOpenTime(),
      durationMin,
      kind: inferKind(lower),
      recurrence,
      note: "",
      status: "planned"
    });
    ensureBranch(project, branch);
  });
  return parsed;
}

async function parseWithGemini(text, token) {
  const prompt = `Return only JSON with shape {"activities":[],"notes":[]}. Do not wrap in markdown.

For each activity:
- title: a short clean task title only. Do NOT copy the whole user prompt. Remove words like "add", "schedule", "every Wednesday", dates, times, duration, and filler. Example input "every Wednesday 9am do lab journal 30m" -> title "Lab journal".
- sourceText: the exact input line that created this activity.
- project, branch
- date: YYYY-MM-DD for the next occurrence, or empty if unknown.
- start: HH:MM 24-hour time, or empty.
- durationMin: number.
- kind: focus/admin/routine/personal.
- recurrence: null OR {"frequency":"daily|weekly|monthly","byDay":"MO|TU|WE|TH|FR|SA|SU"}. For "every Wednesday", use {"frequency":"weekly","byDay":"WE"}.

For notes:
- project, branch, section one of pinned_context/open_decisions/future_ideas/blocked_by/meeting_notes/task_seeds/someday_not_now, text, priority 1-5.

Text:
${text}`;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  if (!response.ok) throw new Error("Gemini request failed");
  const data = await response.json();
  const raw = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0].text;
  const json = raw.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(json);
  const activities = Array.isArray(parsed) ? parsed : (parsed.activities || []);
  return {
    activities: activities.map((item) => normalizeParsedActivity(item, text)),
    notes: (Array.isArray(parsed) ? [] : (parsed.notes || [])).map((note) => ({
      id: makeId(),
      project: normalizeProject(note.project),
      branch: normalizeBranch(note.branch),
      section: noteSections().includes(note.section) ? note.section : "task_seeds",
      text: note.text || "",
      priority: Number(note.priority || 3),
      createdAt: new Date().toISOString()
    }))
  };
}

function normalizeParsedActivity(item, originalText) {
  const recurrence = normalizeRecurrence(item.recurrence) || parseRecurrence(`${item.sourceText || ""} ${item.title || ""} ${originalText || ""}`);
  const sourceText = item.sourceText || originalText || item.title || "";
  return {
    id: makeId(),
    title: cleanTaskTitle(item.title || sourceText),
    project: normalizeProject(item.project || projectFromText(sourceText.toLowerCase())),
    branch: normalizeBranch(item.branch || branchFromText(sourceText.toLowerCase())),
    date: item.date || (recurrence ? nextDateForRecurrence(recurrence) : todayKey()),
    start: item.start || nextOpenTime(),
    durationMin: Number(item.durationMin || 30),
    kind: item.kind || (recurrence ? "routine" : "focus"),
    recurrence,
    note: "",
    status: "planned"
  };
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
  try {
    JSON.parse(value);
    localStorage.setItem(firebaseKey, value);
    toast("Firebase config saved.");
    boot();
  } catch {
    toast("Firebase config must be valid JSON.");
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
    section,
    text,
    priority: inferNotePriority(text.toLowerCase()),
    createdAt: new Date().toISOString()
  });
  state.lastMessage = "Project note saved.";
  persist();
  render();
}

function submitBranch(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const name = normalizeBranch(form.get("name"));
  ensureBranch(state.selectedProject || "Inbox", name);
  state.lastMessage = `${name} branch added.`;
  persist();
  render();
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
  persist();
  render();
}

function createSubtaskFromEditingNote() {
  const activity = getEditingActivity();
  if (!activity || !activity.note) return;
  state.activities.push({
    id: makeId(),
    title: firstUsefulLine(activity.note, `Follow up: ${activity.title}`),
    project: activity.project || "Inbox",
    branch: activity.branch || "Main",
    date: activity.date || todayKey(),
    start: nextOpenTime(),
    durationMin: 30,
    kind: activity.kind || "focus",
    note: `From note on ${activity.title}`,
    status: "planned"
  });
  state.lastMessage = "Subtask created from note.";
  state.activeModal = null;
  state.editingId = null;
  persist();
  render();
}

function saveEditingNoteToProject() {
  const activity = getEditingActivity();
  if (!activity || !activity.note) return;
  state.projectNotes.unshift({
    id: makeId(),
    project: activity.project || "Inbox",
    branch: activity.branch || "Main",
    section: inferNoteSection(activity.note.toLowerCase()),
    text: activity.note,
    priority: inferNotePriority(activity.note.toLowerCase()),
    linkedActivityId: activity.id,
    createdAt: new Date().toISOString()
  });
  state.selectedProject = activity.project || "Inbox";
  state.lastMessage = "Task note saved to project board.";
  state.activeModal = null;
  state.editingId = null;
  persist();
  render();
}

function applyEditingNoteSignals() {
  const activity = getEditingActivity();
  if (!activity || !activity.note) return;
  const note = activity.note.toLowerCase();
  const changes = {};
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
  state.lastMessage = Object.keys(changes).length ? "Note signals applied to the schedule." : "No strong scheduling signal found in note.";
  state.activeModal = null;
  state.editingId = null;
  persist();
  render();
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
  state.lastMessage = "Task created from latest project note.";
  persist();
  render();
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
  state.activities = state.activities.map((activity) => activity.id === id ? { ...activity, ...changes } : activity);
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
  if (!state.activities.length) return "09:00";
  const last = sortedActivities()[state.activities.length - 1];
  return addMinutes(last.start, last.durationMin || 30);
}

function addMinutes(time, minutes) {
  const parts = time.split(":").map(Number);
  const total = parts[0] * 60 + parts[1] + minutes;
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function normalizeTime(match) {
  let hour = Number(match[1]);
  const minute = match[2] || "00";
  const suffix = match[3];
  if (suffix === "pm" && hour < 12) hour += 12;
  if (suffix === "am" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${minute}`;
}

function inferKind(lower) {
  if (/walk|workout|sleep|call/.test(lower)) return "personal";
  if (/mail|send|admin|upload|print/.test(lower)) return "admin";
  if (/daily|every|routine/.test(lower)) return "routine";
  return "focus";
}

function parseRecurrence(value) {
  const lower = String(value || "").toLowerCase().trim();
  if (!lower) return null;
  if (/\b(daily|every day|each day)\b/.test(lower)) return { frequency: "daily" };
  const weekday = lower.match(/\b(every|each|on)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/);
  if (weekday) return { frequency: "weekly", byDay: weekdayCode(weekday[2]) };
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

function weekdayName(code) {
  return ({ MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday", FR: "Friday", SA: "Saturday", SU: "Sunday" })[String(code || "").toUpperCase()] || "week";
}

function weekdayIndex(code) {
  return ({ SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 })[String(code || "").toUpperCase()] || 0;
}

function cleanTitle(line) {
  return line
    .replace(/\b(today|tomorrow|tonight|daily|every day|weekly|monthly)\b/gi, "")
    .replace(/\b(every|each|on)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/gi, "")
    .replace(/\b\d+\s?(m|min|minutes|h|hr|hours)\b/gi, "")
    .replace(/\b([01]?\d|2[0-3])(?::([0-5]\d))?\s?(am|pm)?\b/gi, "")
    .replace(/\s+/g, " ")
    .trim() || "Untitled";
}

function cleanTaskTitle(value) {
  const cleaned = cleanTitle(String(value || "")
    .replace(/^(add|create|schedule|make|remind me to|i need to|please|can you)\s+/i, "")
    .replace(/\b(to my calendar|in my planner|as a task)\b/gi, ""));
  return titleCase(cleaned.charAt(0).toLowerCase() === cleaned.charAt(0) ? cleaned : cleaned);
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
  const parts = time.split(":").map(Number);
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

function toast(message) {
  const element = document.querySelector(".toast");
  if (!element) return;
  element.textContent = message;
  element.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add("hidden"), 2800);
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}
