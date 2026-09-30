# Edwin's Interview Reps

A small study app: 20 technical interview questions and 6 STAR stories, one "ticket" a day, with progress and a streak.

## Deploy to Vercel
1. Go to vercel.com and sign in.
2. Add New > Project, then drag this folder in (or push it to a GitHub repo and import that repo).
3. Framework preset: Other. No build command, no output directory. Click Deploy.

## Put it on the phone
- iPhone: open the site in Safari, tap Share, then Add to Home Screen.
- Android: open it in Chrome, tap the menu, then Add to Home screen or Install app.

## Data and sign-in
Sign-in and data live in Supabase (project: interview-reps). Only emails in the members table can see anything,
each member sees only their own statuses, contacts and progress, and the admin can see everyone's.
The Admin tab (admin only) adds vetted jobs, archives jobs, and sends contacts to a member's People list.
The Supabase URL and anon key in index.html are public by design; the database rules protect the data.

## Updating
Edit index.html, then bump CACHE in sw.js (for example interview-reps-v2) so phones pick up the new version.

## What's in the app
- Today: daily minimum (1 ticket + 1 application), application nudges, follow-ups due, calendar reminders.
- Jobs: the vetted shortlist from the database, with status tracking.
- People: import LinkedIn Connections.csv, matched to target companies, with outreach status and message templates. Contacts are saved to the member's private account, never to this repo.
- Practice: 20 technical questions and 6 STAR stories, with a 90-second record-yourself timer.
- Week: applications, replies, interviews and offers for the week, with a copy button.

This repo is public. Never commit personal details (contacts, phone numbers, emails) to it.

## Gmail
Members can connect Gmail (read-only) from the Today tab. Server code is in supabase/functions:
- gmail-connect: starts the Google consent flow
- gmail-callback: stores the connection (tokens never reach the app)
- gmail-sync: finds job emails, sorts them (applied, reply, interview, offer, rejected), matches them to jobs, and updates statuses and the scoreboard. Runs on demand and at 8am and 6pm New York time.

Google credentials live only in Supabase secrets (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET), never in this repo.
