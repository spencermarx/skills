---
"aclarify-skills": minor
---

`whiteboard` (incubating) is re-ported from its upstream doorbell redesign. The lead no longer runs a background poller. In Claude Code the board's server is the foreground of a background job and stops when the session ends. It rings the session's inbox when you Send, the lead fetches `GET /pending`, and a canary at boot proves the ring arrives. In harnesses without an inbox, the server runs detached until you close the board, and the lead listens by long-polling `GET /pending?wait=`. Boards keep their port across reopens. Each Send shows whether the lead has fetched it ("rung", "working", "not heard"). The panel holds and retries Sends the board did not receive. The boot and listening steps changed: `whiteboard.sh start` runs the server in the foreground, `start --detach` runs it detached, and exit 3 now means the board is held by a live server and exit 5 that the runtime is not installed. Room ids are now the board's file name.
