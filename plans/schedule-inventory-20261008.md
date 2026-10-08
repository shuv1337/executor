# Existing scheduled jobs inventory

Read-only inventory for [issue #4](https://github.com/shuv1337/executor/issues/4),
first checked October 8, 2026, at approximately 09:25–09:30 UTC (02:25–02:30 PDT),
then expanded at 10:56–11:00 UTC (03:56–04:00 PDT) using the supplied Hermes VM location.
No jobs were triggered, enabled, disabled, moved or deleted. No messages were
sent, providers changed, or services restarted. This report contains no session
files, credentials, private destination IDs or internal network addresses.

## Recommendation

Keep the three live Hermes jobs on the `hermes-bots` VM in their current system.
None is a simple scheduled API mutation: all depend on an agent producing prose
or HTML, host files and publishing tools. Executor can schedule existing app
mutations but does not supply a replacement for the Hermes agent by itself.
Moving these jobs would require reauthoring their capabilities and delivery.

The VM is the verified active location: its gateway and serve services are
running, and all three jobs have recent execution records. The inactive shuvdev
gateway and stale records describe a historical copy, not a stopped routine.
Do not reactivate that copy and duplicate the VM's jobs.

The immediate issue is delivery: each live VM job's latest status is
`delivery_failed`, with a Discord media-send error: `'NoneType' object has no
attribute 'File'`. The brief failures concern MP3 attachments; the recap failure
concerns a PNG. These records do not establish whether accompanying text/link
messages arrived or publishing completed. Repairing delivery is separate from
this inventory. Recap prompts also reference absent paths.

## Hermes jobs

The VM host timezone is UTC, but its Hermes configuration explicitly sets
`America/Los_Angeles`. The shuvdev host timezone is `America/Los_Angeles`, with
an empty Hermes override. Saved timestamps use Pacific offsets. Recent VM records
confirm execution; future ticks below are configured intent, not delivery proof.

| Job and source                        | Configured cadence                     | Recorded state and latest run                                                                       | Dependencies / output                                                                                                                                                                    | Recommendation                                                                                   |
| ------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| hermes-bots: daily-brief-morning      | `0 9 * * *`, daily 09:00 Pacific       | Enabled; last run October 7, 09:05 PDT, `delivery_failed`; next tick October 8, 09:00 PDT           | News/RSS, article enrichment, Hacker News, X CLI credentials, model editorial selection, Python/Jinja build, local Kokoro audio, Pages deploy, git snapshot, configured Discord delivery | Keep in Hermes; separate delivery repair                                                         |
| hermes-bots: daily-brief-evening      | `0 21 * * *`, daily 21:00 Pacific      | Enabled; last run October 7, 21:06 PDT, `delivery_failed`; next tick October 8, 21:00 PDT           | Same pipeline plus recent-edition history to avoid repeat stories                                                                                                                        | Keep in Hermes; batch delivery repair with morning                                               |
| hermes-bots: weekly-github-recap      | `0 8 * * 1`, Monday 08:00 Pacific      | Enabled; last run October 5, 08:20 PDT, `delivery_failed`; next tick October 12, 08:00 PDT          | Authenticated GitHub CLI, model summary, local HTML template and upload helper, configured Discord delivery                                                                              | Keep in Hermes; separate delivery and prompt-path review                                         |
| shuvdev: daily-brief-morning          | Daily 09:00 Pacific                    | Enabled record; inactive gateway; last run October 1, 09:06 PDT, `ok`; stale next tick October 2    | Historical daily-brief copy                                                                                                                                                              | Candidate to retire after confirming VM ownership; do not restart                                |
| shuvdev: daily-brief-evening          | Daily 21:00 Pacific                    | Enabled record; inactive gateway; last run October 1, 21:10 PDT, `ok`; stale next tick October 2    | Historical daily-brief copy                                                                                                                                                              | Candidate to retire after confirming VM ownership; do not restart                                |
| shuvdev: weekly-github-recap          | Monday 08:00 Pacific                   | Enabled record; inactive gateway; last run September 28, 08:09 PDT, `ok`; stale next tick October 5 | Historical recap copy                                                                                                                                                                    | Candidate to retire after confirming VM ownership; do not restart                                |
| Local Mac: HN Front Page Daily Digest | Daily 09:00; stored timestamps Pacific | Paused; last run April 16, `ok`                                                                     | Agent digest, Telegram delivery                                                                                                                                                          | Candidate to retire if consolidated daily brief is retained; do not delete without that decision |
| Local Mac: x-daily-digest             | Daily 09:00; stored timestamps Pacific | Paused; last run April 16, `ok`                                                                     | X CLI, agent digest, Telegram delivery                                                                                                                                                   | Candidate to retire if consolidated daily brief is retained                                      |
| Local Mac: daily-reminders            | Daily 09:00; stored timestamps Pacific | Paused; last run May 7, `ok`                                                                        | Reminder content and Telegram delivery                                                                                                                                                   | Keep paused until the owner confirms whether reminders remain wanted                             |
| Local Mac: daily-brief-morning        | Daily 09:00; stored timestamps Pacific | Paused; last run May 7, `ok`                                                                        | Daily brief pipeline, Telegram delivery                                                                                                                                                  | Candidate to retire as superseded local copy, contingent on confirming VM ownership              |
| Local Mac: daily-brief-evening        | Daily 21:00; stored timestamps Pacific | Paused; last run May 7, `ok`                                                                        | Daily brief pipeline, Telegram delivery                                                                                                                                                  | Candidate to retire as superseded local copy, contingent on confirming VM ownership              |

Both remote copies' daily-brief prompts still instruct Telegram replies, while their
job records specify `deliver: discord`. Confirm the intended destination before
delivery repair. No destination IDs are needed in this report.

Existing daily-brief script filenames were confirmed on shuvdev under
`~/repos/daily-brief/scripts/`: `fetch_news.py`, `enrich_news.py`, `build.py`,
`tts.py`, `deploy.sh`, `scrape_batch.py`, and `linkcheck_gate.py`.
`data/recent-editions.json` exists. Script dependency inspection corroborated
Jinja rendering, local scraping/enrichment, Kokoro and Wrangler/Pages publishing;
these scripts were read, never executed.

The recap prompt references these absent files on both shuvdev and the live VM:

- `~/repos/shuvbot-skills/skills/creative/visual-explainer/templates/latitudes.html`
- `~/repos/shuvbot-skills/upload/scripts/upload-html.sh`

The alternate `~/repos/shuvbot-skills/skills/upload/scripts/upload-html.sh` was
also checked and absent on shuvdev. The `shuvbot-skills` repository exists, but this inventory did not
invent replacements or change the prompt.

## Other shuvdev user timers

Ten timers appear in the live user timer listing. An additional
`shuvmon-agent.timer` unit file exists but is absent from that active listing.
These are distinct host operations, not direct duplicates of the three Hermes
jobs. Keep these timers in systemd: their target executables and local host
role make an Executor migration unjustified without a separate requirement.
Behavior of each target script was not audited.

| Timer                     | Timing declared in its unit                               |
| ------------------------- | --------------------------------------------------------- |
| x-bookmark-watch          | Every five minutes                                        |
| fleet-watch-box-rehydrate | Minute 02, 17, 32, 47                                     |
| fleet-watch-opencode-tags | Minute 04, 14, 24, 34, 44, 54                             |
| fleet-watch-spike-reaper  | Hourly at minute 09                                       |
| bun-compile-tmp-cleanup   | Five minutes after boot, then 30 minutes after activation |
| grokbot-backup            | 00:17, 06:17, 12:17, 18:17 Pacific                        |
| radar-daily               | 00:15 UTC daily, currently 17:15 PDT on the preceding day |
| radar-weekly              | Monday 00:30 UTC, currently Sunday 17:30 PDT              |
| shuvbot-watch             | Weekdays 09:00 Pacific                                    |
| shuvbot-timemachine       | Daily 09:07 Pacific                                       |
| shuvmon-agent (unit only) | 30 seconds after boot, then 120 seconds after activation  |

## Live VM evidence and source boundaries

SSH to the user-supplied exe.dev VM succeeds at `hermes-bots.exe.xyz`; the
`.exe.dev` spelling is not its working SSH name. Read-only commands used:

- Selected metadata from `~/.hermes/cron/jobs.json`: file updated October 7,
  21:06:42 PDT; three enabled jobs, with latest execution records in the table.
- Only the `timezone` setting from `~/.hermes/config.yaml`: `America/Los_Angeles`.
- `XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus systemctl --user show hermes-gateway.service hermes-serve.service --property=Id --property=ActiveState --property=SubState --property=ActiveEnterTimestamp`:
  both active/running; gateway since October 2, 05:21:31 UTC; serve since
  October 2, 05:17:33 UTC. Process cgroups corroborate both user service owners.
- An initial user-service query lacked the SSH session bus environment and
  could not connect; the corrected query above establishes service state.
  A stale gateway PID file was not treated as authoritative.
- VM `~/repos/daily-brief/scripts/{build.py,tts.py,deploy.sh}` exist. The two
  recap prompt paths listed above are absent. No scripts were executed.
- Latest delivery errors were inspected with private paths/destination IDs
  sanitized; all three share the Discord media-send error quoted above.

Bounded filename discovery inspected VM `~/repos`, `~/hermes-workspace`,
`~/.hermes/skills`, and immediate source-check/install/script directory names.
No custom Syncro/Jotform or ticket-watch app source was located. The three live
cron prompts contain no Syncro/Jotform/Executor calls. The VM repositories found
are Hermes, daily-brief, shared skills and Tailscale, rather than an Executor
checkout. An opaque installed item was not opened or assumed to be an app export.

The parent team's separate read-only inspection of shuvdev `~/repos/ltc-workflows`
found Make exports/plans and Discord TTS material, without the requested custom
Executor app source or ticket-watch/digest routine. Existing skills/source
references are not proof of the deployed Executor app identity. Current custom
app source, account definition, deployed revision and routine caller remain
unknown; they require an authorized app-source export or management read from
Executor. No runtime database, auth/token/session file, or provider credential
was opened to infer them.

## Evidence and limits

- Local and shuvdev `~/.hermes/cron/jobs.json` were parsed using selected
  metadata fields. Prompts were inspected with URLs and private destination IDs
  redacted; environment/auth/session files were not read.
- Remote jobs file `updated_at`: October 1, 2026, 21:10:22 PDT. Recent candidate
  output directory modification times corroborate the recorded last-run dates.
- `ssh shuvdev 'systemctl --user show hermes-gateway.service --property=ActiveState --property=SubState'`
  returned inactive/dead. `timedatectl show --property=Timezone --value` returned
  `America/Los_Angeles`.
- `systemctl --user list-timers --all --no-pager` listed ten timers. Their target
  service source contains no direct Hermes/daily-brief/github-recap reference.
- A bounded process command classification found no candidate Hermes, brief or
  recap worker, excluding the inspection shell. Readable standard system cron
  directories contained no candidate references; the `crontab` executable is
  absent. This does not prove there is no indirect scheduler elsewhere.
- This is an inventory of the named Mac/shuvdev/VM Hermes locations and shuvdev user timers,
  not every scheduled operation across all hosts, services or cloud accounts.
  Successful historical `ok` statuses do not independently prove delivery.

## Executor fit and deferred workflow spike

Executor cron accepts an explicit IANA timezone and defaults to UTC, rather
than always running in Pacific time. A move must set
`timezone: "America/Los_Angeles"` explicitly. Schedules start paused, use the
current app deployment/accounts, allow one active run, and coalesce overdue
ticks. Default automatic approval accepts approval requests but preserves
explicit denials; optional browser review expires after 15 minutes. Background
elicitation and automatic schedule retries are unsupported. See
[`workflows.md`](../packages/app-templates/executor/skills/app-authoring/workflows.md).

The replacement requested by [issue #5](https://github.com/shuv1337/executor/issues/5)
remains deferred. An optional bounded spike, after Syncro account/API readiness,
could implement the NinjaOne alert → Syncro ticket → note chain in one authored
app using synthetic service endpoints. Test repeated delivery with a stable
event-derived workflow start key, transient failure retries, and an uncertain
external write outcome. Run/step keys do not themselves guarantee provider-side
ticket/note idempotency. Decide that mechanism before real writes.

Workflows cannot wait for a webhook/event or durable human response, and
approval-demanding background operations error. A real routine requiring a
mid-chain person must retain its current orchestration until a design is
approved. App-to-app tool calls are deferred, so a spike cannot merely compose
separately installed NinjaOne and Syncro apps.

## Checkout and validation

Report checkout: `.rifts/schedule-inventory-20261008`; branch
`shuv/schedule-inventory-20261008`, based on `origin/v2` at `27351e46b`.
`bun run workspace:check --task` failed because the inherited script compares
against the obsolete v1 `origin/main` baseline (486 ahead, 2928 behind).
The guard was not rewritten and v1 main was not integrated. Referenced
`notes/coding-style.md`, `notes/project-orientation.md`, and `notes/deferred.md`
are absent from this baseline; existing `AGENTS.md`, `CONTEXT.md`, and
`plans/schedules.md` were read.

This is documentation only. No behavior changed and no E2E scenario was run.
