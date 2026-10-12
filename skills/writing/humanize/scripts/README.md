# cadence.py

Deterministic profiler for the `humanize` skill. The model decides what a
sentence should become (judgment); this script counts sentences, measures their
spread, and finds every pattern in `tells.json` (mechanics). Python 3 standard
library only, no virtual environment.

## Run

Resolve `<skill dir>` to this skill's absolute directory first; the commands run
from the repository, not from here.

```bash
python3 '<skill dir>/scripts/cadence.py' draft.md
python3 '<skill dir>/scripts/cadence.py' draft.md --baseline sent-mail.md --baseline post.md
python3 '<skill dir>/scripts/cadence.py' draft.md --overlay docs/standards/humanize-tells.json
cat draft.md | python3 '<skill dir>/scripts/cadence.py' -
python3 '<skill dir>/scripts/cadence.py' draft.md --format json
```

## What each half reads

The script masks the draft twice and the two halves see different text.

| Half | Reads | Blanked first |
|---|---|---|
| Rhythm figures | prose only | frontmatter, code, URLs, headings, tables, callouts |
| Tell scan | prose, headings and tables | frontmatter, code, URLs, every `preserve` word |

Headings and tables stay in the tell scan on purpose. A barred character is a
defect wherever it sits, heading included.

**What "code" means to the mask**, since a four-space indent alone is not it:

- A fenced block, and its fence.
- An indented block, which means four or more spaces on a line that opens a
  block, after a blank line, with no list open. A four-space indent **inside a
  list** is a nested item or a continuation line, and stays in both halves.
  Matching the indent alone masks those lines too, which hides a `house` hit on a
  numbered-list continuation line from the gate step 3 runs.
- Inline spans between backticks, blanked rather than replaced by a stand-in
  word: a placeholder becomes the most repeated content word in any document
  that uses inline code, and that is a row the procedure acts on. The cost is
  that a sentence opening with an inline-code span reports its second word as
  the opener, so read the openers row on a code-dense draft with that in mind.

Masking blanks a span in place instead of deleting it, so every reported line
number is that line in the file you passed, and every quoted match comes from
the file rather than from the mask. `--keep-code` turns off the first two
bullets for both halves, so fenced and indented code is measured and scanned as
prose. Inline spans stay blanked either way.

## What it emits, and what it refuses to

**Emits** a rhythm table, tell hits grouped by tier with line numbers, and, given
`--baseline`, a row-by-row comparison against the author's own writing.

**Refuses** to emit a percentage, a confidence label, or a detector verdict.
Nothing here was calibrated against a labelled corpus, so any such number would
be invented, and an invented number is believed. Absolute cadence figures mean
little alone. The comparison is the only claim this script can defend, which is
why `--baseline` is worth the effort of gathering samples.

## Reading the rhythm table

| Measure | What a low value tends to mean |
|---|---|
| Sentence-length variation (CV) | Sentences cluster at one length. The strongest rhythm tell there is. |
| Share over 29 words | Nothing runs on. Generated prose rarely risks a long sentence. |
| Paragraph-length variation | Every paragraph is the same size. |
| Contractions per 100 words | Formal register, which may be correct for the piece. |

There are no thresholds here on purpose. A legal notice and a text message have
different right answers, and a band nobody measured would get quoted as though
somebody had. Compare against the baseline instead.

Four comparison rows move with sample size on their own: shortest sentence,
longest sentence, repeated openers, and type-token ratio. Extremes grow as more
sentences are drawn and vocabulary saturates as text lengthens, so a draft and a
much longer baseline differ on these even when the writing is identical. The
script marks them `[*]` when the two texts differ by more than 2x and says to
ignore the row.

## tells.json

One object per tell: `id`, `tier`, `category`, `pattern` (Python regex, matched
case-insensitively), `note`, and an optional `swap` suggestion. The `tiers` block
at the top states what each tier means; `../references/tiers.md` explains why the
split exists and never lists members, so the enumeration has one home.

Adding a tell means adding an object. A tier the script does not rank fails
loudly rather than being silently dropped.

**The shipped corpus has no `house` tells.** House rules belong to the
repository, not to this skill, so they arrive through an overlay.

## Overlays: a repository's house tells

`--overlay FILE` (repeatable) reads a JSON object with two optional keys:

```json
{
  "tells": [
    {"id": "em-dash", "tier": "house", "category": "punctuation", "pattern": "—",
     "note": "Barred by our writing standards. Restructure with a period, comma or colon."}
  ],
  "preserve": ["harness"]
}
```

- A tell whose `id` matches a shipped one **replaces** it. That is how a house
  rule promotes `em-dash` or `emoji` from `aesthetic` to `house`. Any other id is
  added. Each overlay tell is checked exactly like a shipped one.
- `preserve` words are appended to the shipped list, which is empty.
- Later overlays win over earlier ones.

The skill passes the conventions folder's `humanize-tells.json` here when there
is one. A house rule written only in prose, with no overlay entry, is still a
house rule: the skill applies it by reading, and the script cannot count it.

## preserve

`preserve` is a list of words a project uses precisely, blanked before any
pattern runs. The match is whole-word and case-insensitive, so `harness`
protects the noun while `harnessing` and `harnesses` still fire.

**A preserved word is blanked, not skipped**, so any tell whose match spans it is
lost with it: with `harness` preserved, `in the harness landscape` no longer
reports `in-todays-world`. That is the cost, and it is why the list stays short
and holds single words rather than phrases. Before adding a word, empty the
list, re-run over a handful of the repository's documents, and compare: that
shows what the word actually silences, which no amount of reasoning about the
patterns does. Add a word when a tell keeps hitting a term the project means
literally, not to silence a tell you disagree with; that is a change to the tell.

## Errors

Bad input fails with a non-zero exit and names the file that caused it: a
missing file, an empty draft, an empty baseline, a malformed corpus or overlay,
a malformed pattern, an unknown tier, a draft with no prose left after masking,
and a draft whose prose holds no alphabetic words. The script never guesses a
fix and never prints a traceback at the user.

## A document about tells contains tells

Run this over [`../references/tiers.md`](../references/tiers.md) and it reports a
`forensic` hit and a `strict` one. Both are quotations: the tier table names "as
of my last training cutoff" as the example of model leakage, and "leverage
synergies" as the example of bad writing a real person produces.
[`../references/reader-panel.md`](../references/reader-panel.md) reports the same
way, because a reader's brief has to quote the disclaimers it is hunting for.
Mention is not use, and no regex distinguishes the two.

The `forensic` one is the case that bites, because that tier's contract is
remove rather than decide, and step 3 gates on zero. Read the quoted context
before treating a hit in reference material as a defect.

Quotation is not the only way a correct document fails the gate, so read a hit
before obeying it rather than trusting a list of exceptions. Two more: a `~~~`
fence, which `FENCED_CODE` does not match because it reads backticks only, and
unfenced code embedded in a Markdown template, such as a sanitizer regex that
strips the very character a house rule bars. Obeying the gate there breaks the
sanitizer.
