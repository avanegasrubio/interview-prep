# Edwin's Interview Reps

A small study app: 20 technical interview questions and 6 STAR stories, one "ticket" a day, with progress and a streak.

## Deploy to Vercel
1. Go to vercel.com and sign in.
2. Add New > Project, then drag this folder in (or push it to a GitHub repo and import that repo).
3. Framework preset: Other. No build command, no output directory. Click Deploy.

## Put it on the phone
- iPhone: open the site in Safari, tap Share, then Add to Home Screen.
- Android: open it in Chrome, tap the menu, then Add to Home screen or Install app.

## Data
Progress and the streak are saved on the phone itself (browser storage). No database or server is needed.
They stay on that one phone and browser, and clearing the browser's site data resets them.

## Updating
Edit index.html, then bump CACHE in sw.js (for example interview-reps-v2) so phones pick up the new version.

## What's in the app
- Today: daily minimum (1 ticket + 1 application), application nudges, follow-ups due, calendar reminders.
- Jobs: the vetted shortlist from jobs.json, with status tracking. Update jobs.json to add or change vetted roles.
- People: import LinkedIn Connections.csv, matched to target companies, with outreach status and message templates. Contacts stay on the phone and are never committed to this repo.
- Practice: 20 technical questions and 6 STAR stories, with a 90-second record-yourself timer.
- Week: applications, replies, interviews and offers for the week, with a copy button.

This repo is public. Never commit personal details (contacts, phone numbers, emails) to it.
