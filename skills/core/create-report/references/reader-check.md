# The reader check

Loaded by `create-report`'s step 5, after the page is assembled and before the publish question. It
is the last component in the kit: a cold read that tells you whether the page lands with the reader
step 1 named.

The agent that wrote the page knows what each line was meant to say, so it reads its own intention
off the page. A reader with none of that context sees what the real reader sees: the code nobody
explained, the two paragraphs that disagree, the section where attention runs out.

## Run it

1. Extract the page as its reader meets it, in reading order:

   ```bash
   python3 '<skill dir>/scripts/page-text.py' '<destination>/report.html'
   ```

   Headings come back marked `#`, an accordion's always-visible summary `[card]`, a diagram's own
   labels `[figure]`, and every line inside an accordion that loads closed `[inside card]`. Hand
   over the whole page: the reader judges what is there, not a summary of it.

   If `python3` is not available, tell the user and offer to install it, showing the exact
   command; install only after they confirm. Until then, transcribe the visible text of
   `content.html` in reading order yourself, with the same markers.

2. Build the reader's prompt from [`cold-reader.md`](cold-reader.md): its persona, then the lens
   below with the placeholders filled, then the extracted text. Give no path to anything.

   > **Lens.** You are `<the reader from step 1>`, and you will `<what they will do with it>`. You
   > did not see this work being done. Judge only the text below: open no file, path or link. A
   > line marked `[inside card]` stays hidden until you open the card above it, so an answer that
   > rests only on such lines is one you would have to go looking for. Read the page once, top to
   > bottom, as that reader, and report, quoting the line each point rests on:
   >
   > 1. For each question below, your answer from the page alone, or that the page does not
   >    answer it: `<the questions the reader must be able to answer>`
   > 2. Every term, code, abbreviation or label you met before the page explained it.
   > 3. Every place the page says two different things about the same thing.
   > 4. Anything you would have to open another document to decide or act on.
   > 5. The first line where you would stop reading closely, and what made you stop.

   The questions in item 1 come from the caller: a consumer skill states the questions its reader
   must be able to answer, and a human asking inline gave you them in step 1, as what the reader
   will do. A briefing with nothing to decide asks what the reader should take away.

   If you can dispatch a subagent, send that prompt to one fresh subagent, ideally one with no
   file or tool access, so its ignorance of your session is real. Otherwise answer the prompt
   yourself in a separate pass that reads only the extracted text, and tell the user the check was
   a self-read, which is weaker: you already know what each line was meant to say.

3. Read the answers against what the page was meant to say. Fix the page for every item 2 to 4
   finding, for every answer in item 1 that differs from the caller's intent, and for anything
   before the item-5 line that a reader can do without. Fix the record first, then `content.html`,
   then re-run the assembly.

4. Run one fresh reader on the revised page. **Done when** that reader answers every item-1
   question as intended and reports nothing under items 2 to 4. After two revisions, deliver, and
   write what is still open under the record's assumptions so the human can weigh it.
