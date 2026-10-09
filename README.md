# CapTrack

Attendance tracking for local Capgemini events. Organisers create an event, share a link or QR code, and people check in with their work email. Returning visitors are checked in automatically.

## Run it

Requires Node.js 18 or later.

```bash
npm install
npm start
```

- Check-in page: http://localhost:3000/
- Admin portal: http://localhost:3000/admin. On the first visit you set the admin password.

Environment variables:

| Variable   | Default  | Purpose                              |
|------------|----------|--------------------------------------|
| `PORT`     | `3000`   | Port to listen on                    |
| `DATA_DIR` | `./data` | Where `db.json` (all data) is stored when `DATABASE_URL` isn't set |
| `DATABASE_URL` | none | Postgres connection string. When set, data is stored there instead of a file |
| `ADMIN_PASSWORD` | none | Sets the first admin password and skips the setup screen. Ignored once a password exists |
| `TRUST_PROXY` | off (on for Render) | Read visitor addresses from `X-Forwarded-For` when running behind a proxy |

Locally, back up `data/db.json` to keep your events and attendance.

## Host it free on Render

Render's free plan wipes local files whenever the app restarts, so the data goes into a free Postgres database instead.

1. **Create the database.** Sign up at [neon.tech](https://neon.tech) (free), create a project, and copy its connection string (`postgresql://...?sslmode=require`). CapTrack creates its table on first start. Supabase or any other Postgres works too.
2. **Put the code on GitHub.** Create an empty repository, then from this folder:
   ```bash
   git init && git add . && git commit -m "CapTrack"
   git branch -M main
   git remote add origin https://github.com/<you>/captrack.git
   git push -u origin main
   ```
3. **Deploy.** In the [Render dashboard](https://dashboard.render.com) choose **New > Blueprint**, connect the repository, and fill in the two values it asks for:
   - `DATABASE_URL`: the Neon connection string
   - `ADMIN_PASSWORD`: a strong password for the admin portal
4. Once the deploy finishes, your app is at `https://captrack-xxxx.onrender.com` (check-in page) and `/admin` (portal).

On the free plan the app sleeps after 15 minutes without visitors, and the first visit after that takes up to a minute to wake it. Open the check-in page yourself a few minutes before an event starts.

## How it works

**Organisers (admin portal)**
- Create events with a title, optional description and location, and the time window when check-in is open.
- Check-in opens and closes on that schedule. You can also open it early, pause it, go back to the schedule, end the event, or reopen it.
- Each event has its own link (`/e/<id>`) and a full-screen QR code for projecting at the venue.
- Watch check-ins arrive live, add someone by hand, or remove an entry.
- Copy all attendee emails as a comma-separated list, or download a CSV. Once an event ends, the final list is shown at the top of its page.
- Settings: manage the allowed email domains (`capgemini.com` by default, add `sogeti.com` etc.) and change the admin password.

**Attendees (check-in page)**
- With one event open, they go straight to the email step. With several open, they pick the event first.
- The email must use an allowed domain. It's remembered on the device (a long-lived cookie), so next time opening the page checks them in automatically.
- After checking in they can edit their email (fixes a typo across every past check-in) or switch to a different email on a shared device.

## Tests

```bash
npm test
```
