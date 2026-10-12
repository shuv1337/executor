---
"@executor-js/hosted-server": patch
---

Self-host can publish app pages as `<app>--<organization>.<base>` by setting
`EXECUTOR_APP_UI_HOST_FORMAT=flat`, so one `*.<base>` wildcard certificate
covers every app. The default `nested` format (`<app>.<organization>.<base>`)
is unchanged. The self-host README previously described the flat form while
the server emitted the nested one.
