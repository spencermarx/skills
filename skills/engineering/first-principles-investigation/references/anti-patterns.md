# Anti-patterns - the ways a careful investigation still fails

A first-principles investigation doesn't fail because you were lazy. It fails
because a plausible story felt _true_ one level too early, and you stopped. Each
entry below is a specific way that happens, the tell that you're in it, and the
concrete guard. Run this list at phase 8, and any time the investigation feels
suspiciously easy or stuck.

The unifying cause of every item here is the one Feynman named: _you fooled
yourself._ The guards are all forms of forcing external reality to check your
belief before you commit to it.

---

### Reasoning by analogy / cargo-culting

**Tell:** "This looks like that bug from last week." "We fixed something like this
by bumping the timeout." You're pattern-matching to a prior case instead of
deriving from _this_ system's evidence.

**Why it bites:** the analogy fails silently exactly when the two cases differ in
the dimension that matters - and you won't notice, because analogy doesn't surface
its own assumptions.

**Guard:** treat the prior case as a _hypothesis to test_, not a conclusion to
apply. What observation in _this_ system would confirm it's the same cause? Go get
that observation before acting.

---

### Confirmation bias

**Tell:** every test you ran "confirmed" your favored cause. You never designed the
experiment that could have proven it _wrong._

**Why it bites:** confirmatory evidence is nearly free - almost anything is
consistent with a vague enough hypothesis. Only disconfirming tests carry
information.

**Guard:** for your leading hypothesis, write its falsifier explicitly and go try
to _trip_ it. If you can't think of an observation that would kill the hypothesis,
the hypothesis is too vague to be useful - sharpen it until it's falsifiable.

---

### Anchoring / fixation

**Tell:** you formed a hypothesis in the first minute and every new piece of
evidence gets bent to fit it; contradicting data gets explained away rather than
weighed.

**Why it bites:** the first hypothesis gets undue weight simply for being first,
and each rationalization deepens the commitment.

**Guard:** hold **at least two** live hypotheses at all times (`references/the-loop.md`, phase 4).
When evidence contradicts the anchor, don't explain it away - let it _move
probability_ to a competitor. If you're down to one hypothesis by minute two,
you're anchored, not converged.

---

### Stopping at the symptom (not the root)

**Tell:** you found _a_ wrong value and called it the cause. But you didn't ask
what produced _that_ value.

**Why it bites:** the first bad state you find is usually an **infection** partway
down the chain (defect → infection → propagation → failure), not the **defect**
that started it. Fixing it masks the failure while the defect stays live and
resurfaces elsewhere.

**Guard:** for every bad value, ask "what wrote this?" and follow it upstream
until you reach code that is _itself_ wrong rather than merely passing along
someone else's wrong input. That's the root.

---

### Accepting an assumption as fact (ASSUME/KNOW collapse)

**Tell:** a step in your reasoning rests on "the docs say," "it should," "someone
mentioned," or "obviously" - and you never checked it.

**Why it bites:** the load-bearing assumption everyone treats as known is the
single most common hiding place for the actual bug.

**Guard:** the ledger (`references/the-loop.md` phase 1, `references/method.md`).
Before acting on any belief, check its column. If ASSUME, promote it to KNOW
with a cheap firsthand check, or delete it. Never act on ASSUME.

---

### Authority over evidence (HiPPO)

**Tell:** you're steering toward the cause the senior engineer suggested, or the
one the user asserted as fact, or the one the docs imply - because of _who/what_
said it, not because you verified it.

**Why it bites:** authority is a heuristic, and heuristics are wrong sometimes;
when the authority is wrong, deference propagates the error and suppresses the
evidence that would have caught it. For an agent, the user's confident assertion
is the most seductive version of this.

**Guard:** evidence outranks authority, always. A claim from a trusted source is
still a claim - put it in the ASSUME column and verify it independently when it's
load-bearing. You can be respectful and still check.

---

### Theorizing before looking

**Tell:** you've built an elaborate explanation (and maybe started coding a fix)
before you've actually observed the mechanism - you reasoned about what the code
_probably_ does instead of reading it or instrumenting it.

**Why it bites:** "it is a capital mistake to theorize before one has data"
(Agans rule 3). A theory unconstrained by observation drifts, and you end up
debugging your mental model instead of the system.

**Guard:** get data first. Read the actual source on the path; add the log line;
run the repro and watch. Use a guess only to decide _where to look_ - never as a
substitute for looking.

---

### Premature convergence

**Tell:** you committed to one cause before the space of causes was explored -
often because the first hypothesis was in a familiar category and you never
glanced at the others.

**Why it bites:** you can't rule out what you never enumerated. A cause in a
category you didn't consider will masquerade as "unexplained residue" or get
misattributed to your favored cause.

**Guard:** breadth before depth. Glance across the cause categories (Code, Config,
Data, Dependencies, Environment, Deploy, Human - `references/method.md`) before drilling, so
your live hypotheses aren't all clustered by habit. Converge only when one
hypothesis _uniquely_ survives and _predicts_ new observations.

---

### Correlation mistaken for causation

**Tell:** "the errors started right after the deploy, so the deploy caused it" -
stated as proof rather than as a lead.

**Why it bites:** co-occurrence has many explanations (a third common cause, a
coincidence, reverse causation). Time-alignment is a strong hint, not a
mechanism.

**Guard:** confirm by intervention - toggle the suspected cause and watch the
effect appear and disappear with it. If you can't intervene, find the natural
experiment that would break the claim (a time the cause was present without the
effect).

---

### The unproven fix

**Tell:** "I changed X and the error went away." But you changed X _and_ rebuilt
_and_ the flaky condition happened not to recur - so you don't actually know X did
it.

**Why it bites:** "if you didn't fix it, it ain't fixed" (Agans rule 9). Post hoc
disappearance is not proof of causation, especially for intermittent failures.

**Guard:** prove the fix by toggling. Revert X → failure returns. Re-apply X →
failure gone. If you genuinely can't reproduce reliably enough to toggle, say so
explicitly in the report - an unfalsifiable "fix" is a hypothesis, not a
conclusion.

---

### One more, specific to agents: bending the harness

**Tell:** the investigation is hard, and the tempting move is to make the _symptom_
go away - delete the failing assertion, loosen the check, remove the capability -
rather than find why it fails.

**Why it bites:** it converts an unsolved investigation into a hidden one. The
defect is still there; you've only removed the thing that was telling you about
it.

**Guard:** the failing signal is data, not an obstacle. Fix the cause it points
to. If a check is genuinely wrong, that itself is a finding to prove (why is the
check wrong?), not a nuisance to silence.
