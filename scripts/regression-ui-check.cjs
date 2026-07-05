const WebSocket = require("ws");

const endpoint = process.argv[2];
if (!endpoint) {
  console.error("Usage: node scripts/regression-ui-check.cjs ws://127.0.0.1:9222/devtools/page/<id>");
  process.exit(1);
}

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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception && result.exceptionDetails.exception.description
      ? result.exceptionDetails.exception.description
      : result.exceptionDetails.text;
    throw new Error(detail || "Browser evaluation failed");
  }
  return result;
}

async function waitForExpression(expression, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await evaluate(expression);
    if (result.result.value) return true;
    await wait(100);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

async function submitChat(text) {
  await waitForExpression("Boolean(document.querySelector('[data-open-modal=\"chat\"]'))");
  await evaluate("document.querySelector('[data-open-modal=\"chat\"]').click()");
  await waitForExpression("Boolean(document.querySelector('[data-chat-input]'))");
  await wait(200);
  await evaluate(`
    const input = document.querySelector('[data-chat-input]');
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-action="submit-chat"]').click();
  `);
  await wait(600);
}

function dayCode(dateKey) {
  return ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][new Date(`${dateKey}T00:00:00`).getDay()];
}

function byDayArray(recurrence) {
  if (!recurrence || !recurrence.byDay) return [];
  return Array.isArray(recurrence.byDay) ? recurrence.byDay : String(recurrence.byDay).split(",");
}

ws.on("open", async () => {
  try {
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Network.enable");
    await send("Network.setBypassServiceWorker", { bypass: true });
    await evaluate("localStorage.clear()");
    await send("Page.navigate", { url: "http://localhost:8000/" });
    await waitForExpression("Boolean(document.querySelector('[data-open-modal=\"chat\"]'))");
    await evaluate("document.querySelector('[data-open-modal=\"chat\"]').click()");
    await waitForExpression("Boolean(document.querySelector('[data-chat-sidekick]'))");
    const sidekickRender = await evaluate(`
      (() => {
        const sidekick = document.querySelector('[data-chat-sidekick]');
        const bot = sidekick && sidekick.querySelector('.mascot-bot');
        return JSON.stringify({
          sidekickClass: sidekick ? sidekick.className : '',
          botClass: bot ? bot.className : '',
          title: sidekick ? sidekick.querySelector('[data-sidekick-title]').textContent.trim() : ''
        });
      })()
    `);
    const sidekick = JSON.parse(sidekickRender.result.value);
    if (!sidekick.sidekickClass.includes("is-chat")) throw new Error(`Chat sidekick did not render in chat mood: ${JSON.stringify(sidekick)}`);
    if (!sidekick.botClass.includes("is-chat")) throw new Error(`Chat mascot did not render in chat mood: ${JSON.stringify(sidekick)}`);
    if (sidekick.title !== "Ready for the dump") throw new Error(`Unexpected sidekick copy: ${JSON.stringify(sidekick)}`);
    await evaluate("document.querySelector('[data-close-modal=\"true\"]').click()");
    await waitForExpression("!document.querySelector('[data-chat-sidekick]')");
    await submitChat("I wake up on 7:00 am on weekdays. On Saturdays I wake up at 9:00 am");
    const routineParsed = await evaluate(`
      JSON.stringify(JSON.parse(localStorage.getItem('daypilot-state-v2')).activities.map((a) => ({
        title: a.title,
        date: a.date,
        start: a.start,
        recurrence: a.recurrence,
        locked: a.locked
      })))
    `);
    const routines = JSON.parse(routineParsed.result.value);
    const weekdayWake = routines.find((item) => item.start === "07:00");
    const saturdayWake = routines.find((item) => item.start === "09:00");
    if (!weekdayWake) throw new Error(`Weekday wake-up routine missing: ${JSON.stringify(routines)}`);
    if (!saturdayWake) throw new Error(`Saturday wake-up routine missing: ${JSON.stringify(routines)}`);
    const weekdayDays = byDayArray(weekdayWake.recurrence);
    const saturdayDays = byDayArray(saturdayWake.recurrence);
    if (weekdayWake.title !== "Wake up") throw new Error(`Expected clean wake-up title, got ${weekdayWake.title}`);
    if (JSON.stringify(weekdayDays) !== JSON.stringify(["MO", "TU", "WE", "TH", "FR"])) {
      throw new Error(`Expected weekday recurrence, got ${JSON.stringify(weekdayWake.recurrence)}`);
    }
    if (!weekdayDays.includes(dayCode(weekdayWake.date))) throw new Error(`Weekday routine landed on ${weekdayWake.date}`);
    if (saturdayWake.title !== "Wake up") throw new Error(`Expected clean Saturday wake-up title, got ${saturdayWake.title}`);
    if (JSON.stringify(saturdayDays) !== JSON.stringify(["SA"])) {
      throw new Error(`Expected Saturday recurrence, got ${JSON.stringify(saturdayWake.recurrence)}`);
    }
    if (dayCode(saturdayWake.date) !== "SA") throw new Error(`Saturday routine landed on ${saturdayWake.date}`);
    await evaluate("document.querySelector('[data-view=\"week\"]').click()");
    await wait(300);
    await evaluate("document.querySelector('[data-view-shift=\"1\"]').click()");
    await waitForExpression("Boolean(document.querySelector('.week-view'))");
    const recurrenceUi = await evaluate(`
      (() => {
        const titles = [...document.querySelectorAll('.activity-card strong')].map((item) => item.textContent.trim());
        return JSON.stringify({
          wakeCount: titles.filter((title) => title === 'Wake up').length,
          label: document.querySelector('.view-stepper strong').textContent.trim()
        });
      })()
    `);
    const recurrenceView = JSON.parse(recurrenceUi.result.value);
    if (recurrenceView.wakeCount !== 6) throw new Error(`Recurring wake-up routines did not expand in week view: ${JSON.stringify(recurrenceView)}`);
    await evaluate("document.querySelector('[data-view=\"day\"]').click()");
    await waitForExpression("document.querySelector('.day-list') || document.querySelector('.empty-state')");
    await evaluate("document.querySelector('[data-view-shift=\"0\"]').click()");
    await wait(300);
    await evaluate("document.querySelector('[data-view-shift=\"1\"]').click()");
    await wait(300);
    const shiftedDate = await evaluate("JSON.parse(localStorage.getItem('daypilot-state-v2')).viewDate");
    if (shiftedDate.result.value !== "2026-07-06") throw new Error(`Day + control did not advance viewDate: ${shiftedDate.result.value}`);

    await evaluate("localStorage.clear()");
    await send("Page.reload", { ignoreCache: true });
    await wait(700);
    await submitChat("On wednesdays I have meeting xxx 9am 30m");
    const parsed = await evaluate(`
      JSON.stringify(JSON.parse(localStorage.getItem('daypilot-state-v2')).activities.map((a) => ({
        title: a.title,
        date: a.date,
        start: a.start,
        recurrence: a.recurrence,
        locked: a.locked
      })))
    `);
    const activities = JSON.parse(parsed.result.value);
    const activity = activities[0];
    if (!activity) throw new Error("No activity created");
    if (activity.recurrence.byDay !== "WE") throw new Error(`Expected WE recurrence, got ${JSON.stringify(activity.recurrence)}`);
    if (new Date(`${activity.date}T00:00:00`).getDay() !== 3) throw new Error(`Expected Wednesday date, got ${activity.date}`);
    if (activity.locked !== true) throw new Error("Expected meeting to be fixed/locked");

    await evaluate(`
      localStorage.setItem('daypilot-state-v2', JSON.stringify({
        view: 'day',
        route: 'home',
        mood: { label: 'Okay', energy: 55, stress: 35 },
        settings: { parserMode: 'manual', workDone: 0, exhaustion: 20, checkinEnabled: false, checkinTime: '21:00', checkinText: '' },
        profile: { workStart: '', workEnd: '', peakStart: '', peakEnd: '', maxFocusMin: 90, breakMin: 15, drainingTasks: '', energizingTasks: '' },
        selectedProject: 'Inbox',
        activities: [
          { id: 'locked-meeting', title: 'Meeting xxx', project: 'Inbox', branch: 'Main', date: '2026-07-08', start: '10:00', durationMin: 60, kind: 'routine', recurrence: null, note: '', status: 'planned', locked: true, notify: true, notifyMin: 10, updatedAt: '2026-07-05T00:00:00.000Z' },
          { id: 'write-intro', title: 'Write intro', project: 'Inbox', branch: 'Main', date: '2026-07-08', start: '13:00', durationMin: 60, kind: 'focus', recurrence: null, note: '', status: 'planned', locked: false, notify: true, notifyMin: 10, updatedAt: '2026-07-05T00:00:00.000Z' },
          { id: 'email-update', title: 'Email update', project: 'Inbox', branch: 'Main', date: '2026-07-08', start: '11:00', durationMin: 30, kind: 'admin', recurrence: null, note: '', status: 'planned', locked: false, notify: true, notifyMin: 10, updatedAt: '2026-07-05T00:00:00.000Z' }
        ],
        projectNotes: [],
        branches: [],
        checkins: {},
        calendar: { calendarId: '', lastSync: '' },
        calendarTombstones: [],
        chatDraft: '',
        activeModal: null,
        editingId: null,
        pendingParse: null,
        chatClarify: null,
        questionnaireReturn: null,
        pendingRecurringEdit: null,
        lastMessage: 'Regression state ready.'
      }));
    `);
    await send("Page.reload", { ignoreCache: true });
    await wait(700);
    await submitChat("move write intro to 10am");
    const rescheduled = await evaluate(`
      JSON.stringify(JSON.parse(localStorage.getItem('daypilot-state-v2')).activities.map((a) => ({
        id: a.id,
        title: a.title,
        date: a.date,
        start: a.start,
        locked: a.locked
      })).sort((a, b) => a.id.localeCompare(b.id)))
    `);
    const moved = JSON.parse(rescheduled.result.value);
    const byId = Object.fromEntries(moved.map((item) => [item.id, item]));
    if (byId["locked-meeting"].start !== "10:00") throw new Error("Fixed meeting moved during reschedule");
    if (byId["write-intro"].start !== "11:00") throw new Error(`Flexible target did not move after fixed meeting: ${byId["write-intro"].start}`);
    if (byId["email-update"].start !== "12:00") throw new Error(`Flexible neighbor did not shift after target: ${byId["email-update"].start}`);

    await evaluate(`
      localStorage.setItem('daypilot-state-v2', JSON.stringify({
        view: 'day',
        viewDate: '2026-07-05',
        route: 'notes',
        mood: { label: 'Okay', energy: 55, stress: 35 },
        settings: { parserMode: 'manual', workDone: 0, exhaustion: 20, checkinEnabled: false, checkinTime: '21:00', checkinText: '' },
        profile: { workStart: '', workEnd: '', peakStart: '', peakEnd: '', maxFocusMin: 90, breakMin: 15, drainingTasks: '', energizingTasks: '' },
        selectedProject: 'Inbox',
        activities: [],
        projectNotes: [
          { id: 'note-1', project: 'Inbox', branch: 'Main', section: 'task_seeds', text: 'Draft methods section', priority: 4, createdAt: '2026-07-05T00:00:00.000Z' }
        ],
        branches: [],
        checkins: {},
        calendar: { calendarId: '', lastSync: '' },
        calendarTombstones: [],
        chatDraft: '',
        activeModal: null,
        editingId: null,
        editingNoteId: null,
        pendingParse: null,
        chatClarify: null,
        questionnaireReturn: null,
        pendingRecurringEdit: null,
        lastMessage: 'Notes regression state ready.'
      }));
    `);
    await send("Page.navigate", { url: "http://localhost:8000/notes" });
    await waitForExpression("Boolean(document.querySelector('[data-note-action=\"event\"]'))");
    await evaluate("window.prompt = () => 'tomorrow 3pm 45m'");
    await evaluate("document.querySelector('[data-note-action=\"event\"][data-note-id=\"note-1\"]').click()");
    await wait(500);
    const noteEvent = await evaluate(`
      JSON.stringify(JSON.parse(localStorage.getItem('daypilot-state-v2')).activities.map((a) => ({
        title: a.title,
        project: a.project,
        branch: a.branch,
        date: a.date,
        start: a.start,
        durationMin: a.durationMin,
        note: a.note
      })))
    `);
    const noteEvents = JSON.parse(noteEvent.result.value);
    const createdFromNote = noteEvents.find((item) => item.title === "Draft methods section");
    if (!createdFromNote) throw new Error(`Note create-event button did not create activity: ${JSON.stringify(noteEvents)}`);
    if (createdFromNote.date !== "2026-07-06" || createdFromNote.start !== "15:00" || createdFromNote.durationMin !== 45) {
      throw new Error(`Note event did not use prompt timing: ${JSON.stringify(createdFromNote)}`);
    }

    await evaluate(`
      (() => {
        const key = (date) => {
          const year = date.getFullYear();
          const month = String(date.getMonth() + 1).padStart(2, '0');
          const day = String(date.getDate()).padStart(2, '0');
          return year + '-' + month + '-' + day;
        };
        const add = (amount) => {
          const date = new Date();
          date.setDate(date.getDate() + amount);
          return key(date);
        };
        localStorage.setItem('daypilot-state-v2', JSON.stringify({
          view: 'day',
          route: 'stats',
          mood: { label: 'Okay', energy: 55, stress: 35 },
          settings: { parserMode: 'manual', workDone: 0, exhaustion: 20, checkinEnabled: false, checkinTime: '21:00', checkinText: '' },
          profile: { workStart: '09:00', workEnd: '17:00', peakStart: '09:00', peakEnd: '12:00', maxFocusMin: 90, breakMin: 15, drainingTasks: '', energizingTasks: '' },
          selectedProject: 'Inbox',
          activities: [
            { id: 'old-done', title: 'Old done task', project: 'Inbox', branch: 'Main', date: add(-1), start: '09:00', durationMin: 30, kind: 'focus', recurrence: null, note: '', status: 'done', locked: false, notify: true, notifyMin: 10, updatedAt: '2026-07-05T00:00:00.000Z' },
            { id: 'today-focus', title: 'Today focus', project: 'Inbox', branch: 'Main', date: add(0), start: '10:00', durationMin: 60, kind: 'focus', recurrence: null, note: '', status: 'planned', locked: false, notify: true, notifyMin: 10, updatedAt: '2026-07-05T00:00:00.000Z' },
            { id: 'today-done', title: 'Today done already', project: 'Inbox', branch: 'Main', date: add(0), start: '11:30', durationMin: 30, kind: 'focus', recurrence: null, note: '', status: 'done', locked: false, notify: true, notifyMin: 10, updatedAt: '2026-07-05T00:00:00.000Z' },
            { id: 'tomorrow-focus', title: 'Tomorrow focus', project: 'Inbox', branch: 'Main', date: add(1), start: '09:00', durationMin: 45, kind: 'focus', recurrence: null, note: '', status: 'planned', locked: false, notify: true, notifyMin: 10, updatedAt: '2026-07-05T00:00:00.000Z' },
            { id: 'later-focus', title: 'Later focus', project: 'Inbox', branch: 'Main', date: add(2), start: '09:00', durationMin: 45, kind: 'focus', recurrence: null, note: '', status: 'planned', locked: false, notify: true, notifyMin: 10, updatedAt: '2026-07-05T00:00:00.000Z' }
          ],
          projectNotes: [],
          branches: [],
          checkins: {},
          calendar: { calendarId: '', lastSync: '' },
          calendarTombstones: [],
          chatDraft: '',
          activeModal: null,
          editingId: null,
          pendingParse: null,
          chatClarify: null,
          questionnaireReturn: null,
          pendingRecurringEdit: null,
          lastMessage: 'Accountability regression state ready.'
        }));
      })();
    `);
    await send("Page.navigate", { url: "http://localhost:8000/checkin" });
    await waitForExpression("Boolean(document.querySelector('.check-panel'))");
    const accountabilityInitial = await evaluate(`
      (() => {
        const panel = document.querySelector('.check-panel');
        return JSON.stringify({
          todayRows: [...panel.querySelectorAll('.check-section .check-row strong')].map((item) => item.textContent.trim()),
          upcomingRows: [...panel.querySelectorAll('.check-more .check-row strong')].map((item) => item.textContent.trim()),
          detailsOpen: Boolean(document.querySelector('.check-more') && document.querySelector('.check-more').open),
          hasOldDone: panel.textContent.includes('Old done task'),
          hasTodayDone: panel.textContent.includes('Today done already')
        });
      })()
    `);
    const initialCheck = JSON.parse(accountabilityInitial.result.value);
    if (JSON.stringify(initialCheck.todayRows) !== JSON.stringify(["Today focus"])) {
      throw new Error(`Accountability should show only today's open task first: ${JSON.stringify(initialCheck)}`);
    }
    if (JSON.stringify(initialCheck.upcomingRows) !== JSON.stringify(["Tomorrow focus", "Later focus"])) {
      throw new Error(`Upcoming tasks should be oldest-first in the collapsed section: ${JSON.stringify(initialCheck)}`);
    }
    if (initialCheck.detailsOpen) throw new Error("Upcoming accountability section should start collapsed");
    if (initialCheck.hasOldDone || initialCheck.hasTodayDone) throw new Error(`Completed tasks leaked into active accountability check-in: ${JSON.stringify(initialCheck)}`);

    await evaluate(`document.querySelector('[data-status-id="today-focus"][data-status="partial"]').click()`);
    await wait(600);
    const partialCheck = await evaluate(`
      (() => {
        const saved = JSON.parse(localStorage.getItem('daypilot-state-v2'));
        const original = saved.activities.find((item) => item.id === 'today-focus');
        const followUp = saved.activities.find((item) => item.partialFromId === 'today-focus');
        const todayRows = [...document.querySelectorAll('.check-section .check-row strong')].map((item) => item.textContent.trim());
        return JSON.stringify({ original, followUp, todayRows });
      })()
    `);
    const partial = JSON.parse(partialCheck.result.value);
    if (!partial.original || partial.original.status !== "partial") throw new Error(`Original partial status not saved: ${JSON.stringify(partial)}`);
    if (!partial.followUp) throw new Error(`Partial check-in did not create a follow-up: ${JSON.stringify(partial)}`);
    if (partial.followUp.status !== "planned") throw new Error(`Follow-up should be planned: ${JSON.stringify(partial.followUp)}`);
    if (partial.followUp.date <= partial.original.date) throw new Error(`Follow-up should be after the partial task date: ${JSON.stringify(partial.followUp)}`);
    if (partial.followUp.durationMin !== 30) throw new Error(`Follow-up should use the remaining half duration: ${JSON.stringify(partial.followUp)}`);
    if (partial.todayRows.includes("Today focus")) throw new Error(`Partial task should leave today's active queue: ${JSON.stringify(partial.todayRows)}`);

    await evaluate(`document.querySelector('[data-status-id="tomorrow-focus"][data-status="done"]').click()`);
    await wait(400);
    const earlyDone = await evaluate(`
      (() => {
        const saved = JSON.parse(localStorage.getItem('daypilot-state-v2'));
        return JSON.stringify(saved.activities.find((item) => item.id === 'tomorrow-focus'));
      })()
    `);
    const tomorrowDone = JSON.parse(earlyDone.result.value);
    if (!tomorrowDone || tomorrowDone.status !== "done") throw new Error(`Could not mark upcoming task done from accountability: ${JSON.stringify(tomorrowDone)}`);

    console.log(JSON.stringify({ routines, parsed: activity, rescheduled: moved, accountability: { initialCheck, partial, tomorrowDone } }));
    ws.close();
  } catch (error) {
    console.error(error);
    ws.close();
    process.exitCode = 1;
  }
});
