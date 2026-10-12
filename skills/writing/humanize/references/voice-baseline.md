# Voice baseline

"Sounds human" cannot be measured. "Sounds like this person" can, against samples
of what they actually wrote. The baseline is what turns this skill from a style
opinion into a comparison.

## What counts as a sample

Unedited text the author sent or published, in the register the draft is aiming
at. Three or four short pieces beat one long one, because you are looking for
habits rather than a single performance.

Match the register. Somebody's sent mail and their published essays are two
different writers, and a draft measured against the wrong one gets corrected
toward a voice they only use elsewhere.

Where the samples come from, in the order worth trying:

1. **What the user points to.** Files, links or pasted text they hand you as the
   author's writing. Use those and stop looking.
2. **The conventions folder.** If `docs/agents/workspace.md` names one, look in
   it for a voice sample or a voice profile for this author (a file named for
   them, or a `voice` document that says whose voice it is). A profile there is
   used as described under [Voice profiles](#voice-profiles).
3. **Their sent mail**, where this session can read the author's mailbox and the
   draft goes out over their name. Search the sent side rather than the inbox,
   and read two or three real messages to the same recipient or the same kind of
   reader. That beats any amount of reasoning about their register.
4. **Their published writing** already in the repository: documents they
   authored, prior posts.
5. **Ask.** "Paste me two things you wrote that sound like you" takes the author
   a minute and is more reliable than anything inferred.

## Voice profiles

A voice profile is a written description of how someone writes: the words they
use, how they open and close, what they never say. It is optional. Where the user
points to one, or the conventions folder holds one for this author, read it
before the rewrite and let it steer the BREAK and GROUND passes. If a
voice-matching skill is installed and the user names it, load it by name
(through your skill tool, `/<name>`, or by reading its SKILL.md) and let it
supply the profile.

A profile is a summary and samples are evidence. Measure against the samples;
where the profile and the samples disagree, the samples win. A profile with no
samples still informs the rewrite, but the script gets no `--baseline` and lens 4
reads the profile alone, which the report says.

## What to do with no baseline

Say so, and say it in the report rather than quietly proceeding. Then run the
skill without the comparison: the tell tiers still work, since `house` and
`forensic` hits are defects at any authorship, and the rhythm table still shows
uniformity. What you lose is the ability to say the draft does not sound like
them, so do not say it.

Never assemble a baseline from text an agent drafted, including text already
published under someone's name with an agent's help. That measures the draft
against a previous draft and calls the agreement authorship.

## Using it

Pass each sample as its own `--baseline`, with `<skill dir>` resolved to this
skill's absolute directory:

```bash
python3 '<skill dir>/scripts/cadence.py' draft.md \
  --baseline sample-1.md --baseline sample-2.md --baseline sample-3.md
```

Keep the combined baseline within about twice the draft's length. Four of the
comparison rows move with sample size on their own, and the script marks them
`[*]` and tells you to ignore them when the two texts are too far apart.

## What the numbers do not cover

The rhythm table catches length, variance and openers. It does not catch the
things that most give a person away: the joke they always make, the word they
overuse, the way they refuse to close an email. Read the samples yourself, and
give lens 4 of [the reader panel](reader-panel.md) the raw text rather than a
summary of it.
