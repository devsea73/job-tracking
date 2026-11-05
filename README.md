# Job Tracker

A desktop app for tracking job applications across several people on the same local network. One computer hosts the data, the others connect to it, and everyone shares everything: one list of jobs, and each other's profiles, statuses, memos and interviews. Each person can only change their own.

Nothing leaves your network except requests to read the job postings you add. There are no cloud databases and no accounts with anyone else.

## Install and run

### From the installer (no Node.js needed)

Run `Job-Tracker-Setup-1.0.0.exe` on each computer. To build it, see [Build the Windows installer](#build-the-windows-installer).

The installer is not code-signed, which has two effects on Windows:

- **SmartScreen** warns about it. Choose **More info**, then **Run anyway**.
- **Smart App Control**, when it is turned on, can refuse to run it at all, with the message "An Application Control policy has blocked this file". There is no exception for a single app. The lasting fix is to sign the build with a code-signing certificate, which electron-builder supports through its `win` signing options. Otherwise, run from source as below, or review Microsoft's current guidance on turning Smart App Control off under **Windows Security > App & browser control**, since turning it off may not be easily reversible.

### From source

You need [Node.js](https://nodejs.org) 22 or newer. Visual Studio is **not** needed: the native modules come precompiled.

```powershell
npm install        # install dependencies
npm run dev        # run in development mode
npm test           # run the automated tests
```

Electron downloads itself the first time it runs.

To try a host and a client on one computer, give each its own profile:

```powershell
# First terminal: choose Host in the window that opens
$env:JOB_TRACKER_USER_DATA = "$env:TEMP\jt-host"; npm run dev

# Second terminal: choose Client, and connect to 127.0.0.1:3847
$env:JOB_TRACKER_USER_DATA = "$env:TEMP\jt-client"; npm run dev
```

## First-time setup

### 1. Start the main LAN host

On the computer that will keep the data, open Job Tracker and choose **Host: this is the main computer**.

### 2. Sign in as admin

Sign in with username `admin` and password `admin`. You must choose a new password before you can do anything else.

### 3. Create regular users

Go to **Users**, then **Add user**. There is no public registration, so people can only sign in with an account you create.

### 4. Connect a second computer

1. On the host, open **Settings** and note the **server address**, for example `192.168.1.100:3847`, and the **security fingerprint**.
2. On the other computer, open Job Tracker and choose **Client: connect to a host**.
3. Enter the server address and choose **Find host**.
4. **Compare the fingerprint shown with the one on the host.** If they match, choose **It matches, connect**.
5. Sign in with the username and password you created.

If the connection fails, see [Network setup](#network-setup).

### 5. Add and track a job

1. Choose **+** (or press Ctrl+N), paste the job's URL, pick the **profile** you applied with, optionally add a memo, then choose **✓**.
2. The host reads the page and fills in the title, company, location and full description.
3. Open the job to change your status, edit your memo, or schedule interviews. Changes save as you make them.

### 6. Set up profiles and photos

Under **Settings**, you can upload your own photo and manage **My profiles**. Everyone starts with one profile, named after them. Each profile has its own name and photo, and you can have as many as you like. A profile with applications can be archived but not deleted, so that its history stays. You always keep at least one active profile.

Each profile can apply to a job once, so one person can apply to the same job under several profiles. Photos can be PNG, JPG or WebP. They are cropped to a square and shrunk before upload. Where there is no photo, the initials are shown. An administrator can remove any photo.

### 7. See how everyone is doing

**All Jobs** shows every job with an avatar per profile that applied, marked with its current stage. Use the arrow on a row, or the expand button at the top, to see each profile's stages and next interview. The filter button opens filters for **Person**, **Profile**, status and dates, and the sort menu includes **Most applied**, to see which jobs the most people went for.

**Team** has a summary table and a chart per person, for all their profiles together or one at a time:

| Rate | Calculation |
| --- | --- |
| Screen pass | Reached Recruiter Screen ÷ all applications |
| Technical pass | Reached Technical Interview ÷ reached Recruiter Screen |
| Interview pass | Reached Final Interview ÷ reached Technical Interview |
| Offer pass | Reached Offer ÷ reached Final Interview |
| Success | Reached Offer ÷ all applications |

"Reached" means the highest stage in the status history. A job that got to Technical Interview and was later rejected still counts as reaching it, and a skipped stage counts as passed. A rate shows **–** when nothing reached the stage before it.

| What happens | When |
| --- | --- |
| A new shared job is created | Nobody has added this job before |
| Your profile is added to the existing job | The link, posting ID or content shows it is a job already in the list |
| You are asked "Is this one of these jobs?" | It looks similar but the evidence is not conclusive |
| You are shown the existing application | That profile already applied to this job. Choose another profile to apply under it too |
| You are asked to type in the details | The page could not be read, for example behind a bot check, or the posting was removed |

### 8. Delete a job

You can delete a job when only your own profiles have applied to it: hover over its row, or open it, and choose the trash icon. This removes the job, its links and those applications. If anyone else has applied, it is not offered and the host refuses it, so nobody loses their data. An administrator can delete any job.

## What the symbols mean

The app uses symbols instead of words. Hover over any of them to see its name.

| Symbol | Meaning |
| --- | --- |
| ✈ | Applied |
| 📞 | Recruiter Screen |
| `</>` | Technical Interview |
| 👥 | Final Interview |
| 🏆 | Offer |
| ✕ | Rejected |

In a process line, stages already passed are green, the current stage is outlined in its color, and stages still to come are grey.

## Network setup

- **All computers must be on the same local network.** The host accepts connections only from private addresses, and refuses public internet addresses even if a router forwards the port by mistake.
- **Allow the port through the host's firewall.** Windows may offer this the first time the host starts. If not, or if clients cannot connect, run this once in an administrator terminal on the host (Settings shows the exact command for your port):

  ```powershell
  netsh advfirewall firewall add rule name="Job Tracker" dir=in action=allow protocol=TCP localport=3847 remoteip=localsubnet
  ```

  If your network is set to **Public** in Windows, change it to **Private** as well.
- **Give the host a fixed address if you can**, with a DHCP reservation on your router. If its IP does change, enter the new address under **Settings > Change server address** on each client. The pairing stays valid because it is tied to the certificate, not the address.
- **Keep the host running while people are working.** Closing its window leaves the server running from the system tray. To stop it, right-click the tray icon and choose **Stop server and quit**.
- **Do not forward the port on your router.** The app is not designed to be reachable from the internet.

When the host is unreachable, clients show a clear error and keep retrying. They never create a separate database of their own.

## Back up the database

1. As admin, open **Settings > Database backups** and choose **Back up now**. This is safe while people are working.
2. On the host, use the download icon to save a copy somewhere else, such as an external drive. A backup on the same disk won't survive that disk failing.

**To restore:** choose **Restore** next to a backup. To restore a file from elsewhere, first choose **Add a backup file** (host only). The current data is saved as a new backup first, so a restore can be undone. People may have to sign in again.

The database lives on the host in `%APPDATA%\Job Tracker\host-data\job-tracker.sqlite`, with backups in `backups\` and logs in `logs\` beside it. **Settings > Open data folder** takes you there. Uninstalling the app leaves this folder in place.

## Build the Windows installer

```powershell
npm run dist       # writes dist\Job-Tracker-Setup-1.0.0.exe
npm run dist:dir   # or an unpacked app in dist\win-unpacked, for testing
```

## What gets read from job sites

| Source | How it is read |
| --- | --- |
| Greenhouse, Lever, Workday, SmartRecruiters, Workable, Rippling, Recruitee, Oracle, BambooHR, ADP, RippleHire, CareerPuck, Dover | The system's public data endpoint |
| Ashby, Built In, Breezy, CareerPlug, Phenom, Teamtailor and most career sites | Structured data in the page (schema.org/JobPosting) |
| Jobright, Comeet, UKG, Hirebridge, LinkedIn guest pages | Site-specific reading of the page |
| Other pages | Page markup and metadata, then a real browser if the page builds itself with JavaScript |

Pages that need a browser use the computer's installed **Microsoft Edge or Google Chrome**, so the host needs one of them. Windows includes Edge.

**Known limitations:**

- **JobDiva** shows a "confirm you're human" check, as can Indeed, Glassdoor and others. The app does not try to get around these. It says what happened and asks you to enter the details.
- **ADP** does not publish the employer's name with its postings. The title and description are read, and you are asked for the company unless the posting opens with "About <company>".
- **Sign-in walls** cannot be read, for the same reason.
- **Closed postings** are reported as closed. You can still track them by typing the details in.
- **Jobright** rewrites descriptions and does not reveal the original link, so it can only be matched to other sites by content. When the overlap is high it merges automatically, otherwise it asks.
- A posting entered by hand can only be matched by what you type, so paste the full description when you can.

Run `npm run survey -- --file C:\path\links.txt` to test extraction against your own list of links, one per line. It writes `survey-report.json`. Keep such lists out of the repository: links copied from a browser can contain personal login tokens.

## How duplicates are detected

Each new link goes through these layers, stopping at the first conclusive one. A wrong merge is treated as worse than asking a question.

| Layer | Checks | Result |
| --- | --- | --- |
| A. URL | The link with tracking parameters, fragments and casing removed, keeping real IDs | Same job |
| B. Canonical | The page's canonical link and where redirects end up | Same job, if the titles are related |
| C. Posting ID | IDs from about 40 job systems (Greenhouse, Lever, Workday and so on), plus an ATS link inside an aggregator's page | Same job |
| D. Content | Company, title, location, requisition numbers and description similarity | Same job only on strong agreement, otherwise it asks |
| E. Aliases | Every link for a job is kept, in `job_urls` | The next person's link matches immediately |

Layer D merges automatically only when the company and title match and either the description is at least 85% the same or a substantial description is at least 85% contained in the other, or when both quote the same requisition number. Different requisition numbers, different IDs on the same system, or different locations all block a merge. In those cases you are asked if the text is nearly identical, and otherwise they stay separate jobs.

These rules are backed by database constraints: one application per profile per job, one job per normalized link, one job per posting ID. So concurrent submissions cannot create duplicates.

## Who can see what

Everything about applications is shared with everyone who can sign in. Only the owner can change it.

| | Everyone | Only you | Administrator only |
| --- | --- | --- | --- |
| Job title, company, description, links | See | | Correct or delete |
| Highlights | See and change | | |
| Statuses, memos, interviews, history, profiles, photos, statistics | See | Change your own | Remove any photo |
| User accounts and backups | | | Manage |

Memos and interview notes are visible to everyone on the host, so keep anything truly private out of them. Passwords and sessions are never shown to anyone.

## Security

Designed for a trusted local network, not for the internet.

- **Passwords** are stored as Argon2id hashes. The initial `admin/admin` must be changed before anything else works.
- **Sign-in** is rate limited per account and per address, with responses that do not reveal whether a username exists.
- **Sessions** are random tokens stored only as hashes on the host, expiring after 7 idle days or 30 days in total, and ending when an account is disabled or its password is reset. On each client the token stays in Electron's main process, encrypted with Windows DPAPI, out of reach of page code.
- **Traffic** uses TLS with a certificate generated on the host. Clients pin its exact fingerprint after you confirm it, so verification is on for every connection and is never turned off globally.
- **Fetching postings** is protected against SSRF: private and local addresses are refused, DNS answers are checked at connection time, every redirect is re-checked, and timeouts and size limits apply. Personal tokens in pasted links are removed before anything is fetched or stored.
- **Job pages** are parsed as text, or rendered in a throwaway profile of a sandboxed system browser. Nothing from them runs in the app.
- **The desktop window** uses context isolation, a sandbox, no Node integration, a strict Content Security Policy, and a narrow preload API.

### Known limits of this threat model

- On first pairing, the protection depends on you actually comparing the fingerprint. A client that accepts an impostor's fingerprint would trust it.
- Anyone who can sign in on the host's Windows account can read the database file, which is not encrypted at rest. Use Windows account security or BitLocker if that matters to you.
- A page rendered in the browser could still make requests between the address check and the connection, a narrow DNS-rebinding window. Plain fetches do not have this gap, since their check happens at connection time.
- Rate limits are held in memory, so restarting the host clears them.

## Project layout

```
src/main       Electron main process: windows, pairing, encrypted session, host process
src/preload    The narrow API exposed to the UI
src/renderer   React UI
src/server     Fastify API, run in its own process on the host
  auth         Passwords, sessions, rate limits
  db           Drizzle schema and database client
  dedupe       URL normalization, posting IDs, content scoring, matching
  extraction   Safe fetching, site adapters, the extraction pipeline
  services     Application logic
src/shared     Types shared between the processes
drizzle        Database migrations
tests          Automated tests, using fixtures and temporary databases
tests/live     Opt-in checks against real job sites
```

To change the database schema, edit `src/server/db/schema.ts` and run `npm run db:generate`. Migrations are applied automatically when the host starts.

## Speed

Measured on one Windows PC with 10,000 jobs, 10 users, 5 profiles each, about 22,000 applications and 13,500 interviews. Run it yourself with the commands under [Testing](#testing).

- **Long lists:** the job list only creates the rows on screen and loads pages as you scroll, so it costs the same at job 10,000 as at job 1.
- **Sorting:** the number of applications and latest activity are kept on each job by database triggers and indexed, so sorting by them does not count anything.
- **Search:** memos and job text use SQLite full-text indexes with prefix support. Search matches the beginning of words in memos and descriptions, and any part of a company or job title.
- **Repeat requests:** finished responses are reused until something changes. Any write clears them, and none lives longer than 15 seconds, so nobody sees old data.
- **Live updates:** a burst of changes refreshes once, and only what is on screen.

## Testing

```powershell
npm test                                 # the full suite: no internet needed
npm run typecheck
npm run loadtest                         # server speed with 10,000 jobs, no internet needed
npm run build; npm run loadtest:ui       # desktop app speed with 10,000 jobs, no internet needed
npm run survey -- --file links.txt       # live: extraction over your own links
npm run survey -- --cross-platform       # live: one real job through several sites
npm run build; npm run e2e               # live: drives the real app, one host and two clients
```

To run the end-to-end script against a packaged or installed copy, set `E2E_EXECUTABLE` to the path of `Job Tracker.exe` first.

To explore the 10,000-job data yourself, keep the data from a speed test and open it in development mode:

```powershell
npm run build; npm run loadtest:ui -- --keep "$env:TEMP\jt-load"
$env:JOB_TRACKER_USER_DATA = "$env:TEMP\jt-load"; npm run dev
```

Sign in as `load-user-01` to `load-user-10` with the password `load-password`, or as `admin` with `load-admin-password`. All of the jobs are made up.
