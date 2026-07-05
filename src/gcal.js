const clientIdKey = "daypilot-gcal-client-id";
const tokenKey = "daypilot-gcal-token";
const calendarName = "Planny";
const apiBase = "https://www.googleapis.com/calendar/v3";

export function getCalendarClientId() {
  return localStorage.getItem(clientIdKey) || "";
}

export function setCalendarClientId(clientId) {
  if (clientId) localStorage.setItem(clientIdKey, clientId);
  else localStorage.removeItem(clientIdKey);
}

export function clearCalendarToken() {
  localStorage.removeItem(tokenKey);
}

export function hasValidToken() {
  const token = readToken();
  return Boolean(token && token.expiresAt - 60000 > Date.now());
}

function readToken() {
  try {
    return JSON.parse(localStorage.getItem(tokenKey) || "null");
  } catch {
    return null;
  }
}

function loadGisScript() {
  if (window.google && window.google.accounts && window.google.accounts.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector("script[data-gis]");
    if (existing) {
      existing.addEventListener("load", resolve);
      existing.addEventListener("error", () => reject(new Error("Could not load Google sign-in script.")));
      return;
    }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.dataset.gis = "true";
    script.onload = resolve;
    script.onerror = () => reject(new Error("Could not load Google sign-in script."));
    document.head.appendChild(script);
  });
}

export async function requestCalendarToken(interactive) {
  const cached = readToken();
  if (cached && cached.expiresAt - 60000 > Date.now()) return cached.accessToken;
  const clientId = getCalendarClientId();
  if (!clientId) throw new Error("Save an OAuth Client ID first.");
  if (!interactive) throw new Error("Calendar session expired. Click Sync now to reconnect.");
  await loadGisScript();
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: "https://www.googleapis.com/auth/calendar",
      callback: (response) => {
        if (response.error) {
          reject(new Error(`Google authorization failed: ${response.error}`));
          return;
        }
        const record = {
          accessToken: response.access_token,
          expiresAt: Date.now() + Number(response.expires_in || 3600) * 1000
        };
        localStorage.setItem(tokenKey, JSON.stringify(record));
        resolve(record.accessToken);
      },
      error_callback: (error) => reject(new Error(error && error.message ? error.message : "Google authorization was closed."))
    });
    client.requestAccessToken({ prompt: "" });
  });
}

async function api(token, method, path, body) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (response.status === 401) {
    clearCalendarToken();
    throw new Error("Calendar session expired. Click Sync now to reconnect.");
  }
  if (response.status === 410) return null;
  if (!response.ok) {
    let detail = "";
    try {
      const data = await response.json();
      detail = data && data.error && data.error.message ? ` ${data.error.message}` : "";
    } catch {
      detail = "";
    }
    throw new Error(`Calendar request failed (HTTP ${response.status}).${detail}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

export async function ensurePlannyCalendar(token) {
  let pageToken = "";
  do {
    const page = await api(token, "GET", `/users/me/calendarList?maxResults=250${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`);
    const match = (page.items || []).find((item) => item.summary === calendarName && item.accessRole === "owner");
    if (match) return match.id;
    pageToken = page.nextPageToken || "";
  } while (pageToken);
  const created = await api(token, "POST", "/calendars", {
    summary: calendarName,
    description: "Created by DayPilot / Planny. Two-way synced with your plan."
  });
  return created.id;
}

function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function endTime(date, start, durationMin) {
  const begin = new Date(`${date}T${start}:00`);
  return new Date(begin.getTime() + durationMin * 60000);
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function toLocalStamp(dateObj) {
  return `${dateObj.getFullYear()}-${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())}T${pad(dateObj.getHours())}:${pad(dateObj.getMinutes())}:00`;
}

function recurrenceRule(recurrence) {
  if (!recurrence) return undefined;
  if (recurrence.frequency === "daily") return ["RRULE:FREQ=DAILY"];
  if (recurrence.frequency === "weekly" && recurrence.byDay) return [`RRULE:FREQ=WEEKLY;BYDAY=${recurrence.byDay}`];
  if (recurrence.frequency === "weekly") return ["RRULE:FREQ=WEEKLY"];
  if (recurrence.frequency === "monthly") return ["RRULE:FREQ=MONTHLY"];
  return undefined;
}

export function parseEventRecurrence(rules) {
  const rule = Array.isArray(rules) ? rules.find((item) => item.startsWith("RRULE:")) : null;
  if (!rule) return null;
  if (/FREQ=DAILY/.test(rule)) return { frequency: "daily" };
  const byDay = rule.match(/BYDAY=([A-Z]{2})/);
  if (/FREQ=WEEKLY/.test(rule)) return byDay ? { frequency: "weekly", byDay: byDay[1] } : { frequency: "weekly" };
  if (/FREQ=MONTHLY/.test(rule)) return { frequency: "monthly" };
  return null;
}

export function activityToEvent(activity) {
  const zone = localTimeZone();
  const startDate = new Date(`${activity.date}T${activity.start}:00`);
  return {
    summary: activity.title,
    description: activity.note || "",
    start: { dateTime: toLocalStamp(startDate), timeZone: zone },
    end: { dateTime: toLocalStamp(endTime(activity.date, activity.start, activity.durationMin)), timeZone: zone },
    recurrence: recurrenceRule(activity.recurrence),
    extendedProperties: {
      private: {
        plannyId: activity.id,
        plannyProject: activity.project || "Inbox",
        plannyBranch: activity.branch || "Main",
        plannyKind: activity.kind || "focus"
      }
    }
  };
}

export async function insertEvent(token, calendarId, activity) {
  return api(token, "POST", `/calendars/${encodeURIComponent(calendarId)}/events`, activityToEvent(activity));
}

export async function patchEvent(token, calendarId, eventId, activity) {
  return api(token, "PATCH", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, activityToEvent(activity));
}

export async function deleteEvent(token, calendarId, eventId) {
  try {
    await api(token, "DELETE", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
  } catch (error) {
    if (!/HTTP 404|HTTP 410/.test(error.message)) throw error;
  }
}

export async function listEvents(token, calendarId, updatedMin) {
  const items = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({ maxResults: "250", showDeleted: "true", singleEvents: "false" });
    if (updatedMin) params.set("updatedMin", updatedMin);
    if (pageToken) params.set("pageToken", pageToken);
    const page = await api(token, "GET", `/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`);
    if (page === null) {
      // 410 Gone: updatedMin too old, refetch everything once.
      return listEvents(token, calendarId, "");
    }
    items.push(...(page.items || []));
    pageToken = page.nextPageToken || "";
  } while (pageToken);
  return items;
}

export function eventToActivityFields(event) {
  const start = event.start || {};
  const end = event.end || {};
  let date;
  let startTime;
  let durationMin;
  if (start.dateTime) {
    const begin = new Date(start.dateTime);
    date = `${begin.getFullYear()}-${pad(begin.getMonth() + 1)}-${pad(begin.getDate())}`;
    startTime = `${pad(begin.getHours())}:${pad(begin.getMinutes())}`;
    const finish = end.dateTime ? new Date(end.dateTime) : new Date(begin.getTime() + 30 * 60000);
    durationMin = Math.round((finish.getTime() - begin.getTime()) / 60000);
  } else {
    date = start.date || null;
    startTime = "09:00";
    durationMin = 60;
  }
  return {
    title: event.summary || "Untitled event",
    note: event.description || "",
    date,
    start: startTime,
    durationMin,
    recurrence: parseEventRecurrence(event.recurrence)
  };
}
