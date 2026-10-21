---
"aclarify-skills": patch
---

`whiteboard` (incubating): a recovery whose time ran out no longer begins a reload with a millisecond left and then reports "the canvas was reloaded". Its waits now end no earlier than their deadline by the clock the deadline is measured in, so the panel says the recovery's time ran out.
