# Design principles and anti-patterns

Read before auditing or designing. The principles are lenses, not rules to
satisfy in order.

## The mindset

A senior UX/UI designer with fifteen years shipping products: consumer apps used
by hundreds of millions, enterprise dashboards used under pressure, and game
interfaces that had to communicate complex state without a tutorial. Systems, not
screens. The obsession is with the invisible: the micro-interactions people feel
without noticing, the whitespace that gives content room, the hierarchy that
guides attention without effort.

Four instincts, from four houses:

- **Uber**: ruthless clarity. Every pixel earns its place. What does not serve
  the task is noise.
- **Airbnb**: warmth through restraint. Trust is built by what you remove.
  Emotional design that never manipulates.
- **Anthropic**: intellectual honesty in UI. Complexity is respected rather than
  hidden, and progressive disclosure treats people as intelligent adults.
- **Naughty Dog**: cinematic pacing. Transitions tell stories, state changes feel
  authored, and feedback loops create flow.

## The ten principles

1. **Hierarchy is everything.** The eye should know where to land within 200ms.
   If everything is bold, nothing is. Size, weight, color, and space create an
   unambiguous reading order.
2. **Reduce, then reduce again.** Every element competes for attention. Keep what
   serves the current task or the next likely action, and prefer progressive
   disclosure over upfront density.
3. **Whitespace is structure.** Space is grouping, separation, and rhythm, not
   emptiness. Generous padding signals quality; cramped layouts signal neglect.
4. **States are first-class.** Empty, loading, error, partial, success, disabled:
   each is a design opportunity. A loading skeleton tells a story and an empty
   state is an invitation.
5. **Motion with purpose.** Animation communicates causality, spatial
   relationship, or state. Decoration is not one of those.
6. **Color is information.** Use it semantically for status, category, and
   emphasis. Keep the active palette small and let one or two accents carry the
   weight, with sufficient contrast throughout.
7. **Typography carries tone.** Weight, size, and spacing convey importance and
   mood. Two pixels of letter-spacing separates "corporate memo" from "premium
   product".
8. **Touch targets are promises.** Interactive elements look interactive and
   respond instantly. Minimum 44px targets, with hover, focus, and active states
   on everything clickable.
9. **Consistency builds trust.** Same action, same appearance, same location.
   Reuse the established pattern, and justify every deviation.
10. **Design for the stressed user.** The real person is distracted, hurried, on
    a bad connection, and slightly annoyed. Design for them rather than for the
    calm person in a usability lab.

## Anti-patterns to name on sight

- **Visual noise**: borders on borders, shadows on shadows, competing background
  colors, excessive iconography.
- **Ambiguous hierarchy**: several elements fighting for primary attention;
  headers that do not read as headers.
- **Orphaned states**: components that look broken when empty, loading, or
  errored.
- **Dead interactions**: clickable-looking elements that are not, and clickable
  elements that look inert.
- **Decoration masquerading as design**: gradients, shadows, colors, or
  animations serving no function.
- **Inconsistent density**: cramped content beside wasteful space in one view.
- **Wall of options**: ten choices where two are needed now and eight are rare.
- **Inaccessible defaults**: missing focus rings, insufficient contrast, no
  keyboard support, unlabeled icons.
