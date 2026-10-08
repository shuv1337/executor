# Existing scheduled jobs inventory

Read-only inventory for [issue #4](https://github.com/shuv1337/executor/issues/4),
checked October 8, 2026, at approximately 09:25–09:30 UTC (02:25–02:30 PDT).
No jobs were triggered, enabled, disabled, moved or deleted. No messages were
sent, providers changed, or services restarted. This report contains no session
files, credentials, private destination IDs or internal network addresses.

## Recommendation

Keep the three configured shuvdev Hermes jobs in their current system for now.
None is a simple scheduled API mutation: all depend on an agent producing prose
or HTML, host files and publishing tools. Executor can schedule existing app
mutations but does not supply a replacement for the Hermes agent by itself.
Moving these jobs would require reauthoring their capabilities and delivery.

The immediate decision is whether the existing jobs should run at all. The
Hermes gateway is inactive, recorded next-run timestamps are stale, and the
recap names missing template/upload paths. Restarting or repairing Hermes is
separate work. An enabled job configuration does not prove current execution.

## Hermes jobs

The shuvdev host timezone is `America/Los_Angeles`; Hermes config has an empty
timezone override, and saved run timestamps use Pacific offsets. Cadences below
are the configured intent, not a promise that jobs are firing today.

| Job and source                        | Configured cadence                     | Recorded state and latest run                                        | Dependencies / output                                                                                                                                                                    | Recommendation                                                                                   |
| ------------------------------------- | -------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| shuvdev: daily-brief-morning          | `0 9 * * *`, daily 09:00 Pacific       | Enabled; last run October 1, 09:06 PDT, `ok`; next tick October 2    | News/RSS, article enrichment, Hacker News, X CLI credentials, model editorial selection, Python/Jinja build, local Kokoro audio, Pages deploy, git snapshot, configured Discord delivery | Keep in Hermes; defer migration                                                                  |
| shuvdev: daily-brief-evening          | `0 21 * * *`, daily 21:00 Pacific      | Enabled; last run October 1, 21:10 PDT, `ok`; next tick October 2    | Same pipeline plus recent-edition history to avoid repeat stories                                                                                                                        | Keep in Hermes; batch any repair with morning                                                    |
| shuvdev: weekly-github-recap          | `0 8 * * 1`, Monday 08:00 Pacific      | Enabled; last run September 28, 08:09 PDT, `ok`; next tick October 5 | Authenticated GitHub CLI, model summary, local HTML template and upload helper, configured Discord delivery                                                                              | Keep in Hermes; missing paths must be resolved before restart                                    |
| Local Mac: HN Front Page Daily Digest | Daily 09:00; stored timestamps Pacific | Paused; last run April 16, `ok`                                      | Agent digest, Telegram delivery                                                                                                                                                          | Candidate to retire if consolidated daily brief is retained; do not delete without that decision |
| Local Mac: x-daily-digest             | Daily 09:00; stored timestamps Pacific | Paused; last run April 16, `ok`                                      | X CLI, agent digest, Telegram delivery                                                                                                                                                   | Candidate to retire if consolidated daily brief is retained                                      |
| Local Mac: daily-reminders            | Daily 09:00; stored timestamps Pacific | Paused; last run May 7, `ok`                                         | Reminder content and Telegram delivery                                                                                                                                                   | Keep paused until the owner confirms whether reminders remain wanted                             |
| Local Mac: daily-brief-morning        | Daily 09:00; stored timestamps Pacific | Paused; last run May 7, `ok`                                         | Daily brief pipeline, Telegram delivery                                                                                                                                                  | Candidate to retire as superseded local copy, contingent on choosing shuvdev as owner            |
| Local Mac: daily-brief-evening        | Daily 21:00; stored timestamps Pacific | Paused; last run May 7, `ok`                                         | Daily brief pipeline, Telegram delivery                                                                                                                                                  | Candidate to retire as superseded local copy, contingent on choosing shuvdev as owner            |

The remote daily-brief prompts still instruct Telegram replies, while their
job records specify `deliver: discord`. Confirm the intended destination before
any reactivation. No destination IDs are needed in this report.

Existing daily-brief script filenames were confirmed on shuvdev under
`~/repos/daily-brief/scripts/`: `fetch_news.py`, `enrich_news.py`, `build.py`,
`tts.py`, `deploy.sh`, `scrape_batch.py`, and `linkcheck_gate.py`.
`data/recent-editions.json` exists. Script dependency inspection corroborated
Jinja rendering, local scraping/enrichment, Kokoro and Wrangler/Pages publishing;
these scripts were read, never executed.

The recap prompt references these absent files on shuvdev:

- `~/repos/shuvbot-skills/skills/creative/visual-explainer/templates/latitudes.html`
- `~/repos/shuvbot-skills/upload/scripts/upload-html.sh`

The alternate `~/repos/shuvbot-skills/skills/upload/scripts/upload-html.sh` is
also absent. The `shuvbot-skills` repository exists, but this inventory did not
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
- This is an inventory of the named Hermes locations and shuvdev user timers,
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
