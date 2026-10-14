---
"@executor-js/hosted-server": patch
---

Self-host can publish app pages as `<app>--<organization>.<base>` by setting
`EXECUTOR_APP_UI_HOST_FORMAT=flat`, so one `*.<base>` wildcard certificate
covers every app. The default `nested` format (`<app>.<organization>.<base>`)
is unchanged. A single-organization install can also set
`EXECUTOR_APP_UI_DEFAULT_ORGANIZATION` to publish that organization's apps as
`<app>.<base>`. The self-host README previously described the flat form while
the server emitted the nested one.
