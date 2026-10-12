---
"aclarify-skills": minor
---

OCR reviews now default to two reviewers, one principal and one architect. `setup-aclarify-skills` offers this team in every repository it configures, as its own question, and sets it on a yes (`scripts/doctor.sh set-ocr-team`). The config comment it writes keeps OCR from adding a third reviewer for auth, API or logic-heavy changes: a better-fitting lens is swapped in instead. A team the repository already customised, including pinned models or named instances, is kept unless the user agrees to replace it. `ocr-review-loop` documents the new default.
