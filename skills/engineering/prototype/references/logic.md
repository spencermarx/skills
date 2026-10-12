# Logic prototype

A single, self-contained HTML file (a **shareable demo**) that lets anyone drive a
state model by clicking buttons. Use this when the question is about **business
logic, state transitions, or data shape**: the kind of thing that looks
reasonable on paper but only feels wrong once you push it through real cases.

Because it's one file with nothing to install, it can go to a non-developer (a
designer, a domain expert, a stakeholder) who then feels the model for
themselves. So it speaks their language, not the code's.

## When this is the right shape

- "I'm not sure if this state machine handles the edge case where X then Y."
- "Does this data model actually let me represent the case where..."
- "I want to feel out what the API should look like before writing it."
- Anything where someone wants to **press buttons and watch state change**.

If the question is "what should this look like", take the UI branch
(`references/ui.md`) instead.

## Process

### 1. State the question

Before writing code, write down what state model and what question you're
prototyping. One paragraph, at the top of the demo, in a visible intro rather
than a code comment, that a domain expert understands. A logic prototype that
answers the wrong question is pure waste, so make the question explicit enough to
check later, whether the user is watching now or returning to it later. If you
picked this branch on an assumption, state the assumption here too.

### 2. Isolate the logic in a portable module

Put the logic that answers the question in a single `<script>` block written as a
small, pure module that could be lifted out and dropped into the real codebase
later. The page around it is throwaway; this module isn't.

The right shape depends on the question:

- **A pure reducer**: `(state, action) => state`. Good when actions are discrete
  events and state is a single value.
- **A state machine**: explicit states and transitions. Good when "which actions
  are even legal right now" is part of the question.
- **A small set of pure functions** over a plain data type. Good when there's no
  implicit current state, just transformations.
- **A class or module with a clear method surface** when the logic genuinely owns
  ongoing internal state.

Pick whichever shape best fits the question, _not_ whichever is easiest to wire to
a page. Keep it pure: the module touches no DOM, no `document`, no button
handlers. The page calls into it; nothing flows the other direction. That is what
makes the prototype useful past its own lifetime: once the question's answered,
the validated reducer, machine or function set is a faithful starting point for
the fold-in rewrite (not a shortcut past the project's own checks).

### 3. Build the shareable HTML file

One file, plain HTML/CSS/JS, everything inline, so it opens by double-click and
survives being emailed around. Anyone can run it by opening it. With no code home,
it goes in the scratch folder (see SKILL.md, rule 1).

Write it for a non-developer. Every label is in **domain language**: buttons and
state read like the business, not the reducer. Explain in plain words what's
happening. Where the project has a glossary (see SKILL.md, Configuration), use its
terms.

Lay it out with a clean hierarchy, top to bottom:

1. **Title and one-line explanation** of what this demo lets you explore (the
   question from step 1).
2. **Current state**: the full relevant state, rendered as a readable panel of
   labelled fields (not a raw JSON dump), re-rendered after every click so the
   change is visible. Where it helps a non-developer follow, call out what just
   changed.
3. **Free-play buttons**: one button per action, always available, so anyone can
   poke at the model in any order. Each click dispatches its action and
   re-renders the state.
4. **Guided walkthroughs**: a set of **scenarios**, one per tab. Each tab holds a
   short plain-language description of the scenario (the situation it sets up and
   what to watch for) and, underneath it, the ordered **buttons to press**. Each
   step is a real button: clicking it performs that action and moves to the next
   step. Starting a walkthrough resets to a known initial state so the scenario
   runs the same way every time.

Choose scenarios that demonstrate the awkward cases, the ones hard to reason about
on paper: the happy path, a tricky edge case, an attempt at something that should
be illegal.

Keep it beautiful but restrained: clean typography, generous spacing, one accent
colour, and no animation or motion, so nothing competes with the state and the
buttons.

### 4. Hand it over

Send the file, or open it for the user. They'll click through the walkthroughs and
free-play whenever they get to it. The interesting moments are "wait, that
shouldn't be possible" or "huh, I assumed X would be different": those are the
bugs in the _idea_, which is the whole point. When they want new actions or a new
scenario, add them. Prototypes evolve.

### 5. Capture the answer and the prototype

Once the prototype has answered its question, record the answer, then keep the
prototype the way SKILL.md (Capture) describes. The logic-specific mapping: the
validated reducer, machine or function set becomes the starting point of the real
module's rewrite (the decision, absorbed); the HTML shell rides along to the
`proto/<slug>` branch that keeps the prototype as a primary source, and being one
self-contained file, it stays trivially re-runnable there.

## Holding the shape

- **Leave tests out.** A prototype that needs tests is no longer a prototype.
- **Keep state in memory**, unless the question is specifically about
  persistence.
- **Answer one question.** Build for the case in front of you, not for "what if we
  wanted to support X later".
- **Keep the page a thin shell over a pure module.** If the module references the
  DOM, `document`, or button handlers, it's no longer liftable.
- **Ship one file with no framework, bundler or server.** The recipient
  double-clicks it; a framework app or a dev server defeats "shareable".
- **Carry only the logic into production, and rewrite it there.** The page is
  optimised for being clicked through by hand; the module behind it is the bit
  worth keeping.
