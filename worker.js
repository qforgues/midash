/**
 * miDash chat backend — Cloudflare Worker (tool-using agent)
 * --------------------------------------------------
 * Holds your Anthropic API key as a secret and runs the chat agent for the
 * dashboard. The model can call tools (search/reply/trash/etc.); the TOOLS are
 * defined here, but they are actually *executed in your browser* using your own
 * Google login — so this Worker never sees or needs your Google credentials,
 * and your API key never reaches the browser.
 *
 * Deploy:
 *   1. npm i -g wrangler && wrangler login
 *   2. cd ~/miDash && wrangler deploy worker.js --name midash-chat
 *   3. wrangler secret put ANTHROPIC_API_KEY        (paste your key)
 *   4. Put the printed https://midash-chat.<you>.workers.dev URL into
 *      CONFIG.chatEndpoint in index.html, then push.
 */

const ALLOWED_ORIGIN = "https://qforgues.github.io"; // only your site may call this

// 42payments — Q's business finance app (FreshBooks-backed invoicing/expenses/income).
// The browser's finance_* tools call this Worker's /finance proxy, which attaches the
// X-API-Key secret server-side and forwards here. The key NEVER reaches the browser.
//   wrangler secret put PAYMENTS_API_KEY
const PAYMENTS_BASE = "https://42payments.myeasyapp.com/api/ext";

// Models the dashboard may pick from (the picker sends one of these strings).
// Haiku is the default — it's ~5x cheaper than Sonnet for the same chat.
// NOTE: this is the metered Anthropic API (billed per token, separate from any
// Max subscription). Haiku keeps the per-message cost in the fractions-of-a-cent range.
const ALLOWED_MODELS = new Set([
  "claude-haiku-4-5",   // cheapest  ($1 / $5 per Mtok)
  "claude-sonnet-4-6",  // balanced  ($3 / $15)
  "claude-opus-4-8",    // smartest  ($5 / $25)
  "claude-fable-5",     // Fable 5   (newest flagship)
]);
const DEFAULT_MODEL = "claude-haiku-4-5";
// Adaptive thinking + the effort parameter are supported on Sonnet 4.6 / Opus 4.8 / Fable 5
// but NOT on Haiku 4.5 (sending them to Haiku 400s). So we only enable them on the smart models.
const SMART_MODELS = new Set(["claude-sonnet-4-6", "claude-opus-4-8", "claude-fable-5"]);

const SYSTEM = `You are the assistant embedded in Q's personal dashboard (miDash).
You can read Q's Google Calendar (across ALL of his connected Google accounts and ALL
calendars), create calendar events, delete events, read/reply/trash/archive/mark-read his
Gmail, send new emails, read/create/complete his Google Tasks, read and clean up his Google
Contacts, and read his Notes scratchpad — via the provided tools. Tools run in Q's browser
using his own Google logins. Be concise and friendly.

Q's flow is idea → reality: ideas live in his Notes (read_notes), and Tasks are the
actionable layer. When he says things like "turn my notes into tasks", "make these ideas
real", or "what should I do next", read_notes first, then create a task per actionable item
with create_task. To mark something done, list_tasks to find its listId/taskId, then
complete_task. To RESCHEDULE a task (change its due date) or rename it — e.g. "move the
reimbursement to next Tuesday", "push Rachel's call to Monday" — list_tasks to find it, then
update_task with the new 'due' (a phrase like "next tue"/"monday" is fine). You CAN change task
due dates; don't tell Q to do it manually.

Reminders vs tasks: a Google Task (create_task) is a TO-DO on his list; a reminder (set_reminder)
is a timed NOTIFICATION that DMs him on Discord once, at a moment. Use set_reminder for anything
time-sensitive he should be pinged for — "remind me at 3pm", "ping me in 20 minutes", or nudging
him around a scheduled thing (for "10 minutes before my 2pm", set it for 1:50pm; for wrap-up, set a
second one 10 min before it ends). Pass 'at' as the exact time (ISO like 2026-07-11T13:50:00, a
phrase like "friday 3pm"/"in 20 minutes", or epoch-ms) and 'text' as the nudge written TO Q. A
thing that's both a to-do AND wants a nudge → do both (create_task + set_reminder). list_reminders
and cancel_reminder manage pending ones. These act immediately — no confirm.
BUT: a pure NOTIFICATION is a reminder and NOTHING ELSE. "Let me know if Bill replies", "ping me
when the build finishes", "tell me at 4 if the invoice cleared" — there is no action for Q to
perform, so set_reminder alone. Creating a task for it leaves a chore on his list he can never
actually DO and has to tick off by hand. Ask yourself: is there a verb HE carries out? Yes → task
(plus a reminder if it's time-sensitive). No, he just needs to be told something → reminder only.
CONDITIONALS are the third shape, and Q uses them constantly: "call Bob by 10a if he hasn't emailed
me by then", "pay the invoice unless Adam already sent it". The action is NOT committed yet — it
depends on something being true at that moment. When the condition is about someone emailing him,
use set_watch: it pings him at the decision point AND creates the task automatically, but only if
they stayed silent. Do NOT also call create_task — that defeats the whole point. For a condition
set_watch can't express, set_reminder alone with the condition written into the nudge ("10a — has
Bob emailed? if not, call him"), and create the task later once you know. Use check_email_from to
settle "has X got back to me?" from real data instead of guessing.
Never echo Q's instruction wrapper into what you create. He talks to you in normal language — "set
a reminder to call Bob", "can you add a task to ship the pre-rolls", "note to self: order boxes" —
and the task/reminder should read as the bare action ("Call Bob Jones", "Ship the pre-rolls"), never
"Set a reminder to call Bob Jones". Strip the asking, keep the doing.
Carry the CONTEXT into whatever you create. The reminder 'text' and the task 'notes' are read later
with none of today's conversation in his head, so "Call Bill Lennox" is not enough — "Call Bill
Lennox — he never replied to your email about Tuesday's meeting" is. Never drop the why.
Q writes times as "10a" / "3p" / "9:30a" — that's 10am, 3pm, 9:30am.

How Q's day list actually works — three states, not one. A task is either HIS to do, WAITING on
someone else, or BLOCKED behind another task. Google Tasks only knows the first, so miDash owns the
other two (set_waiting / clear_waiting / block_task / list_waiting):
- He's done all he can and it's in someone else's court ("waiting on Plaid to approve production",
  "sent the email, no reply yet") → set_waiting. It leaves his active list so it stops nagging him,
  and he stops re-reading a line he can't act on. This is the single most useful thing you can do
  with his list — when he says he "did everything I could" on something, that's the cue.
- One thing can't start until another finishes ("pay the credit cards" after "link CCs via Plaid",
  "update tracker42" after "meet with Rebecca") → block_task. The blocked one hides under "Next up"
  and surfaces on its own when the blocker is completed. When he describes work in sequence, wire it
  up rather than leaving him two loose tasks.
- Waiting on a PERSON needs a chase, or it just rots. Pass chase_at to set_waiting whenever the
  waiting is on a human — and when an email has gone unanswered, the chase should escalate to a
  different channel (call them, don't send a second email). Q's day starts at 10am: never schedule a
  chase or a morning nudge before that.
- For "what am I waiting on", "what's stuck", "what should I do today", "anything to chase" → call
  list_waiting. Days-waiting is the signal to push on.
All four act immediately, no confirmation.

WHERE, not just when. Some of Q's tasks are organised by place: the jacket and the tapes are one
local run, the pre-rolls are a USPS stop. Use set_place so a trip gets planned once instead of five
errands done one at a time, and list_places when he asks what he needs to do while he's out.
The important case is when_there:true — something with NO date that only becomes real when he's
somewhere ("meet Evan next time I'm in Michigan"). Those leave his day list entirely and resurface
when the calendar says he's headed there. A dateless place-bound task on a day list either nags him
daily or gets forgotten; that flag is the third option, so reach for it whenever he says "next time
I'm in…", "whenever I'm out that way", or "while I'm there".

Closing out the day: Q runs an end-of-day rollover (⚙️ → "Close out the day") where anything that
didn't happen gets pushed to a real date and time rather than silently re-listed. list_waiting also
returns SLIPPING — tasks he has moved 3+ times. Those are the honest ones to raise: something moved
four days running is too big, or not actually wanted. Don't just reschedule it again for him —
suggest the first 10-minute step, a specific time, or dropping it. When he asks you to move
something to another day, that's update_task with a new due.

Projects (the bigger picture): Q tracks projects on a board, in two types. SOFTWARE
(website/app) runs idea → validate → plan → build → test → ship → grow. PROPERTY (physical
builds & renovations on his two properties) runs idea → scope → design → source → build →
finish → done. Use list_projects to see them (each returns type, stage, progressPct, its
"next" action, and lastTouchedDays — high = neglected). His north star is "keep every project
moving, leave none behind", so for "what should I work on / what's stalling / how are my
projects or properties" call list_projects and steer him to the most neglected ones and their
next action. Use update_project to advance a stage or set the next action (e.g. "move La Palma
to ship", "move the kitchen reno to build") — always use that project type's stage words. Use
add_project (with type: "property" for a build/reno) to start tracking something new. These act
immediately (no confirm).

Contacts (cleanup): you CAN read and delete Q's saved Google Contacts. For "delete my junk
contacts", "clean up my contacts", "remove duplicates", etc.: call list_contacts, then use your
own judgment to pick the obvious junk — entries with no real name, machine senders
(noreply@/notifications@/no-reply/mailer/newsletter/marketing), one-off transactional addresses,
and duplicates. Show Q the shortlist in text first ("I found N that look like junk: … — delete
these?"), and only when he agrees call delete_contacts ONCE with the whole list. It pops a single
confirm dialog, so don't ask again in text. Never claim you can't touch contacts — you can. Only
saved contacts are deletable (auto-collected "other" contacts aren't); if a delete is denied with
needsReconnect, the write scope was just added and Q needs to reconnect Google once.

Portal42 / Tracker42 (Q's ticketing system): list_tracker_notifications shows his Tracker42
notifications newest-first (ticket status changes, comments, approvals, QA pass/fail, releases),
with meta.unread_count as the unread badge. Use it for "any new Portal42 tickets?", "what's new
on the tracker", or "did anything change on TKT-…". get_ticket fetches one ticket's status by id,
but the ticket endpoints are still rolling out — if it returns an "Unknown action" error, that
means tickets aren't live yet (not a failure); say so and fall back to the notification feed.

Multiple accounts:
- Q may connect more than one Google account (e.g. a personal gmail and a work address).
  Tools that read (search_emails, list_events) automatically cover EVERY connected
  account and each result is tagged with its "account". Never claim you can't see an
  account — if it's connected on the dashboard, your tools already include it. If a
  requested account truly isn't connected, say so and suggest clicking "＋ account".
- For actions on a specific message/event, pass the "account" from the item you're
  acting on so it targets the right inbox/calendar.

Guidelines:
- When the user refers to "the latest email from X" or similar, first call
  search_emails to find the message id (and its account), then act on it.
- To remove calendar events: call list_events, then delete_event with the event's
  account, calendarId, and eventId. Events on read-only calendars (like Birthdays)
  can't be deleted — tell Q if that happens. Only delete events where canEdit is true.
- reply_email, trash_email, delete_event, create_event and send_email pop a confirmation
  dialog on Q's screen, so just call the tool when asked — do NOT ask for permission again
  in text. If a tool returns cancelled:true, respect it and don't retry.
- To add something to the calendar, call create_event with an ISO start (and end if known).
  To email someone new, call send_email; for a reply to an existing thread, use reply_email.
- read_notes returns Q's free-form scratchpad; use it as context when he references
  "my notes", "my ideas", or asks you to draft from what he jotted down.
- After acting, briefly confirm what you did. Draft replies in Q's voice: warm, brief, direct.

Business finances (42payments):
- You can see and act on Q's business money via the finance_* tools (FreshBooks-backed):
  finance_summary (start here for "how's the business doing?"), finance_list
  (invoices/expenses/clients/payments), finance_profit_loss, and the writes
  finance_create_invoice, finance_log_expense, finance_add_client, finance_mark_invoice_paid.
- Money comes back as { amount, code } (e.g. {"amount":"500.00","code":"USD"}).
- The write tools pop an on-screen confirm, so just call them when asked — don't ask again in
  text; if a tool returns cancelled:true, respect it and don't retry.
- If a finance tool returns not_ready:true, the app is running but FreshBooks isn't connected
  yet — tell Q to sign in once at 42payments. If it returns offline:true, the app isn't
  reachable right now — say finances are temporarily unavailable and to retry later. Neither
  is your fault; don't treat them as errors.`;

// Project board tool schemas — SINGLE SOURCE shared by both TOOLS (chat) and AGENT_TOOLS
// (Discord). Defining them once stops the two tool sets from drifting in description/enum.
const PROJECT_TOOLS = [
  { name: "list_projects",
    description: "List Q's tracked projects, most-neglected-first. Two types: SOFTWARE (idea|validate|plan|build|test|ship|grow) and PROPERTY (physical builds/renos on his two properties, House & Cabin: idea|scope|design|source|build|finish|done). Each item has name, type, stage, progressPct, next (may be null), lastTouchedDays (high = neglected), stale, url, repo; property items also have property/area/people. Use for 'what should I work on / what's stalling / how are my projects or properties'.",
    input_schema: { type: "object", properties: {}, required: [] } },
  { name: "add_project",
    description: "Add a NEW project. Needs name. type is 'software' (default) or 'property' (a physical build/reno on the House or the Cabin). Optional stage (default idea; use that type's vocabulary — software: idea|validate|plan|build|test|ship|grow; property: idea|scope|design|source|build|finish|done), next (next action), url (live site or listing/map link), repo (owner/repo — software only). For property jobs also set property (house|cabin), area (inside|outside|plumbing|electric|handyman|cleaning|other), people (names like 'Nehemias'). Acts immediately — no confirmation.",
    input_schema: { type: "object", properties: { name: { type: "string" }, type: { type: "string", enum: ["software","property"] }, stage: { type: "string", enum: ["idea","validate","plan","build","test","ship","grow","scope","design","source","finish","done"] }, next: { type: "string" }, url: { type: "string" }, repo: { type: "string" }, property: { type: "string", enum: ["house","cabin"] }, area: { type: "string", enum: ["inside","outside","plumbing","electric","handyman","cleaning","other"] }, people: { type: "string" } }, required: ["name"] } },
  { name: "update_project",
    description: "Update one of Q's tracked projects, matched by name (case-insensitive, partial ok). Set any of: stage, next (the single next action), notes. For PROPERTY projects also: property (house|cabin), area (inside|outside|plumbing|electric|handyman|cleaning|other), people (free-text names). Use the stage vocabulary for THAT project's type — software: idea|validate|plan|build|test|ship|grow; property: idea|scope|design|source|build|finish|done. Touches last-updated so it stops looking neglected. Acts immediately — no confirmation.",
    input_schema: { type: "object", properties: { name: { type: "string" }, stage: { type: "string", enum: ["idea","validate","plan","build","test","ship","grow","scope","design","source","finish","done"] }, next: { type: "string" }, notes: { type: "string" }, property: { type: "string", enum: ["house","cabin"] }, area: { type: "string", enum: ["inside","outside","plumbing","electric","handyman","cleaning","other"] }, people: { type: "string" } }, required: ["name"] } },
];

// Reminder tool schemas — SINGLE SOURCE shared by both TOOLS (chat) and AGENT_TOOLS (Discord),
// like PROJECT_TOOLS. A reminder is a NOTIFICATION (a Discord DM fired once at a set time),
// distinct from a Google Task (a to-do). The Worker's cron delivers them; see fireDueReminders.
const REMINDER_TOOLS = [
  { name: "set_reminder",
    description: "Schedule a push reminder that DMs Q on Discord at a specific time — for time-sensitive nudges (a task starting, wrapping up, 'remind me at 3pm', 'in 20 minutes'). To nudge '10 minutes before his 2pm meeting', set it for 1:50pm. Give 'text' (the nudge, written TO Q, e.g. 'Heads up — your 2pm meeting starts in 10 min') and 'at' (when to fire): an ISO-8601 local datetime like 2026-07-11T13:50:00, a natural phrase ('friday 3pm', 'tomorrow 9am', 'in 20 minutes'), or epoch-ms. Resolved to Q's local time on the dashboard. Fires ONCE. This is a NOTIFICATION, not a to-do — use create_task for to-dos. Acts immediately — no confirmation.",
    input_schema: { type: "object", properties: { text: { type: "string" }, at: { type: "string", description: "when to fire — ISO-8601 local datetime, a natural phrase, or epoch-ms" } }, required: ["text", "at"] } },
  { name: "list_reminders",
    description: "List Q's pending (not-yet-fired) push reminders, soonest first. Each has id, text, and at (ISO-8601). Use before cancelling.",
    input_schema: { type: "object", properties: {}, required: [] } },
  { name: "cancel_reminder",
    description: "Cancel a pending reminder by its id (from list_reminders). Acts immediately.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
];

// Flow tool schemas — SINGLE SOURCE shared by TOOLS (chat) and AGENT_TOOLS (Discord), like
// PROJECT_TOOLS/REMINDER_TOOLS. The "flow" layer is what Google Tasks can't hold: whether a task
// is parked on SOMEONE ELSE (waiting) or parked behind ANOTHER TASK (blocked). See handleFlow.
const FLOW_TOOLS = [
  { name: "set_waiting",
    description: "Park one of Q's tasks as WAITING ON someone or something else — he's done all he can and the ball is in their court (e.g. 'waiting on Plaid to approve production', 'waiting on Bill to reply to my email'). It leaves his active day list for a 'Waiting on' strip, so it stops nagging him without being forgotten. Match the task by title (case-insensitive, partial ok). 'on' = who/what he's waiting for. Optionally pass 'chase_at' to also schedule a Discord ping to chase it, and 'chase' as that nudge's text — Q's day starts at 10am, so never schedule a chase earlier than that. Acts immediately, no confirmation.",
    input_schema: { type: "object", properties: { task: { type: "string" }, on: { type: "string" }, chase_at: { type: "string", description: "optional — when to ping Q to chase it ('tomorrow 10am', ISO datetime, 'in 2 days')" }, chase: { type: "string", description: "optional — the chase nudge written TO Q" } }, required: ["task", "on"] } },
  { name: "clear_waiting",
    description: "The thing Q was waiting on came through — put the task back on his active list. Match by title (partial ok). Also reports any tasks that were BLOCKED behind it and are now free to start, so you can tell him what just opened up. Acts immediately.",
    input_schema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] } },
  { name: "block_task",
    description: "Record that one task can't start until another one is finished — 'pay the credit cards' AFTER 'link CCs via Plaid', 'update tracker42' AFTER 'meet with Rebecca'. The blocked task moves to a 'Next up' section that shows what it's waiting for, and surfaces on its own the moment the blocker is completed. Match both by title (partial ok). Acts immediately.",
    input_schema: { type: "object", properties: { task: { type: "string", description: "the task that has to wait" }, after: { type: "string", description: "the task it's waiting for" } }, required: ["task", "after"] } },
  { name: "check_email_from",
    description: "Check whether a person has emailed Q recently — the factual answer to 'did Bob get back to me?'. Give 'who' as a name or email address (a name is matched against his Google Contacts) and optionally 'since' (a time phrase like 'yesterday 6pm', an ISO datetime, or epoch-ms; defaults to the last 24h). Returns found:true/false plus the newest matching message's subject, sender and time. Searches every connected account. Use this BEFORE telling him to chase someone, and to settle any 'if <person> hasn't emailed' condition.",
    input_schema: { type: "object", properties: { who: { type: "string" }, since: { type: "string" } }, required: ["who"] } },
  { name: "list_waiting",
    description: "List what Q is WAITING ON (parked in someone else's court, each with how many days it's been sitting), what's BLOCKED behind another task, and what's SLIPPING (tasks he has pushed to another day 3+ times in his end-of-day rollover). Use for 'what am I waiting on', \"what's stuck\", 'what keeps slipping', 'anything I should chase', or before planning his day. Reads miDash's own storage, so it works over Discord with no Google access.",
    input_schema: { type: "object", properties: {}, required: [] } },
];
/* Place tool schemas — SINGLE SOURCE for TOOLS + AGENT_TOOLS. Some of Q's tasks are organised by
   WHERE, not when: the jacket and the tapes are one local run; the pre-rolls are a USPS stop.
   And some have no date at all and only become real when he's somewhere — "meet Evan next time I'm
   in Michigan". A dateless place-bound task on a day list either nags forever or gets forgotten;
   `when_there` is the third option. See taskBuckets / renderPlaces in index.html. */
const PLACE_TOOLS = [
  { name: "set_place",
    description: "Tag a task with WHERE it happens, so trips get planned as one thing instead of one-at-a-time. Match the task by title (partial ok). 'place' is a short label Q would recognise — 'errands' for a general local run, or something specific like 'USPS', 'the shop', 'Michigan'. Set when_there:true for something with NO date that only becomes real when he's actually there ('meet Evan next time I'm in Michigan') — those leave the day list entirely and surface when he's headed there, instead of nagging him daily. Leave when_there false/absent for a normal errand he'll do from home. Acts immediately.",
    input_schema: { type: "object", properties: { task: { type: "string" }, place: { type: "string" }, when_there: { type: "boolean" } }, required: ["task", "place"] } },
  { name: "list_places",
    description: "List Q's location-tagged tasks: ERRANDS grouped by place (so you can suggest one trip that covers several), and WHEN-THERE tasks that are parked until he's in that place. Use for 'what errands do I have', 'what do I need to do while I'm out', 'anything for when I'm in Michigan', or when planning a trip or a day.",
    input_schema: { type: "object", properties: {}, required: [] } },
  { name: "clear_place",
    description: "Remove a task's place tag (it's no longer location-bound, or it's done being parked). Match by title. Acts immediately.",
    input_schema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] } },
];

/* Watch tool schemas — SINGLE SOURCE for TOOLS + AGENT_TOOLS. A WATCH is the third shape after
   task and reminder: a decision deferred to a moment. "Call Bob by 10a if he hasn't emailed" is not
   a to-do (the call may never need making) and not just a ping (something has to be CHECKED and
   acted on). The watch fires at `at`, the browser evaluates the condition against Gmail, and only
   then does the task exist. See handleWatch + runDueWatches. */
const WATCH_TOOLS = [
  { name: "set_watch",
    description: "Schedule a CONDITIONAL: at a given moment, check something, and create a task only if it didn't resolve itself. Right for 'call Bob by 10a if he doesn't email me before then', 'pay invoice 1042 Friday unless it clears first', 'if TKT-88 still isn't released by Thursday, chase it'. Always give 'at' (when to decide — 'tomorrow 10am', ISO, or epoch-ms; Q's day starts at 10am so never earlier) and 'then_task' (the task to create IF it didn't resolve, as a bare action like 'Call Bob Jones'), plus optional 'then_notes' (why, phone number, what was already tried). Then pick the CHECK: kind 'email_from' (default) with 'who' = the person — settled from Gmail when his dashboard is open; kind 'invoice_paid' with 'ref' = invoice number or client — settled by the Worker on time, no browser needed; kind 'ticket_status' with 'ref' = the Portal42 ticket id and optional 'target' = the status that would count as done — also settled on time. Do NOT also call create_task: the point is that the task only exists if the condition holds. A Discord ping fires at the moment either way. Acts immediately.",
    input_schema: { type: "object", properties: { at: { type: "string" }, kind: { type: "string", enum: ["email_from","invoice_paid","ticket_status"] }, who: { type: "string", description: "email_from: the person" }, ref: { type: "string", description: "invoice_paid: invoice number or client · ticket_status: ticket id" }, target: { type: "string", description: "ticket_status: the status that counts as resolved" }, then_task: { type: "string" }, then_notes: { type: "string" }, since: { type: "string", description: "email_from: only count mail after this (defaults to now)" } }, required: ["at", "then_task"] } },
  { name: "list_watches",
    description: "List Q's pending conditionals — what is going to be checked, when, and what happens if the condition holds. Use for 'what are you watching for me', or before setting a duplicate.",
    input_schema: { type: "object", properties: {}, required: [] } },
  { name: "cancel_watch",
    description: "Cancel a pending conditional by its id (from list_watches). Acts immediately.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
];
const TOOLS = [
  { name: "search_emails",
    description: "Search Gmail across ALL connected accounts. Returns messages with id, account, from, subject, date, snippet. Use Gmail search syntax in 'query' (e.g. 'in:inbox is:unread', 'from:sam newer_than:7d', 'category:promotions').",
    input_schema: { type: "object", properties: { query: { type: "string" }, max: { type: "integer", description: "max results per account, default 5" } }, required: ["query"] } },
  { name: "get_email",
    description: "Get the full body and headers of one email by id. Pass 'account' if known.",
    input_schema: { type: "object", properties: { id: { type: "string" }, account: { type: "string", description: "the account email the message belongs to" } }, required: ["id"] } },
  { name: "reply_email",
    description: "Reply to an email by id, in the same thread. Q confirms on screen before it sends. Pass 'account' from the message.",
    input_schema: { type: "object", properties: { id: { type: "string" }, body: { type: "string" }, account: { type: "string" } }, required: ["id", "body"] } },
  { name: "trash_email",
    description: "Move an email to Trash by id. Q confirms on screen. Pass 'account' from the message.",
    input_schema: { type: "object", properties: { id: { type: "string" }, account: { type: "string" } }, required: ["id"] } },
  { name: "archive_email",
    description: "Archive an email (remove it from the inbox) by id. Pass 'account' from the message.",
    input_schema: { type: "object", properties: { id: { type: "string" }, account: { type: "string" } }, required: ["id"] } },
  { name: "mark_read",
    description: "Mark an email as read by id. Pass 'account' from the message.",
    input_schema: { type: "object", properties: { id: { type: "string" }, account: { type: "string" } }, required: ["id"] } },
  { name: "list_events",
    description: "List calendar events for the next N days (default 7) across ALL connected accounts and calendars. Each event includes account, calendarId, eventId, summary, start, end, allDay, location, and canEdit. Use a larger N (e.g. 365) to find sparse events like birthdays.",
    input_schema: { type: "object", properties: { days: { type: "integer" } }, required: [] } },
  { name: "delete_event",
    description: "Delete a calendar event. Requires account, calendarId, and eventId (all from list_events). Q confirms on screen. Read-only calendars (e.g. Birthdays) will fail.",
    input_schema: { type: "object", properties: { account: { type: "string" }, calendarId: { type: "string" }, eventId: { type: "string" }, summary: { type: "string", description: "for the confirm dialog" } }, required: ["account", "calendarId", "eventId"] } },
  { name: "read_notes",
    description: "Read Q's free-form Notes scratchpad from the dashboard. Use when he references his notes/ideas or asks you to draft from them.",
    input_schema: { type: "object", properties: {}, required: [] } },
  { name: "create_event",
    description: "Create a NEW calendar event. Q confirms on screen before it's created. Give 'start' (and ideally 'end') as ISO 8601 local time, e.g. 2026-07-02T15:00:00. For an all-day event, pass a date-only 'start' (YYYY-MM-DD) and allDay:true. Defaults to Q's primary calendar on his primary account unless 'account' is set. When the event is work on a tracked PROPERTY project, pass projectId (the project's name is fine) so it's tagged and shows on that project's card.",
    input_schema: { type: "object", properties: { summary: { type: "string" }, start: { type: "string" }, end: { type: "string" }, allDay: { type: "boolean" }, location: { type: "string" }, description: { type: "string" }, account: { type: "string" }, projectId: { type: "string" } }, required: ["summary", "start"] } },
  { name: "send_email",
    description: "Send a NEW email (not a reply — use reply_email for replies). Q confirms on screen before it sends. Sends from his primary account unless 'account' is set.",
    input_schema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, cc: { type: "string" }, account: { type: "string" } }, required: ["to", "subject", "body"] } },
  { name: "list_tasks",
    description: "List Q's open Google Tasks across ALL connected accounts. Each item has title, account, listId, taskId, due. Use listId+taskId to complete a task.",
    input_schema: { type: "object", properties: {}, required: [] } },
  { name: "create_task",
    description: "Add a NEW Google Task (a to-do). This is how you turn an idea or a note into an actionable task. Keep 'title' the short ACTION ('Call Bill Lennox') and put the context in 'notes' ('never replied to my email about Tuesday; his number is in Contacts') — Q reads the task later with none of today's context in his head, so the why belongs on the task. Optional 'due' accepts either an exact YYYY-MM-DD OR a natural phrase like 'tomorrow', 'next tue', 'friday', 'july 10', 'in 3 days', even 'friday 3pm' — the dashboard resolves it to Q's LOCAL date, so just pass whatever day/time he said. ALWAYS set 'due' whenever the reminder or note implies a day or deadline. Goes to Q's default task list on his primary account unless 'account' is set. Acts immediately — no confirmation needed.",
    input_schema: { type: "object", properties: { title: { type: "string" }, notes: { type: "string", description: "context/details for the task body — the why, links, phone numbers, what was already tried" }, due: { type: "string" }, account: { type: "string" } }, required: ["title"] } },
  { name: "complete_task",
    description: "Mark a Google Task done. Needs account, listId and taskId (from list_tasks). Acts immediately — no confirmation needed.",
    input_schema: { type: "object", properties: { account: { type: "string" }, listId: { type: "string" }, taskId: { type: "string" }, title: { type: "string", description: "for context" } }, required: ["listId", "taskId"] } },
  { name: "update_task",
    description: "Reschedule or edit an EXISTING Google Task — this is how you change a task's DUE DATE (e.g. 'move the reimbursement to next Tuesday', 'push Rachel's call to Monday'), rename it, or edit its notes. Call list_tasks first to find the task by title, then pass its account, listId and taskId. 'due' accepts an exact YYYY-MM-DD or a natural phrase ('next tue', 'monday', 'friday', 'july 16', 'in 3 days') resolved to Q's LOCAL date, or 'none' to clear the due date. Google Tasks store the DATE only (any time-of-day is ignored). Acts immediately — no confirmation needed.",
    input_schema: { type: "object", properties: { account: { type: "string" }, listId: { type: "string" }, taskId: { type: "string" }, due: { type: "string", description: "new due — YYYY-MM-DD, a natural phrase, or 'none' to clear" }, title: { type: "string" }, notes: { type: "string" } }, required: ["listId", "taskId"] } },

  // ---- Google Contacts (People API, runs in Q's browser with his token) ----
  { name: "list_contacts",
    description: "List Q's saved Google Contacts across ALL connected accounts. Each item has name, email, account, and resourceName. Only saved 'My Contacts' are returned (they're the ones that can be deleted). Call this before delete_contacts, then use YOUR judgment to pick out the obvious junk (no real name, noreply@/notifications@/marketing senders, one-off addresses, duplicates) and confirm the list with Q in text before deleting.",
    input_schema: { type: "object", properties: {}, required: [] } },
  { name: "delete_contacts",
    description: "Permanently delete one or more saved Google Contacts. Pass a 'contacts' array of items from list_contacts (each with resourceName + account). Pops ONE on-screen confirmation listing all the names, then removes them from Google Contacts — so just call it once with the full junk list; do NOT ask for permission again in text and do NOT call it once per contact. If a tool returns cancelled:true, respect it and don't retry. If it reports needsReconnect, tell Q to reconnect Google (the write scope was just added) and try again.",
    input_schema: { type: "object", properties: { contacts: { type: "array", description: "contacts to delete (from list_contacts)", items: { type: "object", properties: { resourceName: { type: "string", description: "the contact's resourceName, e.g. people/c123" }, account: { type: "string" }, name: { type: "string", description: "for the confirm dialog" }, email: { type: "string" } }, required: ["resourceName"] } } }, required: ["contacts"] } },

  // ---- Projects board (Q's idea→shipped tracker, miDash-owned) — shared schemas ----
  ...PROJECT_TOOLS,

  // ---- Reminders (miDash-owned push notifications via Discord DM) — shared schemas ----
  ...REMINDER_TOOLS,

  // ---- Flow: waiting-on / blocked-by, the dimensions Google Tasks can't hold — shared schemas ----
  ...FLOW_TOOLS,

  // ---- Places: errands grouped by where, and "only when I'm there" — shared schemas ----
  ...PLACE_TOOLS,

  // ---- Watches: conditionals ("…if he hasn't emailed by then") — shared schemas ----
  ...WATCH_TOOLS,

  // ---- Portal42 / Tracker42 (Q's ticketing system, read-only) ----
  { name: "list_tracker_notifications",
    description: "List Q's Portal42 (Tracker42) notifications, newest-first. Each has id, type (comment|status_change|assignment|approval|rejection|release|qa_pass|qa_fail), title, message, is_read, created_at (ISO-8601 UTC), and ticket_id/ticket_number/ticket_title when it's about a ticket. The result's meta.unread_count is the unread badge. Use for 'any new Portal42 tickets/notifications?' or 'what's new on the tracker'.",
    input_schema: { type: "object", properties: { since: { type: "integer", description: "only return notifications with id greater than this (default 0 = recent)" }, limit: { type: "integer" } }, required: [] } },
  { name: "get_ticket",
    description: "Get one Portal42 ticket's status/details by numeric id. NOTE: the ticket endpoints are still being rolled out — until they're live this returns an 'Unknown action' error; treat that as 'tickets aren't available yet', not a failure, and use list_tracker_notifications instead.",
    input_schema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } },

  // ---- 42payments (Q's business finances) ----
  // Money in results is { amount, code }, e.g. {"amount":"500.00","code":"USD"}. The tool may
  // return {not_ready:true} (app up but FreshBooks not connected — Q must sign in once at
  // 42payments) or {offline:true} (app not reachable) — treat both as "finances unavailable",
  // not a failure, and tell Q plainly. Writes pop an on-screen confirm before they fire.
  { name: "finance_summary",
    description: "One-call rollup of Q's business: revenue, outstanding, expenses, netProfit, currency, counts. Use this first for 'how's the business doing?'.",
    input_schema: { type: "object", properties: {}, required: [] } },
  { name: "finance_list",
    description: "List finance records. 'type' picks the dataset: invoices | expenses | clients | payments. For invoices you may pass 'status' (FreshBooks v3_status, e.g. 'paid','outstanding') and 'limit' (<=100).",
    input_schema: { type: "object", properties: { type: { type: "string", enum: ["invoices","expenses","clients","payments"] }, status: { type: "string" }, limit: { type: "integer" } }, required: ["type"] } },
  { name: "finance_profit_loss",
    description: "Profit & Loss report between two dates (YYYY-MM-DD). Pass 'start' and 'end'.",
    input_schema: { type: "object", properties: { start: { type: "string" }, end: { type: "string" } }, required: ["start","end"] } },
  { name: "finance_create_invoice",
    description: "Create an invoice for a client. Needs clientId and amount (a plain number; currency defaults USD). Optional description, dueDate (YYYY-MM-DD). Q confirms on screen before it's created.",
    input_schema: { type: "object", properties: { clientId: { type: "string" }, amount: { type: "number" }, description: { type: "string" }, dueDate: { type: "string" }, currency: { type: "string" } }, required: ["clientId","amount"] } },
  { name: "finance_log_expense",
    description: "Log a business expense. Needs amount (plain number; currency defaults USD). Optional vendor, date (YYYY-MM-DD), notes, categoryid. Q confirms on screen.",
    input_schema: { type: "object", properties: { amount: { type: "number" }, vendor: { type: "string" }, date: { type: "string" }, notes: { type: "string" }, categoryid: { type: "string" }, currency: { type: "string" } }, required: ["amount"] } },
  { name: "finance_add_client",
    description: "Add a client. Provide at least one of organization, firstName, lastName, email. Q confirms on screen.",
    input_schema: { type: "object", properties: { organization: { type: "string" }, firstName: { type: "string" }, lastName: { type: "string" }, email: { type: "string" } }, required: [] } },
  { name: "finance_mark_invoice_paid",
    description: "Record payment on an invoice — pays its FULL outstanding balance. Needs invoiceId (from finance_list type:invoices). Optional method (e.g. 'Check'). Q confirms on screen.",
    input_schema: { type: "object", properties: { invoiceId: { type: "string" }, method: { type: "string" } }, required: ["invoiceId"] } },
];

function cors() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors() } });
}

// Shared-passphrase gate for /chat and /notes — stops anyone who finds the URL from
// spamming the metered Anthropic API or reading/writing the Notes. The dashboard sends
// "Authorization: Bearer <passphrase>"; we compare it to the DASH_KEY secret.
//   wrangler secret put DASH_KEY        (choose any passphrase)
// FAIL-OPEN by design: if DASH_KEY isn't set yet, requests are allowed (same as before),
// so deploying this code never locks you out. Enforcement starts the instant you set the
// secret. To disable later: `wrangler secret delete DASH_KEY`.
// Constant-time string compare — avoids leaking the secret length/prefix via response timing.
function timingSafeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
// Returns true (key matches), false (key set but wrong/missing), or null (no key configured).
// The caller decides the fail-open policy for null so it can stay narrow (harmless reads only).
function authed(request, env) {
  const secret = (env.DASH_KEY || "").trim();            // tolerate a trailing newline/space in the secret
  if (!secret) return null;                              // not configured → caller applies fail-open policy
  const h = request.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return !!m && timingSafeEqual(m[1].trim(), secret);
}
// Cheap per-isolate rate limit (resets per isolate / colo — a speed bump against a leaked URL,
// not a hard guarantee). Keyed by CF-Connecting-IP + bucket.
const RL_BUCKETS = new Map();
function rateLimited(request, bucket, max, windowMs) {
  const ip = request.headers.get("CF-Connecting-IP") || "?";
  const k = bucket + ":" + ip, now = Date.now();
  let e = RL_BUCKETS.get(k);
  if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + windowMs }; RL_BUCKETS.set(k, e); }
  e.count++;
  return e.count > max;
}

// Notes read/write. Access is gated upstream by authed() once DASH_KEY is set.
// Cheap deterministic string hash (djb2) — KEEP IN SYNC with notesHash() in index.html.
// Used only to detect "did the notes change under me" for clobber protection, not for security.
function notesHash(s) { let h = 5381; s = String(s || ""); for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
async function handleNotes(request, env) {
  if (!env.NOTES) return json({ error: { message: "Notes storage not configured — create a KV namespace bound as NOTES (see README)." } }, 501);
  if (request.method === "GET") {
    const notes = (await env.NOTES.get("notes")) || "";
    return json({ notes, hash: notesHash(notes) });
  }
  if (request.method === "PUT") {
    const text = await request.text();
    // Clobber protection: the client sends the hash of the text it started from. If KV has since
    // changed (another device saved), reject instead of overwriting — the client reconciles.
    const basedOn = request.headers.get("X-Notes-Based-On");
    if (basedOn != null) {
      const current = (await env.NOTES.get("notes")) || "";
      const curHash = notesHash(current);
      if (basedOn !== curHash) return json({ error: { message: "notes changed elsewhere", code: "conflict" }, current, hash: curHash }, 409);
    }
    await env.NOTES.put("notes", text);
    return json({ ok: true, chars: text.length, hash: notesHash(text) });
  }
  return new Response("method not allowed", { status: 405, headers: cors() });
}

// Finance proxy → 42payments. The browser sends { path, method, body }; we attach the
// X-API-Key secret (never exposed to the browser) and forward to PAYMENTS_BASE + path.
// Upstream status/JSON passes straight through (incl. 401 bad-key, 409 not-connected) so the
// browser/agent can react. A network failure (app offline / tunnel down) → 503 {offline:true}.
async function handleFinance(request, env) {
  if (request.method !== "POST") return new Response("POST only", { status: 405, headers: cors() });
  if (!env.PAYMENTS_API_KEY) return json({ error: "Finance not configured — set the PAYMENTS_API_KEY secret on the Worker." }, 501);
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  let path = typeof body.path === "string" ? body.path : "";
  // Only relative paths under the ext surface — no absolute URLs, no traversal.
  if (!path.startsWith("/") || path.includes("://") || path.includes("..")) return json({ error: "bad finance path" }, 400);
  const method = body.method === "POST" ? "POST" : "GET";
  let r;
  try {
    r = await fetch(PAYMENTS_BASE + path, {
      method,
      headers: { "X-API-Key": env.PAYMENTS_API_KEY, "Content-Type": "application/json", "Accept": "application/json" },
      body: method === "POST" ? JSON.stringify(body.body || {}) : undefined,
    });
  } catch {
    return json({ error: "finance tool offline — 42payments isn't reachable right now.", offline: true }, 503);
  }
  const text = await r.text();
  // Clean JSON passes through; a non-JSON body (e.g. an HTML error page) becomes one tidy line
  // instead of a wall of markup reaching the dashboard.
  try {
    return json(JSON.parse(text || "{}"), r.status);
  } catch {
    return json({ error: "42payments returned a non-JSON response (HTTP " + r.status + ") — it may be mid-setup or behind an error page.", code: "upstream_nonjson", upstream_status: r.status }, 502);
  }
}

// Credit-card payoff plan — a tiny JSON blob (strategy/target/monthly) the dashboard's
// debt card owns and edits. Stored in the NOTES KV under "ccplan" so it syncs across
// Q's devices. Gated upstream by authed() like everything else.
async function handleCCPlan(request, env) {
  if (!env.NOTES) return json({ error: "storage not configured" }, 501);
  if (request.method === "GET") {
    const v = await env.NOTES.get("ccplan");
    let plan = null; try { plan = v ? JSON.parse(v) : null; } catch { plan = null; }
    return json({ plan });
  }
  if (request.method === "PUT") {
    const t = await request.text();
    try { JSON.parse(t); } catch { return json({ error: "bad json" }, 400); }
    await env.NOTES.put("ccplan", t);
    return json({ ok: true });
  }
  return new Response("method not allowed", { status: 405, headers: cors() });
}

// Contact metadata — miDash-owned tags (business/personal), usage counts, and hidden flags,
// keyed by lowercased email. Google is the source of truth for the contacts themselves; this
// just layers Q's own data on top. Stored in NOTES KV as "contacts_meta". Gated by authed().
async function handleContactsMeta(request, env) {
  if (!env.NOTES) return json({ error: "storage not configured" }, 501);
  if (request.method === "GET") {
    const v = await env.NOTES.get("contacts_meta");
    let meta = null; try { meta = v ? JSON.parse(v) : null; } catch { meta = null; }
    return json({ meta });
  }
  if (request.method === "PUT") {
    const t = await request.text();
    try { JSON.parse(t); } catch { return json({ error: "bad json" }, 400); }
    await env.NOTES.put("contacts_meta", t);
    return json({ ok: true });
  }
  return new Response("method not allowed", { status: 405, headers: cors() });
}

// Projects board — the dashboard's idea→shipped tracker. A JSON array of project
// records, stored in the NOTES KV under "projects" so it syncs across Q's devices.
// Gated upstream by authed() like everything else.
// Tombstone-aware union merge — KEEP IN SYNC with mergeProjects() in index.html.
// A delete is a record with deleted=true (LWW on `updated` carries it over a stale copy);
// union-by-id alone cannot express deletion. GC tombstones after 90 days.
const PROJ_TOMBSTONE_TTL = 90 * 86400000;
function mergeProjectArrays(a, b) {
  const by = {};
  (a || []).forEach(p => { if (p && p.id) by[p.id] = p; });
  (b || []).forEach(p => { if (!p || !p.id) return; const ex = by[p.id]; if (!ex || (p.updated || 0) > (ex.updated || 0)) by[p.id] = p; });
  const now = Date.now();
  return Object.values(by).filter(p => !(p.deleted && (now - (p.updated || 0)) > PROJ_TOMBSTONE_TTL));
}
async function readProjects(env) {
  const v = await env.NOTES.get("projects");
  try { const a = v ? JSON.parse(v) : []; return Array.isArray(a) ? a : []; } catch { return []; }
}
async function handleProjects(request, env) {
  if (!env.NOTES) return json({ error: "storage not configured" }, 501);
  if (request.method === "GET") {
    const cur = await readProjects(env);
    return json({ projects: cur.length ? cur : null });
  }
  if (request.method === "PUT") {
    let incoming;
    try { incoming = JSON.parse(await request.text()); } catch { return json({ error: "bad json" }, 400); }
    if (!Array.isArray(incoming)) return json({ error: "expected a JSON array" }, 400);
    // Merge into whatever's in KV rather than blind-overwriting, so a browser PUT and the
    // Discord-agent write can't silently clobber each other. Return the merged set so the
    // client adopts it and devices converge.
    const merged = mergeProjectArrays(await readProjects(env), incoming);
    await env.NOTES.put("projects", JSON.stringify(merged));
    return json({ ok: true, projects: merged });
  }
  return new Response("method not allowed", { status: 405, headers: cors() });
}

// Tracker42 (Portal42 ticketing) proxy. The browser hits /tracker?action=…&since=…&limit=…&id=…;
// we attach the PORTAL42_TOKEN Bearer (never exposed to the browser) and forward to the Portal42
// API. Read-only actions only. Network failure → 503 {offline:true}; upstream status/JSON pass
// straight through (so 401 bad-token, 403 scope, 400 unknown-action reach the dashboard/agent).
const TRACKER_BASE = "https://tracker42.com/api/v1.php";
async function handleTracker(request, env) {
  if (!env.PORTAL42_TOKEN) return json({ error: "Tracker42 not configured — set the PORTAL42_TOKEN secret on the Worker.", code: "not_configured" }, 501);
  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "ping";
  const READ = new Set(["ping", "notifications", "tickets", "ticket", "statuses", "ticket_events"]);
  const WRITE = new Set(["mark_read", "mark_all_read", "set_status", "add_comment", "create_ticket"]);
  if (!READ.has(action) && !WRITE.has(action)) return json({ success: false, error: "unknown action: " + action }, 400);
  const params = new URLSearchParams({ action });
  for (const k of ["since", "limit", "id", "offset", "status", "order", "ticket_id"]) { const v = url.searchParams.get(k); if (v != null) params.set(k, v); }
  const isWrite = WRITE.has(action);
  // Write actions (set_status / add_comment / create_ticket / mark_*) POST to the upstream;
  // forward the dashboard's JSON body through untouched so the token-side does the work.
  const init = { method: isWrite ? "POST" : "GET", headers: { Authorization: "Bearer " + env.PORTAL42_TOKEN, "Accept": "application/json" } };
  if (isWrite && request.method === "POST") {
    let fwd; try { fwd = await request.text(); } catch { fwd = ""; }
    if (fwd) { init.headers["Content-Type"] = "application/json"; init.body = fwd; }
  }
  let r;
  try {
    r = await fetch(TRACKER_BASE + "?" + params.toString(), init);
  } catch {
    return json({ offline: true, error: "Tracker42 isn't reachable right now." }, 503);
  }
  let text; try { text = await r.text(); } catch (e) { return json({ success: false, code: "upstream_read", error: "Couldn't read Tracker42's response (HTTP " + r.status + "): " + (e && e.message ? e.message : String(e)) }, 502); }
  // Forward clean JSON straight through. If the upstream returns non-JSON (e.g. an HTML error
  // page — which Tracker42 does when a token is present but the api_tokens table/migration isn't
  // in place), don't relay a wall of HTML: surface one actionable line.
  try {
    return json(JSON.parse(text || "{}"), r.status);
  } catch {
    return json({
      success: false,
      code: "upstream_nonjson",
      upstream_status: r.status,
      error: "Tracker42 returned a non-JSON response (HTTP " + r.status + ") — its API may not be fully set up yet. Run the api_tokens migration on Tracker42, then retry.",
    }, 502);
  }
}

// Discord bot heartbeat. The local bot POSTs here every minute; the dashboard GETs it to
// show a live green/red "Discord" light. The Worker stamps the receive time (its own clock),
// so the dashboard just checks freshness. Stored in the NOTES KV. Gated by authed().
// KV's free tier allows ~1000 writes/day. A 60s heartbeat is 1440 writes/day on its own, which
// blows the quota — after that EVERY put() throws (breaking notes/projects sync too, not just this).
// So coalesce: persist a fresh timestamp at most once per HEARTBEAT_WRITE_EVERY. The bot can keep
// POSTing every minute; we just skip the redundant writes. The dashboard's "online" window is wider
// than this interval, so a coalesced (slightly stale) timestamp still reads green.
const HEARTBEAT_WRITE_EVERY = 5 * 60 * 1000;
async function handleDiscordStatus(request, env) {
  if (!env.NOTES) return json({ error: "storage not configured" }, 501);
  const prevRaw = await env.NOTES.get("discord_status");
  let prev = null; try { prev = prevRaw ? JSON.parse(prevRaw) : null; } catch {}
  if (request.method === "POST") {
    let b = {}; try { b = await request.json(); } catch {}
    const tag = (b && b.tag) ? String(b.tag).slice(0, 64) : (prev && prev.tag) || null;
    const now = Date.now();
    const fresh = prev && prev.at && (now - Number(prev.at)) < HEARTBEAT_WRITE_EVERY;
    if (!fresh) {
      // Never 500 the heartbeat: if we've somehow still hit the KV write cap, swallow it and report skipped.
      try { await env.NOTES.put("discord_status", JSON.stringify({ online: true, tag, at: now })); }
      catch (e) { return json({ ok: true, skipped: "kv_write_limit" }); }
    }
    return json({ ok: true, wrote: !fresh });
  }
  return json({ status: prev });
}

// ---- Reminders: miDash-owned push notifications delivered as a Discord DM ------------------
// Philosophy: own the brain, the state, and the orchestration; third parties are dumb pipes.
// The reminder QUEUE and the SCHEDULER are ours (KV blob + a 1-minute Cron Trigger). Discord is
// just the transport — the Worker sends the DM itself via Discord's REST API using a bot-token
// secret, so nothing depends on the Pi being up. Writers (dashboard capture box, both agents)
// POST absolute-time entries; the cron delivers due ones. Reads are cheap; we only WRITE on
// add / delete / fire, so this stays well under the KV free-tier write budget (~1000/day).
const REMINDER_STALE_MS = 6 * 60 * 60 * 1000;   // >6h late = useless "10-min-before" ping; skip, don't flood
const REMINDER_MAX = 200;                       // cap the blob; prune fired ones older than 3 days
async function getReminders(env) {
  try { const v = await env.NOTES.get("reminders"); const a = v ? JSON.parse(v) : []; return Array.isArray(a) ? a : []; }
  catch { return []; }
}
async function putReminders(env, arr) { await env.NOTES.put("reminders", JSON.stringify(arr)); }
function pruneReminders(arr) {
  const now = Date.now();
  return arr.filter(r => !r.fired || (now - Number(r.fired)) < 3 * 86400000).slice(-REMINDER_MAX);
}
// Resolve an 'at' value on the WORKER (UTC, no browser tz). Handles epoch-ms, ISO-8601, and
// tz-safe relative offsets ("in N minutes/hours"). A BARE wall-clock ISO (no offset) is read as
// UTC — the dashboard path resolves local time correctly, so agents on Discord should prefer a
// relative phrase or an ISO with offset. Returns epoch-ms or null.
function resolveAtServer(v) {
  if (v == null) return null;
  if (typeof v === "number") return v > 1e12 ? v : (v > 1e9 ? v * 1000 : null);
  const s = String(v).trim();
  if (/^\d+$/.test(s)) { const n = parseInt(s, 10); return n > 1e12 ? n : (n > 1e9 ? n * 1000 : null); }
  let m;
  if ((m = s.match(/\bin\s+(\d+)\s*(min|mins|minute|minutes|hour|hours|hr|hrs)\b/i))) {
    return Date.now() + parseInt(m[1], 10) * (/hour|hr/i.test(m[2]) ? 3600000 : 60000);
  }
  const hasTz = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(s);
  const iso = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s);
  const d = new Date(iso ? s.replace(" ", "T") + (hasTz ? "" : "Z") : s);
  return isNaN(d.getTime()) ? null : d.getTime();
}
// Send Q a Discord DM via the REST API (open the DM channel, then post). Uses the same bot
// identity as the Pi's inbound relay; the token is a Worker secret. Q has DM'd the bot, so the
// channel opens fine. Returns { ok } / { ok:false, error }.
async function sendDiscordDM(env, content) {
  const token = env.DISCORD_BOT_TOKEN, uid = env.DISCORD_USER_ID;
  if (!token || !uid) return { ok: false, error: "discord not configured (set DISCORD_BOT_TOKEN + DISCORD_USER_ID)" };
  try {
    const ch = await fetch("https://discord.com/api/v10/users/@me/channels", {
      method: "POST", headers: { Authorization: "Bot " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ recipient_id: String(uid).trim() }),
    });
    if (!ch.ok) return { ok: false, error: "open DM channel failed (HTTP " + ch.status + ")" };
    const chan = await ch.json();
    const msg = await fetch("https://discord.com/api/v10/channels/" + chan.id + "/messages", {
      method: "POST", headers: { Authorization: "Bot " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ content: String(content).slice(0, 1900) }),
    });
    return msg.ok ? { ok: true } : { ok: false, error: "send message failed (HTTP " + msg.status + ")" };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}
// Cron entrypoint (runs every minute): DM any due reminders, mark them fired. Only writes KV
// when something actually changed, so idle minutes cost 1 read and 0 writes.
async function fireDueReminders(env) {
  if (!env.NOTES) return;
  let arr; try { arr = await getReminders(env); } catch { return; }
  if (!arr.length) return;
  const now = Date.now();
  let changed = false;
  for (const r of arr) {
    if (r.fired || Number(r.at) > now) continue;
    if (now - Number(r.at) > REMINDER_STALE_MS) { r.fired = now; r.missed = true; changed = true; continue; }
    const res = await sendDiscordDM(env, r.text);
    if (res.ok) { r.fired = now; changed = true; }
    else { r.attempts = (r.attempts || 0) + 1; changed = true; if (r.attempts >= 5) { r.fired = now; r.failed = res.error || true; } }
  }
  if (changed) { try { await putReminders(env, pruneReminders(arr)); } catch { /* KV write cap: retry next tick */ } }
}
// HTTP surface for the dashboard: GET (list pending) / POST (add {at,text,kind}) / DELETE (?id=).
// Gated by authed() upstream (stays closed until DASH_KEY is set — no fail-open bootstrap).
async function handleReminders(request, env) {
  if (!env.NOTES) return json({ error: { message: "storage not configured" } }, 501);
  const url = new URL(request.url);
  if (request.method === "GET") {
    const arr = (await getReminders(env)).filter(r => !r.fired).sort((a, b) => a.at - b.at);
    return json({ reminders: arr, now: Date.now() });
  }
  if (request.method === "POST") {
    let b = {}; try { b = await request.json(); } catch {}
    const at = Number(b.at);
    if (!at || !isFinite(at) || at < Date.now() - 60000) return json({ error: { message: "bad or past 'at' — pass epoch-ms in the future" } }, 400);
    if (!b.text) return json({ error: { message: "need text" } }, 400);
    const arr = pruneReminders(await getReminders(env));
    const id = "r_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
    arr.push({ id, at, text: String(b.text).slice(0, 500), kind: String(b.kind || "reminder").slice(0, 24), created: Date.now(), fired: null, attempts: 0 });
    await putReminders(env, arr);
    return json({ ok: true, id });
  }
  if (request.method === "DELETE") {
    const id = url.searchParams.get("id"); if (!id) return json({ error: { message: "need ?id=" } }, 400);
    let arr = await getReminders(env); const before = arr.length; arr = arr.filter(r => r.id !== id);
    if (arr.length !== before) await putReminders(env, arr);
    return json({ ok: true, removed: before - arr.length });
  }
  return new Response("method", { status: 405, headers: cors() });
}
/* ---- Flow layer: waiting-on / blocked-by ----------------------------------------------------
   Google Tasks holds title + due + done. It cannot express "this is parked in someone else's
   court" or "this can't start until that other thing is finished" — the two states that decide
   what's actually actionable today. miDash owns those.

   One KV blob ("flow") of entries keyed by Google task id. Entries written from Discord are keyed
   "pending:<lowercased title>" instead, because the Worker has no Google token and can't know the
   id; the browser re-keys those onto the real task on its next load (see reconcileFlow).

   Why KV and not the Google task's own notes field: the WORKER has to be able to read this (the
   Discord agent and the cron have no Google access), and a KV blob keeps that possible. Written
   only on a real state change — a handful of writes a day, nowhere near the KV budget.

   Entry: { taskId, title, waiting, waitingSince, chase, chaseId, after, afterId, updated } */
const FLOW_MAX = 300, FLOW_TTL_MS = 60 * 86400000;
// "Empty" = carries no state worth keeping. MUST list every field, or pruneFlow silently drops
// entries that only hold a place tag or a push count. KEEP IN SYNC with flowEntryEmpty in index.html.
function flowEmpty(e) { return !e || (!e.waiting && !e.after && !e.place && !Number(e.pushes)); }
async function getFlow(env) {
  try {
    const v = await env.NOTES.get("flow");
    const o = v ? JSON.parse(v) : null;
    return (o && typeof o === "object" && o.items && typeof o.items === "object") ? { items: o.items } : { items: {} };
  } catch { return { items: {} }; }
}
async function putFlow(env, f) { await env.NOTES.put("flow", JSON.stringify(f)); }
// Drop entries that no longer say anything (waiting cleared, block cleared) once they've gone
// cold, then cap the blob. Keeps it from growing forever as tasks come and go in Google.
function pruneFlow(f) {
  const cut = Date.now() - FLOW_TTL_MS, out = {};
  const keys = Object.keys(f.items || {}).filter(k => {
    const e = f.items[k];
    return e && !(flowEmpty(e) && Number(e.updated || 0) < cut);
  }).sort((a, b) => Number(f.items[b].updated || 0) - Number(f.items[a].updated || 0)).slice(0, FLOW_MAX);
  for (const k of keys) out[k] = f.items[k];
  return { items: out };
}
// Per-entry last-write-wins. The browser used to be the only writer, but the Discord agent writes
// here too — a blind whole-blob PUT would race it exactly the way projects did before v1.31.0.
function mergeFlow(base, incoming) {
  const out = { items: Object.assign({}, base.items || {}) };
  for (const k of Object.keys(incoming.items || {})) {
    const inc = incoming.items[k], cur = out.items[k];
    if (!inc || typeof inc !== "object") continue;
    if (!cur || Number(inc.updated || 0) >= Number(cur.updated || 0)) out.items[k] = inc;
  }
  return out;
}
// Find an entry by task title — exact match first, then substring. Both agent surfaces address
// tasks by title (Discord has no task ids), so this is the shared matcher.
function flowFind(items, q) {
  const s = String(q || "").toLowerCase().trim();
  if (!s) return null;
  const list = Object.keys(items || {}).map(k => [k, items[k]]).filter(([, v]) => v && v.title);
  return list.find(([, v]) => String(v.title).toLowerCase() === s)
    || list.find(([, v]) => String(v.title).toLowerCase().includes(s))
    || list.find(([, v]) => s.includes(String(v.title).toLowerCase())) || null;
}
// Get the entry for a title, creating a browser-reconcilable "pending:" one if it's new.
function flowUpsert(f, title) {
  const hit = flowFind(f.items, title);
  if (hit) return hit[0];
  const k = "pending:" + String(title).toLowerCase().trim().slice(0, 80);
  if (!f.items[k]) f.items[k] = { taskId: null, title: String(title).slice(0, 200), waiting: "", after: "", updated: 0 };
  return k;
}
/* ---- Watches: conditionals, the third shape --------------------------------------------------
   A task is committed work. A reminder is a ping. A WATCH is a decision deferred to a moment:
   "call Bob by 10a IF he hasn't emailed me before then". The call may never need making, so
   committing it as a task means Q ticks off a chore that resolved itself.

   Split of duties: the WORKER owns the queue (KV `watches`) and fires the Discord ping on time via
   the normal reminder path — but it cannot EVALUATE anything, because the condition is a Gmail
   question and Google creds live only in the browser. So the browser resolves due watches when the
   dashboard is open (runDueWatches) and reports the outcome back. If the dashboard stays closed,
   the ping still lands on time with the condition written into it — Q just settles it himself. */
const WATCH_MAX = 100, WATCH_KEEP_MS = 7 * 86400000;
async function getWatches(env) {
  try { const v = await env.NOTES.get("watches"); const a = v ? JSON.parse(v) : []; return Array.isArray(a) ? a : []; }
  catch { return []; }
}
async function putWatches(env, arr) { await env.NOTES.put("watches", JSON.stringify(arr)); }
function pruneWatches(arr) {
  const cut = Date.now() - WATCH_KEEP_MS;
  return arr.filter(w => w && (!w.resolved || Number(w.resolved) > cut)).slice(-WATCH_MAX);
}
async function handleWatch(request, env) {
  if (!env.NOTES) return json({ error: { message: "storage not configured" } }, 501);
  const url = new URL(request.url);
  if (request.method === "GET") {
    const arr = (await getWatches(env)).filter(w => !w.resolved).sort((a, b) => a.at - b.at);
    return json({ watches: arr, now: Date.now() });
  }
  if (request.method === "POST") {
    let b = {}; try { b = await request.json(); } catch {}
    // Resolving an existing watch: the browser reports what it found.
    if (b.resolve) {
      const arr = await getWatches(env);
      const w = arr.find(x => x.id === b.resolve);
      if (!w) return json({ error: { message: "no watch " + b.resolve } }, 404);
      w.resolved = Date.now(); w.result = String(b.result || "").slice(0, 200);
      await putWatches(env, pruneWatches(arr));
      return json({ ok: true });
    }
    const at = Number(b.at);
    if (!at || !isFinite(at) || at < Date.now() - 60000) return json({ error: { message: "bad or past 'at' — pass epoch-ms in the future" } }, 400);
    const kind = ["email_from", "invoice_paid", "ticket_status"].includes(b.kind) ? b.kind : "email_from";
    if (!b.thenTitle) return json({ error: { message: "need thenTitle" } }, 400);
    if (kind === "email_from" && !b.who) return json({ error: { message: "email_from needs who" } }, 400);
    if (kind !== "email_from" && !b.ref) return json({ error: { message: kind + " needs ref" } }, 400);
    const arr = pruneWatches(await getWatches(env));
    const id = "w_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
    arr.push({
      id, at, kind, check: String(b.check || "").slice(0, 200),
      who: String(b.who || "").slice(0, 120), email: String(b.email || "").slice(0, 160),
      ref: String(b.ref || "").slice(0, 120), target: String(b.target || "").slice(0, 60),
      since: Number(b.since) || Date.now(),
      thenTitle: String(b.thenTitle).slice(0, 200), thenNotes: String(b.thenNotes || "").slice(0, 2000),
      reminderId: b.reminderId || null, created: Date.now(), resolved: null, result: "",
    });
    await putWatches(env, arr);
    return json({ ok: true, id });
  }
  if (request.method === "DELETE") {
    const id = url.searchParams.get("id"); if (!id) return json({ error: { message: "need ?id=" } }, 400);
    let arr = await getWatches(env); const before = arr.length; arr = arr.filter(w => w.id !== id);
    if (arr.length !== before) await putWatches(env, arr);
    return json({ ok: true, removed: before - arr.length });
  }
  return new Response("method not allowed", { status: 405, headers: cors() });
}

/* Conditions the WORKER can settle by itself, unlike Gmail: FreshBooks and Tracker42 keys both live
   here. That makes these strictly better than the email oracle — they resolve on time whether or
   not the dashboard is open. Returns true (met) / false (not met) / null (couldn't tell).

   null matters. These are external APIs whose response shape we don't control, so when the answer
   isn't legible we must NOT guess — a wrong "met" silently drops a task Q needed. null leaves the
   watch pending and lets the stale nudge ask him instead. */
async function evalServerCondition(env, w) {
  try {
    if (w.kind === "invoice_paid") {
      const ref = String(w.ref || "").toLowerCase().trim();
      if (!ref) return null;
      const d = await agentFinance(env, "/invoices?status=paid&limit=100");
      if (!d || d.error || d.offline || d.not_ready) return null;
      const rows = d.invoices || d.data || d.records || (Array.isArray(d) ? d : null);
      if (!Array.isArray(rows)) return null;                 // unfamiliar shape → don't pretend
      return rows.some(r => JSON.stringify(r || {}).toLowerCase().includes(ref));
    }
    if (w.kind === "ticket_status") {
      if (w.ref == null || w.ref === "") return null;
      const d = await agentTracker(env, "ticket", { id: w.ref });
      if (!d || d.error || d.offline) return null;
      const t = d.data || d;
      const status = String(t.status || t.state || t.ticket_status || "").toLowerCase();
      if (!status) return null;
      const target = String(w.target || "").toLowerCase().trim();
      return target ? status === target || status.includes(target) : status !== "current";
    }
  } catch { return null; }
  return null;
}
/* Cron half of the watch system. Three jobs, all idempotent:
   - settle server-evaluable conditions and say what happened
   - hand a held condition to the browser to turn into a task (only IT has Google)
   - nudge once about anything the browser hasn't been able to settle (tab's been shut) */
const WATCH_STALE_MS = 3 * 3600000;
async function settleServerWatches(env) {
  if (!env.NOTES) return;
  let arr; try { arr = await getWatches(env); } catch { return; }
  if (!arr.length) return;
  const now = Date.now();
  let changed = false;
  for (const w of arr) {
    if (!w || w.resolved || Number(w.at) > now) continue;

    if (w.kind && w.kind !== "email_from") {
      if (w.commit) continue;                                   // already handed to the browser
      const met = await evalServerCondition(env, w);
      if (met === null) {                                       // couldn't tell — try again, then ask
        if (now - Number(w.at) > WATCH_STALE_MS && !w.nudged) {
          w.nudged = now; changed = true;
          await sendDiscordDM(env, `❓ I couldn't check "${w.check || w.kind}" automatically. If it didn't happen: ${w.thenTitle}`);
        }
        continue;
      }
      changed = true;
      if (met) { w.resolved = now; w.result = "condition met"; await sendDiscordDM(env, `✅ ${w.check || w.kind} — settled itself, nothing to do.`); }
      else { w.commit = true; w.result = "condition held"; await sendDiscordDM(env, `⏳ ${w.check || w.kind} didn't happen — adding "${w.thenTitle}" to your list.`); }
      continue;
    }

    // email_from: only the browser can answer. If it hasn't in hours, the tab's been shut — say so
    // once rather than let the task quietly never appear.
    if (now - Number(w.at) > WATCH_STALE_MS && !w.nudged) {
      w.nudged = now; changed = true;
      await sendDiscordDM(env, `❓ Still haven't been able to check whether ${w.who} emailed — open miDash and I'll settle it. If they didn't: ${w.thenTitle}`);
    }
  }
  if (changed) { try { await putWatches(env, pruneWatches(arr)); } catch { /* KV cap: retry next tick */ } }
}

async function handleFlow(request, env) {
  if (!env.NOTES) return json({ error: { message: "storage not configured" } }, 501);
  if (request.method === "GET") return json({ flow: pruneFlow(await getFlow(env)) });
  if (request.method === "PUT") {
    let b = {}; try { b = await request.json(); } catch { return json({ error: { message: "bad json" } }, 400); }
    const incoming = (b && b.flow && typeof b.flow === "object" && b.flow.items) ? { items: b.flow.items } : { items: {} };
    const merged = pruneFlow(mergeFlow(await getFlow(env), incoming));
    await putFlow(env, merged);
    return json({ ok: true, flow: merged });   // browser adopts the merged set, like /projects
  }
  return new Response("method not allowed", { status: 405, headers: cors() });
}

// Health check for the reminder push path (the Switchboard's Discord card calls this): validates
// the bot TOKEN (GET /users/@me) and the USER ID (open a DM channel — no message sent). With
// ?send=1 it delivers a real test DM — the only 100% proof the pipe works end-to-end.
async function handleDiscordCheck(request, env) {
  const token = env.DISCORD_BOT_TOKEN, uid = env.DISCORD_USER_ID;
  const wantSend = new URL(request.url).searchParams.get("send") === "1";
  const out = { configured: !!(token && uid), tokenOk: false, dmOk: false, sent: false };
  if (!token) { out.error = "DISCORD_BOT_TOKEN not set on the Worker"; return json(out); }
  let me; try { me = await fetch("https://discord.com/api/v10/users/@me", { headers: { Authorization: "Bot " + token } }); }
  catch (e) { out.error = "Discord unreachable: " + (e && e.message || e); return json(out); }
  if (!me.ok) { out.error = "bot token rejected (HTTP " + me.status + ")"; return json(out); }
  try { const b = await me.json(); out.tokenOk = true; out.bot = b.username ? (b.username + (b.discriminator && b.discriminator !== "0" ? "#" + b.discriminator : "")) : b.id; out.botId = b.id; }
  catch { out.tokenOk = true; }
  if (!uid) { out.error = "DISCORD_USER_ID not set on the Worker"; return json(out); }
  // Discord IDs are numeric snowflakes (~17-20 digits). A username ("qforgues42") here is the #1
  // mistake — catch it with a clear message instead of a bare HTTP 400 from the channel-open.
  if (!/^\d{15,25}$/.test(String(uid).trim())) { out.error = 'DISCORD_USER_ID must be your NUMERIC Discord user id (a ~18-digit snowflake), not a username. In Discord: Settings → Advanced → Developer Mode ON, then right-click your name → Copy User ID.'; return json(out); }
  let ch; try { ch = await fetch("https://discord.com/api/v10/users/@me/channels", { method: "POST", headers: { Authorization: "Bot " + token, "Content-Type": "application/json" }, body: JSON.stringify({ recipient_id: String(uid).trim() }) }); }
  catch (e) { out.error = "couldn't open DM channel: " + (e && e.message || e); return json(out); }
  if (!ch.ok) { out.error = "can't open a DM to that user id (HTTP " + ch.status + ")"; return json(out); }
  out.dmOk = true;
  if (wantSend) { const res = await sendDiscordDM(env, "🔔 miDash test — your reminders are wired up correctly. (You can ignore this.)"); out.sent = res.ok; if (!res.ok) out.error = res.error; }
  return json(out);
}

// Agent over external channels (Discord now, SMS/Twilio later) — CHAT-ONLY MVP, no tools.
// Takes { messages:[{role,content}] } or { message:"..." }, returns { reply, usage }.
// NON-streaming (a bot wants the whole reply). Gated by authed() like everything else.
// ---- Server-side tools for the Discord/SMS agent (no browser needed) ----
const AGENT_PIPELINES = {
  software: ["idea", "validate", "plan", "build", "test", "ship", "grow"],
  property: ["idea", "scope", "design", "source", "build", "finish", "done"],
};
const AGENT_PIPELINE = AGENT_PIPELINES.software;   // back-compat
function agentPipe(t) { return AGENT_PIPELINES[t] || AGENT_PIPELINES.software; }
function agentType(p) { return (p && AGENT_PIPELINES[p.type]) ? p.type : "software"; }
const AGENT_SYSTEM = `You are Q's personal assistant "Dash", reachable over Discord. Be concise, warm, and
direct — keep replies short enough to read comfortably in a chat app (a few sentences, use line breaks/lists sparingly).
You have TOOLS for Q's finances (42payments), his Portal42/Tracker42 tickets, his Projects board, his Notes
scratchpad, and reminders — use them to actually get things done, then confirm briefly what you did.
You do NOT have his email or calendar here (those need the miDash dashboard) — if he asks for those, say so plainly.
Reminders: set_reminder schedules a Discord DM ping at a time (you're already in that DM). For 'at', prefer a
relative phrase you can compute safely ("in 20 minutes", "in 2 hours") or an explicit ISO-8601 time WITH a
timezone offset — a bare wall-clock time is read as UTC here, so avoid it. list_reminders / cancel_reminder manage them.
His day list has three states: his to do, WAITING on someone else, or BLOCKED behind another task. You can't see
Google Tasks from here, but you CAN see and change the last two (set_waiting / clear_waiting / block_task /
list_waiting) — they're miDash's own. When he says he's done all he can on something and it's in someone else's
court, set_waiting it so it stops nagging him; when the waiting is on a PERSON, pass chase_at too or it just rots
(and if an email went unanswered, the chase should be to CALL them, not email again). When he describes work in
sequence, block_task the second one behind the first. "What am I waiting on / what's stuck" → list_waiting.
CONDITIONALS ("call Bob by 10a if he hasn't emailed by then") are set_watch, not a task — the call may never
need making. It pings him at the decision point and creates the task ONLY if the condition held. Never pair it
with a task. kind 'email_from' is settled from Gmail when his dashboard is next open; 'invoice_paid' and
'ticket_status' are settled HERE, on time, because the Worker holds those keys — prefer them when they fit.
PLACES: set_place tags where a task happens so errands get grouped into one run; when_there:true parks a
dateless task until he's in that place ("meet Evan next time I'm in Michigan") instead of nagging him daily.
list_places shows both.
Q's day starts at 10am — never schedule a chase or a morning nudge earlier than that. He writes times as
"10a" / "3p" / "9:30a", meaning 10am, 3pm, 9:30am.
For anything OTHERS would see (a ticket status change, a ticket comment), briefly confirm with Q before doing it
unless he was already explicit. Reading is always fine to do immediately.`;
const AGENT_TOOLS = [
  { name: "read_notes", description: "Read Q's free-form Notes scratchpad.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "add_note", description: "Jot a line to the TOP of Q's Notes scratchpad.", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  ...PROJECT_TOOLS,   // shared with TOOLS — single source of truth (see PROJECT_TOOLS above)
  ...REMINDER_TOOLS,  // shared with TOOLS — Discord DM reminders (see REMINDER_TOOLS above)
  ...FLOW_TOOLS,      // shared with TOOLS — waiting-on / blocked-by (KV-backed, so Discord can see it)
  ...PLACE_TOOLS,     // shared with TOOLS — errands / when-there (KV-backed, works over Discord)
  ...WATCH_TOOLS,     // shared with TOOLS — conditionals; the BROWSER evaluates them (needs Gmail)
  { name: "finance_summary", description: "Q's business finance rollup (revenue, outstanding, expenses, net) from 42payments.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "list_tracker_notifications", description: "List Q's Portal42 (Tracker42) notifications, newest first.", input_schema: { type: "object", properties: { limit: { type: "integer" } }, required: [] } },
  { name: "get_ticket", description: "Get a Portal42 ticket's details by numeric id.", input_schema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } },
  { name: "set_ticket_status", description: "Change a Portal42 ticket's status (e.g. current, code_review, released). A note is required for failed_beta/failed_live/released. Confirm with Q first.", input_schema: { type: "object", properties: { id: { type: "integer" }, status: { type: "string" }, note: { type: "string" } }, required: ["id", "status"] } },
  { name: "add_ticket_comment", description: "Add a comment/reply to a Portal42 ticket. Confirm with Q first.", input_schema: { type: "object", properties: { ticket_id: { type: "integer" }, comment: { type: "string" }, is_internal: { type: "boolean" } }, required: ["ticket_id", "comment"] } },
];
// Returns the RAW array (tombstones included) — write paths must preserve tombstones or they'd
// resurrect deletes on un-synced devices. List/match sites filter p.deleted themselves.
async function agentGetProjects(env) { try { const v = await env.NOTES.get("projects"); const a = v ? JSON.parse(v) : []; return Array.isArray(a) ? a : []; } catch { return []; } }
async function agentFinance(env, path) {
  if (!env.PAYMENTS_API_KEY) return { error: "finance not configured" };
  try { const r = await fetch(PAYMENTS_BASE + path, { headers: { "X-API-Key": env.PAYMENTS_API_KEY, "Accept": "application/json" } }); const t = await r.text(); try { return JSON.parse(t || "{}"); } catch { return { error: "finance returned non-JSON (app may be down)" }; } }
  catch { return { error: "42payments offline" }; }
}
async function agentTracker(env, action, params, body) {
  if (!env.PORTAL42_TOKEN) return { error: "tracker not configured" };
  const qs = new URLSearchParams({ action });
  if (params) for (const k in params) if (params[k] != null) qs.set(k, params[k]);
  const isWrite = ["set_status", "add_comment", "create_ticket", "mark_read", "mark_all_read"].includes(action);
  const init = { method: isWrite ? "POST" : "GET", headers: { Authorization: "Bearer " + env.PORTAL42_TOKEN, "Accept": "application/json" } };
  if (isWrite && body) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
  try { const r = await fetch(TRACKER_BASE + "?" + qs.toString(), init); const t = await r.text(); try { return JSON.parse(t || "{}"); } catch { return { error: "tracker returned non-JSON" }; } }
  catch { return { error: "Tracker42 offline" }; }
}
async function runAgentTool(name, a, env) {
  a = a || {};
  try {
    switch (name) {
      case "read_notes": { const n = (await env.NOTES.get("notes")) || ""; const slice = n.slice(0, 8000); return { notes: slice, truncated: n.length > slice.length, totalChars: n.length }; }
      case "add_note": { if (!a.text) return { error: "need text" }; const cur = (await env.NOTES.get("notes")) || ""; const CAP = 100000; const next = ("- " + String(a.text) + "  · " + new Date().toISOString().slice(0, 10) + "\n" + cur); const truncated = next.length > CAP; await env.NOTES.put("notes", next.slice(0, CAP)); return { added: true, truncated }; }
      case "list_projects": { const ps = (await agentGetProjects(env)).filter(p => !p.deleted); return { projects: ps.map(p => { const t = agentType(p); const o = { name: p.name, type: t, stage: agentPipe(t)[p.stage] || "idea", next: p.next || null, lastTouchedDays: p.updated ? Math.round((Date.now() - p.updated) / 86400000) : null, url: p.url || null }; if (t === "property") { o.property = p.property || null; o.area = p.area || null; o.people = p.people || null; } return o; }) }; }
      case "add_project": { if (!a.name) return { error: "need name" }; const ps = await agentGetProjects(env); const t = AGENT_PIPELINES[a.type] ? a.type : "software"; const si = a.stage ? agentPipe(t).indexOf(String(a.stage).toLowerCase()) : 0; const isProp = t === "property"; const np = { id: "p_" + Date.now().toString(36), name: String(a.name), type: t, property: isProp && a.property ? String(a.property) : "", area: isProp && a.area ? String(a.area) : "", people: isProp && a.people ? String(a.people) : "", url: String(a.url || ""), repo: t === "software" ? String(a.repo || "") : "", stage: si >= 0 ? si : 0, next: String(a.next || ""), notes: "", updated: Date.now(), pinned: false, order: (ps.reduce((m, p) => Math.max(m, p.order || 0), 0) + 1) }; ps.push(np); await env.NOTES.put("projects", JSON.stringify(ps)); return { added: true, name: np.name, type: t }; }
      case "update_project": { if (!a.name) return { error: "need name" }; const ps = await agentGetProjects(env); const q = String(a.name).toLowerCase(); const live = ps.filter(x => !x.deleted); const p = live.find(x => x.name.toLowerCase() === q) || live.find(x => x.name.toLowerCase().includes(q)); if (!p) return { error: "no project matching " + a.name }; const pipe = agentPipe(agentType(p)); if (a.stage) { const si = pipe.indexOf(String(a.stage).toLowerCase()); if (si < 0) return { error: "bad stage for this " + agentType(p) + " project; use one of " + pipe.join(", ") }; p.stage = si; } if (a.next != null) p.next = String(a.next); if (a.property != null) p.property = String(a.property); if (a.area != null) p.area = String(a.area); if (a.people != null) p.people = String(a.people); p.updated = Date.now(); await env.NOTES.put("projects", JSON.stringify(ps)); return { updated: true, name: p.name, type: agentType(p), stage: pipe[p.stage] }; }
      case "finance_summary": return await agentFinance(env, "/summary");
      case "list_tracker_notifications": { const d = await agentTracker(env, "notifications", { since: 0, order: "desc", limit: a.limit || 10 }); if (d && d.success === false) return { error: d.error }; return { notifications: (d && d.data) || [], meta: (d && d.meta) || {} }; }
      case "get_ticket": { if (a.id == null) return { error: "need id" }; const d = await agentTracker(env, "ticket", { id: a.id }); return (d && d.data) || d; }
      case "set_ticket_status": { if (a.id == null || !a.status) return { error: "need id and status" }; return await agentTracker(env, "set_status", null, { id: a.id, status: a.status, note: a.note || undefined }); }
      case "add_ticket_comment": { if (a.ticket_id == null || !a.comment) return { error: "need ticket_id and comment" }; return await agentTracker(env, "add_comment", null, { ticket_id: a.ticket_id, comment: a.comment, is_internal: a.is_internal }); }
      case "set_reminder": {
        if (!a.text) return { error: "need text" };
        const at = resolveAtServer(a.at);
        if (!at) return { error: "couldn't parse 'at' — give epoch-ms, an ISO-8601 time with offset, or a relative phrase like 'in 20 minutes'" };
        if (at < Date.now() - 60000) return { error: "that time is in the past" };
        const arr = pruneReminders(await getReminders(env));
        const id = "r_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
        arr.push({ id, at, text: String(a.text).slice(0, 500), kind: "reminder", created: Date.now(), fired: null, attempts: 0 });
        await putReminders(env, arr);
        return { scheduled: true, id, at: new Date(at).toISOString() };
      }
      case "list_reminders": { const arr = (await getReminders(env)).filter(r => !r.fired).sort((x, y) => x.at - y.at); return { reminders: arr.map(r => ({ id: r.id, text: r.text, at: new Date(r.at).toISOString() })) }; }
      case "cancel_reminder": { if (!a.id) return { error: "need id" }; let arr = await getReminders(env); const before = arr.length; arr = arr.filter(r => r.id !== a.id); if (arr.length === before) return { error: "no reminder with id " + a.id }; await putReminders(env, arr); return { cancelled: true }; }
      // ---- Flow (waiting-on / blocked-by). KV-backed, so these work with no Google token. ----
      case "set_waiting": {
        if (!a.task || !a.on) return { error: "need task and on" };
        const f = await getFlow(env);
        const k = flowUpsert(f, a.task), e = f.items[k];
        e.waiting = String(a.on).slice(0, 200);
        e.waitingSince = e.waitingSince || Date.now();
        e.updated = Date.now();
        let chase = null;
        if (a.chase_at) {
          const at = resolveAtServer(a.chase_at);
          if (!at) return { error: "couldn't parse 'chase_at' — give epoch-ms, an ISO-8601 time with offset, or a relative phrase like 'in 2 days'" };
          if (at < Date.now() - 60000) return { error: "that chase time is in the past" };
          const arr = pruneReminders(await getReminders(env));
          const id = "r_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
          arr.push({ id, at, text: String(a.chase || ("Chase " + e.waiting + " — " + e.title)).slice(0, 500), kind: "chase", created: Date.now(), fired: null, attempts: 0 });
          await putReminders(env, arr);
          e.chase = at; e.chaseId = id;
          chase = new Date(at).toISOString();
        }
        await putFlow(env, pruneFlow(f));
        return { waiting: true, task: e.title, on: e.waiting, chaseAt: chase };
      }
      case "clear_waiting": {
        if (!a.task) return { error: "need task" };
        const f = await getFlow(env);
        const hit = flowFind(f.items, a.task);
        if (!hit) return { error: "nothing on the waiting list matching " + a.task };
        const [k, e] = hit;
        if (!e.waiting) return { error: "\"" + e.title + "\" wasn't marked as waiting on anything" };
        const was = e.waiting;
        e.waiting = ""; e.waitingSince = null; e.chase = null; e.chaseId = null; e.updated = Date.now();
        // NOT "unblocked" — this task is merely actionable again. Anything parked behind it only
        // frees up when it's actually COMPLETED. Report the queue so Dash can say what's next.
        const title = String(e.title || "").toLowerCase();
        const queued = Object.keys(f.items).filter(x => x !== k).map(x => f.items[x])
          .filter(o => o.after && (String(o.after).toLowerCase() === title || String(o.after).toLowerCase().includes(title) || title.includes(String(o.after).toLowerCase())))
          .map(o => o.title);
        await putFlow(env, pruneFlow(f));
        return { cleared: true, task: e.title, wasWaitingOn: was, backOnHisList: true, queuedBehindIt: queued };
      }
      case "block_task": {
        if (!a.task || !a.after) return { error: "need task and after" };
        const f = await getFlow(env);
        // The blocker needs no entry of its own — the blocked task stores its title. (Creating one
        // would be pruned on the way out anyway: a fresh entry with nothing set is "empty".)
        const known = flowFind(f.items, a.after);
        const blockerTitle = known ? known[1].title : String(a.after).slice(0, 200);
        const k = flowUpsert(f, a.task), e = f.items[k];
        if (String(e.title).toLowerCase() === String(blockerTitle).toLowerCase()) return { error: "a task can't be blocked on itself" };
        e.after = blockerTitle; e.afterId = known ? (known[1].taskId || null) : null; e.updated = Date.now();
        await putFlow(env, pruneFlow(f));
        return { blocked: true, task: e.title, after: blockerTitle };
      }
      // ---- Places. Pure KV, so these work identically from Discord and the browser. ----
      case "set_place": {
        if (!a.task || !a.place) return { error: "need task and place" };
        const f = await getFlow(env);
        const k = flowUpsert(f, a.task), e = f.items[k];
        e.place = String(a.place).slice(0, 60);
        e.trip = !!a.when_there;
        e.updated = Date.now();
        await putFlow(env, pruneFlow(f));
        return { placed: true, task: e.title, place: e.place, whenThere: e.trip,
          note: e.trip ? "Parked off his day list until he's there." : "Grouped with his other errands." };
      }
      case "clear_place": {
        if (!a.task) return { error: "need task" };
        const f = await getFlow(env);
        const hit = flowFind(f.items, a.task);
        if (!hit || !hit[1].place) return { error: "no place-tagged task matching " + a.task };
        const [, e] = hit;
        const was = e.place;
        e.place = ""; e.trip = false; e.updated = Date.now();
        await putFlow(env, pruneFlow(f));
        return { cleared: true, task: e.title, wasAt: was };
      }
      case "list_places": {
        const f = pruneFlow(await getFlow(env));
        const items = Object.keys(f.items).map(k => f.items[k]).filter(e => e.place);
        const errands = {};
        for (const e of items.filter(x => !x.trip)) (errands[e.place] = errands[e.place] || []).push(e.title);
        return {
          errands: Object.keys(errands).map(p => ({ place: p, tasks: errands[p] })),
          stops: Object.keys(errands).length,
          whenThere: items.filter(x => x.trip).map(e => ({ task: e.title, place: e.place })),
        };
      }
      // ---- Watches. The Worker can queue and list them; only the BROWSER can evaluate one
      // (the condition is a Gmail question), so over Discord these are create/read/cancel only. ----
      case "set_watch": {
        if (!a.at || !a.then_task) return { error: "need at and then_task" };
        const kind = ["email_from", "invoice_paid", "ticket_status"].includes(a.kind) ? a.kind : "email_from";
        if (kind === "email_from" && !a.who) return { error: "email_from needs 'who'" };
        if (kind !== "email_from" && !a.ref) return { error: kind + " needs 'ref'" };
        const at = resolveAtServer(a.at);
        if (!at) return { error: "couldn't parse 'at' — give epoch-ms, an ISO-8601 time with offset, or a relative phrase like 'in 2 hours'" };
        if (at < Date.now() - 60000) return { error: "that time is in the past" };
        const check = kind === "email_from" ? "Has " + a.who + " emailed?"
                    : kind === "invoice_paid" ? "Has invoice " + a.ref + " been paid?"
                    : "Is ticket " + a.ref + (a.target ? " at " + a.target : " done") + "?";
        const arr = pruneWatches(await getWatches(env));
        const id = "w_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
        // The ping is a normal reminder, so it lands on Discord on time even if the dashboard
        // never opens — with the condition spelled out so Q can settle it himself.
        const rem = pruneReminders(await getReminders(env));
        const rid = "r_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
        rem.push({ id: rid, at, text: check + " If not: " + a.then_task, kind: "watch", created: Date.now(), fired: null, attempts: 0 });
        await putReminders(env, rem);
        arr.push({ id, at, kind, check, who: String(a.who || "").slice(0, 120), email: "",
          ref: String(a.ref || "").slice(0, 120), target: String(a.target || "").slice(0, 60),
          since: resolveAtServer(a.since) || Date.now(),
          thenTitle: String(a.then_task).slice(0, 200), thenNotes: String(a.then_notes || "").slice(0, 2000),
          reminderId: rid, created: Date.now(), resolved: null, result: "" });
        await putWatches(env, arr);
        return { watching: true, id, at: new Date(at).toISOString(), kind, check, ifNot: a.then_task,
          settledBy: kind === "email_from" ? "the dashboard (needs Gmail, so next time it's open)" : "the Worker, on time",
          note: "The task is NOT created yet — it appears only if the condition holds." };
      }
      case "list_watches": {
        const arr = (await getWatches(env)).filter(w => !w.resolved).sort((x, y) => x.at - y.at);
        return { watches: arr.map(w => ({ id: w.id, at: new Date(w.at).toISOString(), kind: w.kind || "email_from", check: w.check || ("Has " + w.who + " emailed?"), ifNot: w.thenTitle, awaitingDashboard: !!w.commit })) };
      }
      case "cancel_watch": {
        if (!a.id) return { error: "need id" };
        let arr = await getWatches(env); const before = arr.length;
        const w = arr.find(x => x.id === a.id);
        arr = arr.filter(x => x.id !== a.id);
        if (arr.length === before) return { error: "no watch with id " + a.id };
        if (w && w.reminderId) { const rem = (await getReminders(env)).filter(r => r.id !== w.reminderId); await putReminders(env, rem); }
        await putWatches(env, arr);
        return { cancelled: true };
      }
      case "check_email_from": return { error: "checking Gmail needs the dashboard open (Google creds live in the browser, not here). Ask again from the miDash chat, or Q can check the thread himself." };
      case "list_waiting": {
        const f = pruneFlow(await getFlow(env));
        const days = t => t ? Math.round((Date.now() - Number(t)) / 86400000) : null;
        const items = Object.keys(f.items).map(k => f.items[k]);
        return {
          waiting: items.filter(e => e.waiting).map(e => ({ task: e.title, on: e.waiting, days: days(e.waitingSince), chaseAt: e.chase ? new Date(e.chase).toISOString() : null })),
          blocked: items.filter(e => e.after).map(e => ({ task: e.title, after: e.after })),
          // Repeatedly pushed = the honest "what keeps slipping" signal, from the rollover ritual.
          slipping: items.filter(e => Number(e.pushes) >= 3).map(e => ({ task: e.title, pushedTimes: Number(e.pushes) })),
        };
      }
      default: return { error: "unknown tool " + name };
    }
  } catch (e) { return { error: String(e && e.message || e) }; }
}
async function handleAgent(request, env) {
  if (request.method !== "POST") return new Response("POST only", { status: 405, headers: cors() });
  let body;
  try { body = await request.json(); } catch { return json({ error: { message: "bad json" } }, 400); }
  let msgs = Array.isArray(body.messages) ? body.messages.slice()
    : (body.message != null ? [{ role: "user", content: String(body.message) }] : []);
  if (!msgs.length) return json({ error: { message: "no message" } }, 400);
  const model = (typeof body.model === "string" && ALLOWED_MODELS.has(body.model)) ? body.model : DEFAULT_MODEL;
  let usage = null;
  for (let round = 0; round < 6; round++) {   // up to 6 tool rounds, then answer
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 1400, system: AGENT_SYSTEM, tools: AGENT_TOOLS, messages: msgs }),
    });
    if (!r.ok) { let e; try { e = await r.json(); } catch { e = { error: { message: "upstream " + r.status } }; } return json(e, r.status); }
    const data = await r.json();
    usage = data.usage || usage;
    const toolUses = (data.content || []).filter(b => b.type === "tool_use");
    if (!toolUses.length) {
      const reply = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
      return json({ reply, usage });
    }
    msgs.push({ role: "assistant", content: data.content });
    const results = [];
    for (const tu of toolUses) {
      const out = await runAgentTool(tu.name, tu.input, env);
      const isErr = out && typeof out === "object" && ("error" in out);   // surface tool errors at the protocol level
      results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out).slice(0, 8000), ...(isErr ? { is_error: true } : {}) });
    }
    msgs.push({ role: "user", content: results });
  }
  return json({ reply: "I did a few steps but ran out of room — can you narrow it down a bit?", usage });
}

async function handleChat(request, env) {
  if (request.method !== "POST") return new Response("POST only", { status: 405, headers: cors() });
  let body;
  try { body = await request.json(); } catch { return json({ error: { message: "bad json" } }, 400); }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  // The dashboard's model picker sends body.model; fall back to the cheap default.
  const model = (typeof body.model === "string" && ALLOWED_MODELS.has(body.model)) ? body.model : DEFAULT_MODEL;

  // Ground the model in Q's LOCAL date (sent by the browser) so it can resolve "tomorrow",
  // "next tue", etc. Falls back to the Worker's UTC date if the client didn't send one.
  const today = (typeof body.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.today)) ? body.today : new Date().toISOString().slice(0, 10);
  const dow = (typeof body.dow === "string") ? body.dow.replace(/[^A-Za-z]/g, "").slice(0, 12) : "";
  const sys = SYSTEM + `\n\nToday is ${dow ? dow + ", " : ""}${today} in Q's local timezone. Resolve every relative date ("today", "tomorrow", "next Tuesday", "Friday", "in 3 days") against THIS date. For a to-do with a deadline, pass the phrase to create_task's 'due' (the dashboard turns "tomorrow"/"next tue"/"friday 3pm" into Q's exact local date). For a timed ping he should be notified at, pass the same kind of phrase to set_reminder's 'at' — it resolves to Q's exact local time.`;

  // We stream, so timeouts aren't a concern; give the smart models headroom for thinking.
  const smart = SMART_MODELS.has(model);
  const payload = { model, max_tokens: smart ? 6000 : 1500, system: sys, tools: TOOLS, messages, stream: true };
  if (smart) {
    payload.thinking = { type: "adaptive" };       // Claude decides when/how much to think
    payload.output_config = { effort: "medium" };  // balance quality vs token spend
  }

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  // Upstream errors come back as JSON (not SSE) — surface them as JSON so the dashboard
  // can show the message. On success, pipe the SSE stream straight through to the browser.
  if (!r.ok) {
    let err;
    try { err = await r.json(); } catch { err = { error: { message: "upstream " + r.status } }; }
    return json(err, r.status);
  }
  return new Response(r.body, {
    status: 200,
    headers: { ...cors(), "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
  });
}

export default {
  async fetch(request, env) {
    // Wrap everything: an uncaught throw otherwise yields Cloudflare's default error page,
    // which has NO CORS headers — the browser then reports a misleading "access control checks"
    // failure instead of the real error. This guarantees a CORS-safe JSON error the dashboard
    // can read and show.
    try {
      if (request.method === "OPTIONS") return new Response(null, { headers: cors() });
      const url = new URL(request.url);
      const auth = authed(request, env);   // true | false | null(no key set)
      if (auth === false) return json({ error: { message: "Locked — enter your dashboard passphrase.", code: "auth" } }, 401);
      if (auth === null) {
        // Fail-open ONLY for harmless bootstrap reads. Everything else — the Anthropic proxy
        // (/chat, /agent), the finance WRITE proxy, tracker, and ALL writes — stays closed until
        // DASH_KEY is set, so a leaked workers.dev URL can't run up cost or move business money.
        const safeBootstrap = request.method === "GET" && (url.pathname === "/notes" || url.pathname === "/discord-status");
        if (!safeBootstrap) return json({ error: { message: "This Worker isn't secured yet — set the DASH_KEY secret to enable this endpoint.", code: "setup" } }, 401);
      }
      const tooMany = () => json({ error: { message: "Too many requests — slow down a moment.", code: "rate_limited" } }, 429);
      if (url.pathname === "/notes") return handleNotes(request, env);
      if (url.pathname === "/finance") return handleFinance(request, env);
      if (url.pathname === "/ccplan") return handleCCPlan(request, env);
      if (url.pathname === "/projects") return handleProjects(request, env);
      if (url.pathname === "/contacts-meta") return handleContactsMeta(request, env);
      if (url.pathname === "/tracker") return handleTracker(request, env);
      if (url.pathname === "/agent") return rateLimited(request, "ai", 30, 5 * 60 * 1000) ? tooMany() : handleAgent(request, env);
      if (url.pathname === "/discord-status") return handleDiscordStatus(request, env);
      if (url.pathname === "/reminders") return handleReminders(request, env);
      if (url.pathname === "/flow") return handleFlow(request, env);
      if (url.pathname === "/watch") return handleWatch(request, env);
      if (url.pathname === "/discord-check") return handleDiscordCheck(request, env);
      // Canonical tool schemas — single source of truth for inspection/debugging (the models
      // are sent TOOLS on /chat and AGENT_TOOLS on /agent; both share PROJECT_TOOLS).
      if (url.pathname === "/tools") return json({ chatTools: TOOLS.map(t => t.name), agentTools: AGENT_TOOLS.map(t => t.name), schemas: TOOLS });
      return rateLimited(request, "ai", 30, 5 * 60 * 1000) ? tooMany() : handleChat(request, env);   // chat is the fallback route
    } catch (e) {
      return json({ success: false, code: "worker_exception", error: "Worker error: " + (e && e.message ? e.message : String(e)) }, 500);
    }
  },
  // Cron Trigger (wrangler.jsonc → triggers.crons, every minute): deliver due reminders.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(fireDueReminders(env));
    ctx.waitUntil(settleServerWatches(env));
  },
};
