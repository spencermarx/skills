---
"aclarify-skills": minor
---

OCR reviews now default to two reviewers, one principal and one architect. `setup-aclarify-skills` sets this team in every repository it configures (`scripts/doctor.sh set-ocr-team`), with a config comment that keeps OCR from adding a third reviewer for auth, API or logic-heavy changes: a better-fitting lens is swapped in instead. A team the repository already customised is kept unless the user agrees to replace it. `ocr-review-loop` documents the new default.
