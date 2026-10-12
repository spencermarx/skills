# Option pickers - structured-question mechanics

The contract in `SKILL.md` governs the content; this covers the shape. Many
harnesses give you a structured-question tool: a picker with a short header, a
few labelled options, a description under each, and sometimes a preview pane.
Its fields are tiny, which is exactly why they invite codenames - a 12-character
header and a 5-word label crush a real trade-off into jargon unless you fight
for the words. Where your harness has no picker, the same rules govern a
numbered list in plain text.

## The fields

- **header** - at most 12 characters of plain topic words the reader recognizes
  cold ("Flag gating", "Agent powers"). Never session-internal structure
  ("Flow 2: seal", "Enum residue").
- **option label** - the plain choice in 1–5 words: what the reader is actually
  picking ("Humans only", "Owner-only claims"). Five words is a ceiling, not a
  suggestion - count them, and compress by dropping connectives and articles
  ("Cache a day, refresh in background" → "Daily cache, background refresh"),
  never by reverting to a codename. A label that needs its description as a
  decoder ring ("Fold into god-mode", "Human parity: sealed") fails on sight.
- **option description** - the consequence of choosing it, in one to three plain
  sentences. Not a paragraph, not the label's definition, not the history of how
  you got here.
- **preview** - when options genuinely trade off, put the comparison there (a
  compact table, or the concrete artifact) instead of inflating every
  description.

## The recommendation marker

Pickers commonly have no "recommended" field, so a `(Recommended)` label suffix
is the _only_ highlight the reader sees. The marker must faithfully track your
actual lean - **mark exactly the options you would genuinely pick**, never fake
one and never drop a real one:

1. **One clear lean** (a grilling question usually has one) - put it first, end
   its label with "(Recommended)", and justify it in its description by
   consequence. The description carries the _why_; the suffix carries the
   _highlight_, and only the suffix highlights. If your description argues _for_
   an option, that **is** a lean: mark it.
2. **No clear lean** (a genuinely balanced trade-off that is the reader's call) -
   mark nothing, but **say so in the question**: e.g. "I don't have a strong lean
   here - the trade-off is genuinely yours." Naming the neutrality out loud is
   what makes the absence legible rather than ambiguous.
3. **Several good options** - depends on the select mode. Single-select still
   forces one choice: mark the one you'd default to and name the close runner-up
   in its description. Multi-select genuinely admits a set: mark each option you
   would pick with "(Recommended)". If instead it's "any of these is fine, choose
   by taste", that is case 2 - present neutrally and say so.

The suffix does not count toward the five-word label budget, but keep the rest of
the label brief so the marker is never crowded out.

## One rewrite, from a real failure

**Before** (drew "I'm not fully understanding the question/options"):
header `Flow 2: seal`; label `Fold into god-mode`; question opening
"Surprise 4 (#131): `app.has_permission_in_any_org` is a parallel,
short-circuit-EXCLUDING resolver gating the org-less provisioning acts…"

**After:** header `Agent powers`; question "One agent permission mirrors a human
super-admin's reach across every organization. Should an agent holding it also be
able to enroll new agents and change other agents' permissions, or is that
reserved for humans?" - one sentence of shared context, then the ask; options:
`Humans only (Recommended)` - "Agents can never create or re-scope agents; every
new grant passes through a person. Closes off an agent replicating itself." /
`Match human admins` - "An agent holding the full platform grant can enroll and
re-scope agents exactly as a human super-admin can. Accepts machine
self-replication on the trusted lane."

Same decision, same rigor - grounded vocabulary, context then a visible ask,
choices a reader can weigh unaided.
