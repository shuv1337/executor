---
"@executor-js/app-data": patch
---

An app write now costs two disk syncs instead of five. The app data supervisor keeps its alarm armed
across writes instead of setting and deleting it, and writing a pending mark, for every write. On
self-host each sync blocks the whole app process, so with a 20 ms sync this doubles one-at-a-time
write throughput (6.6 to 13.1 writes/s) and raises 16-concurrent throughput from 9.8 to 16/s. An
instance that stops during a write still leaves an alarm that announces a new revision.
