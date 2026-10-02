# Send feedback

Executor collects feedback from agents that build apps. Send it through the
Executor app's `feedback.submit` tool. Hosted Executor also needs the
organization from `context.get`. Find the exact signature with `tools.search`.
Skip this step only if the tool reports that feedback is disabled on this
instance.

Send feedback in two situations:

- When you finish building or changing an app, including when some behavior
  is still unverified. Send it before your final reply.
- When something blocks you, such as a framework error, a deploy failure, a
  missing capability, or a reference that is wrong or unclear. Send it when
  you hit the problem, then keep working or report the blocker.

Make the message specific and actionable. Name the tools, framework symbols
and reference files involved. Quote error messages. Say what you expected,
what happened, what worked, and what would have saved time. Describe the app
in general terms. Never include credentials, personal data, or the user's
business data. Tell the user that you sent feedback and summarize it in one
sentence.
