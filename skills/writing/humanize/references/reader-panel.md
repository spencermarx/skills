# Reader panel

Five lenses, each read by a reader built from [reader.md](reader.md) and the
brief below. The blindness is the point: whoever wrote the rewrite knows what it
was meant to say, and therefore reads intention rather than words.

The panel is not a detector and produces no score. It produces five accounts of
what a reader noticed, which is the thing a score stands in for.

## What each reader gets

**Every text goes into the prompt as text**, numbered by line, never as a file
path. A reader that could reach the repository would not need a path to find a
draft sitting in the scratch folder, so where your harness lets you dispatch a
subagent with no file or tool access, use that; where it does not, the prompt's
instruction to open nothing is what keeps the read blind.

Send the rewrite only. Never the tell profile, never the instructions that
produced it. Lens 4 also receives the author's samples and lens 5 also receives
the original; the other three get the rewrite alone.

## Running the panel

**If you can dispatch subagents,** send the five prompts to five fresh
subagents in parallel, each with the persona, its brief and its texts, and
nothing else.

**Otherwise read it yourself, as close to blind as one agent can get.** You have
seen the draft, so the read is weaker, and the report says so. Order and
isolation are what recover most of it:

1. **Write the rewrite alone** to its own file in the scratch folder, numbered by
   line. From here until lens 5, read only that file. Do not reopen the draft,
   the profile or the samples.
2. **Read lenses 1, 2 and 3 first, one at a time,** each as a separate pass that
   starts from the persona and the brief, quotes only from the rewrite file, and
   is written down before the next begins. Treat every sentence whose meaning you
   recall rather than read off the page as a finding for lens 2: a stranger has
   only the words.
3. **Lens 4 next,** with the samples and the rewrite file and nothing else.
4. **Lens 5 last,** the only pass that opens the original.
5. **Where you can, get a truly cold read.** If the user can open a fresh
   session, offer them the five prompts to paste there, and use those answers in
   place of yours.

In the report, name which lenses were read by a fresh reader and which were a
self-read.

## 1. Forensic

> Read this as an editor checking whether anything from a drafting tool survived
> into the final text. Look for: assistant register ("as an AI", "I hope this
> helps"), knowledge-cutoff or real-time-data disclaimers, unfilled placeholders
> or bracketed slots, citation residue, tool-call artifacts, and any sentence
> that addresses the reader as a chatbot would. Quote each one with its line.
> Report nothing else. If there is nothing, say so in one line.

## 2. Register

> Read this as someone who has read a thousand consultancy decks and is sick of
> them. Where does it reach for an abstract noun instead of naming the thing?
> Where does it assert importance rather than showing it? Where does a verb do no
> work: leverage, utilize, facilitate, unlock, empower? Where does a sentence
> announce what it is about to do instead of doing it? Quote each with its line
> and say what the concrete version would need. Do not rewrite the piece.

## 3. Cadence

> Read this aloud in your head and report the rhythm. Do sentences cluster at one
> length? Do paragraphs? How many sentences open the same way, and with what? Is
> there a stretch of perfect parallel structure? Does the closing paragraph
> restate the opening one? Mark the longest run of sentences that feel
> interchangeable. Quote line numbers. Judge only rhythm, never content.

## 4. Voice

Requires the author's real samples. Skip this lens when there are none, and say
in the report that it was skipped.

> Below are samples of one person's real writing, then a draft that is supposed
> to be theirs. Ignore whether the draft is good. Answer one question: would this
> person's colleague believe they wrote it? Name the specific habits in the
> samples the draft is missing, and anything in the draft that appears nowhere in
> the samples. Look at how they open, how long they run on, what they contract,
> how they hedge, how they end, and which words recur. Quote both sides.

Where the author also has a written voice profile (see
[voice-baseline.md](voice-baseline.md)), paste it after the samples, labelled as
the author's own description of their voice. The samples outrank it: where the
two disagree, the reader reports what the samples show.

## 5. Fact integrity

The only lens that receives both texts. It exists because every other part of
this skill is pressure toward making the prose more vivid, and vividness is what
fabrication looks like from the inside.

> Here is an original text and a rewrite of it. List every fact in the rewrite
> that is not in the original: numbers, dates, names, places, events, causal
> claims, and any opinion or feeling attributed to the author. List separately
> anything in the original whose meaning changed, softened, or strengthened.
> Being better written is not a defense. Report only additions and changes, with
> both quotes side by side. If the rewrite adds nothing, say so plainly.

## Reading the results

A finding from lens 5 is a defect and gets fixed. Findings from 1 and 2 get fixed
unless the user overrules. Findings from 3 and 4 are evidence, and where they
conflict, lens 4 wins: matching the author beats matching a rhythm profile, every
time.

Where two readers disagree about the same sentence, keep the sentence and record
both. Rewriting until every lens is silent produces text with nothing left in it
to object to, which is its own kind of machine-written.
