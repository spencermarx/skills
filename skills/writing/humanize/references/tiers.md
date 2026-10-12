# Tiers

The enumeration of tells lives in [`../scripts/tells.json`](../scripts/tells.json)
and is not repeated here. This file says what the tiers mean and why the split
exists.

## Tier follows defense strength, not detector confidence

Sort a rule by one question: **when someone says "but a real person wrote that",
how good is their case?**

| Tier | Their case | Handling |
|---|---|---|
| `house` | Irrelevant. The repository's own house rules already settled it. | Remove. |
| `forensic` | None. No writer produces `oaicite` or "as of my last training cutoff". | Remove. |
| `strict` | Weak. Real people write "leverage synergies", and it is bad writing when they do. | Rewrite, and say what changed. |
| `aesthetic` | Strong. Lincoln used the rule of three, Watson and Crick wrote passively, Huber's 1964 paper is where "robust" got its precise meaning. | Report. Decide in context. Usually keep. |

Most humanizing tools flatten these into one rulebook, which is why their output
strips the life out of good prose while leaving actual model leakage untouched.
The two failures share a cause: treating "an AI would write this" as if it meant
"a person would not".

## Where `house` comes from

The `house` tier is empty until a repository fills it. Its members come from the
**conventions folder** named in `docs/agents/workspace.md`, two ways:

- **In prose.** A voice, tone, brand-voice or writing-standards document there
  that bars a construction outright (a character, a word, an opener). Each such
  bar is a `house` tell, applied by reading.
- **As an overlay.** A `humanize-tells.json` there, passed to the script with
  `--overlay`, so the bars it can express as patterns are counted. Its format is
  in [`../scripts/README.md`](../scripts/README.md#overlays-a-repositorys-house-tells).

A rule that says "prefer" or "usually" is guidance for the rewrite, not a
`house` tell. Only an outright bar is a removal. With no conventions folder, or
nothing in it that bars anything, the tier has no members and every other tier
runs unchanged.

## Why `house` sits above `forensic`

`forensic` is an empirical claim about what models emit, and it could be wrong
tomorrow. `house` is a decision the repository already made, and it binds
whether or not any model ever writes that construction again. Keeping them apart
means a later argument about detection cannot reopen a settled rule.

The em dash is the worked case. The source this skill draws on classes a single
em dash as `aesthetic`, with Dickinson and Didion defending it, and so does the
shipped corpus. A repository whose house rules bar the em dash promotes that tell
to `house` in its overlay, and from then on the defense is irrelevant there: the
rule is not a claim about detection.

## The aesthetic tier is reported, never swept

An aesthetic hit is a fact about the text, not an instruction. Read it in
context:

- **Rule of three** once or twice is rhythm. Five times in a page is a template.
- **Passive voice** is right when the doer is unknown, unimportant, or the whole
  point. It is wrong when it hides who acted.
- **"Robust"** keeps its place where it means resistant to outliers, and goes
  where it means good.
- **Curly quotes** mean the author used a word processor.

The failure mode this prevents: a draft that scores clean and reads like nobody.

## What this skill refused

Two sources fed this skill and neither came across whole.

### From `linkedin-humanizer`

Sergey Bulaev's [`linkedin-humanizer`](https://github.com/sergebulaev/linkedin-skills),
MIT. What came across from it is the **Kept:** list below.

**Refused: the detector loop.** Its five-detector tester needs paid accounts, and
its own documentation says the tool measures how much detectors *disagree*
rather than whether text is generated. Its offline mode returns a SHA-256 hash of
the input formatted as five scores. Nothing here needed replacing, so nothing was
replaced.

**Refused: the invented outputs.** The source advertises a per-sentence
perplexity estimate and an "estimated Originality.ai score", and supplies no
method for either. An estimate with no method is a number the model makes up.
[`../scripts/cadence.py`](../scripts/cadence.py) reports only what it counted.

**Refused: LinkedIn's algorithm coupling.** Character limits, hook conventions,
reach penalties, posting cadence, and warmup choreography are platform tactics,
not properties of human prose.

**Kept:** the tier architecture above, the forensic and strict catalogs, the
negative-parallelism patterns, the rule that a `house` or `forensic` hit is never
skipped because the author likes the draft or is in a hurry, and the preserve
list, which is the `preserve` array in
[`../scripts/tells.json`](../scripts/tells.json), extended per repository by an
overlay. Every project has a word that is brochure register elsewhere and
precise there, and a profiler that flags one on every run teaches its reader to
skim the table.

### From the perplexity-and-burstiness prompt

**Kept:** that uniform sentence length reads as generated, that structural
symmetry is a stronger tell than vocabulary, and that varying how sentences open
matters as much as varying their length. These are measured directly in the
rhythm table.

**Refused: everything that manufactures a person.** It instructs the writer to
add "subtle imperfections", "personal opinions, hesitations", "current events,
popular culture", and "intentional sentence fragments and run-on sentences". Two
problems, and the second is the serious one.

The prompt is written to defeat a classifier, and a reader is not a classifier.
Noise added to move a statistic does not read as human; it reads as damaged.

More importantly, an invented opinion in a document going out over someone's name
is a fabrication that survives every review, because it is fluent and nobody
remembers whether they said it. This is the failure the skill's first rule
exists to prevent, and it is why `GROUND` asks the author for a missing specific
rather than supplying one.

**Refused: its punctuation advice.** It calls for em dashes and parenthetical
asides as marks of authentic flow. Punctuation is a property of the author's
baseline and the repository's house rules, never something added to move a
statistic.
