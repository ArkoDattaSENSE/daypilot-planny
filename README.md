# DayPilot / Planny

A static, minimal scheduling PWA built from the supplied DayPilot design bundle.

## What is included

- One main planning screen with Day, Week, and Month views.
- Mood panel at the top of the planner.
- Chat modal for no-LLM or Gemini-assisted task dumps.
- Planning profile questionnaire (work hours, peak focus window, draining vs energizing tasks). Required once when Gemini is connected; synced to Firestore with the rest of the state.
- Gemini planning uses the profile plus the existing schedule, asks at most one clarifying question when confused, and always shows an "I made this - add it?" confirmation with per-item checkboxes before anything is saved.
- Offline no-LLM parser understands weekdays ("next friday"), word numbers, natural durations ("half an hour"), times of day ("evening"), recurrence ("every wednesday"), and profile-driven requests like "schedule four productive slots".
- Manual task modal for add, edit, delete, task notes, and note-driven rescheduling.
- Compact project notes board with pinned context, decisions, blockers, meeting notes, task seeds, and future ideas.
- Lightweight project branches with boost, pause, plan-next-week, and next-action controls.
- Accountability page with work-done and exhaustion tuning.
- Settings page for Firebase sync and Gemini token setup.
- Firebase Spark-ready backend: Google Auth plus per-user Firestore state.
- Google Calendar 2-way sync into a dedicated "Planny" calendar on the same Google account: tasks push as events, and events added or edited in Google Calendar flow back as tasks. Guided click-through setup lives in Settings (enable Calendar API, create an OAuth web client ID in your own Firebase/Google Cloud project, paste it, connect).
- No shared backend: each user connects their own Firebase project and their own OAuth client. The repo and the deployed app contain no project config.
- GitHub Pages workflow that publishes only the clean `dist/` artifact.

## Local

```bash
npm test
npm run build
python3 -m http.server 8000
```

Open `http://127.0.0.1:8000/`.

## Setting Firebase Up

Keep personal Firebase config out of git. This repo ignores `.firebaserc`, and the app does not commit any Firebase Web App config.

To find a Firebase project ID later:

```bash
FIREBASE_CLI_DISABLE_UPDATE_CHECK=true ./node_modules/.bin/firebase projects:list
```

The project ID is the value in the `Project ID` column, not the display name or project number.

For a new project, keep it on the free Spark plan and then:

1. Create a Firebase project on the Spark plan.
2. Enable Authentication, then enable the Google provider.
3. Enable Cloud Firestore.
4. Create a Web App in Firebase project settings.
5. Copy the Web App config object.
6. In DayPilot, open Settings and paste the Firebase Web App config JSON.
7. Deploy `firestore.rules` and Hosting with one of the commands below.

For local deploys, either create an untracked `.firebaserc`:

```bash
cp .firebaserc.example .firebaserc
# edit .firebaserc with your project id
npm run deploy:firebase
```

or pass the project id once:

```bash
FIREBASE_PROJECT=your-project-id npm run deploy:firebase
```

The deploy command builds the clean static artifact into `dist/` and deploys only that folder plus Firestore rules.

The app stores data at:

```text
/users/{uid}/appState/current
```

The included rule only lets the signed-in user read and write their own path.

## GitHub Pages deploy

This workspace has a read-only `.git` placeholder, so Codex initialized the usable git repository at `.planny_git`.

```bash
git --git-dir=.planny_git --work-tree=. branch -M main
git --git-dir=.planny_git --work-tree=. add .
git --git-dir=.planny_git --work-tree=. commit -m "Build DayPilot static PWA"
gh repo create daypilot-planny --public --description "DayPilot static PWA" --remote origin
git --git-dir=.planny_git --work-tree=. push -u origin main
```

Then enable Pages in the repo settings with GitHub Actions as the source. The included workflow deploys on push.

## Firebase Hosting deploy

Firebase Hosting is optional because the frontend is designed for GitHub Pages, but the config is included:

Use the project script instead of the global Firebase binary:

```bash
npm run deploy:firebase
```

If you want to override `.firebaserc` for one deploy:

```bash
FIREBASE_PROJECT=your-project-id npm run deploy:firebase
```
