## Memory

Continuity for this project lives in `memory/`. `PROJECT.md`, `DECISIONS.md` and
`SESSIONS.md` are loaded automatically at the start of every session — do not
re-read or re-summarise them, just use them.

- `PROJECT.md` is the current state. Where it disagrees with the code, the code
  wins, and the file gets fixed in the same pass.
- `DECISIONS.md` holds settled choices. A settled choice is reopened by asking,
  not by quietly working around it.
- `SESSIONS.md` is the log of what happened.

Record what a future session would otherwise have to rediscover, using the
`memory_checkpoint` tool. Apply one test to every candidate line: **would a
future session waste time, or repeat a mistake, without this?** A candidate that
fails is dropped, not shortened.
