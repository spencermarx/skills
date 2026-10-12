# Interface design: the vocabulary of seams

Read this when the shape of the interface under test is itself in question. Use
these terms exactly; consistent language is the whole point.

## Terms

**Module**: anything with an interface and an implementation. Deliberately
scale-agnostic: a function, class, package, or tier-spanning slice.

**Interface**: everything a caller must know to use the module correctly: the
type signature, but also invariants, ordering constraints, error modes, required
configuration, and performance characteristics.

**Implementation**: what's inside a module, its body of code.

**Depth**: leverage at the interface. The amount of behaviour a caller (or
test) can exercise per unit of interface they have to learn. A module is
**deep** when a large amount of behaviour sits behind a small interface,
**shallow** when the interface is nearly as complex as the implementation.

**Seam** _(Michael Feathers)_: a place where you can alter behaviour without
editing in that place; the _location_ at which a module's interface lives. Where
to put the seam is its own design decision, distinct from what goes behind it.

**Adapter**: a concrete thing that satisfies an interface at a seam: the
production database client, or the in-memory fake a test uses.

**Leverage**: what callers get from depth. **Locality**: what maintainers get
from it: change, bugs and verification concentrate in one place.

## Deep versus shallow

```
Deep                              Shallow (avoid)
┌─────────────────────┐           ┌─────────────────────────────────┐
│   Small Interface   │           │       Large Interface           │
├─────────────────────┤           ├─────────────────────────────────┤
│                     │           │  Thin Implementation            │
│ Deep Implementation │           └─────────────────────────────────┘
│                     │
└─────────────────────┘
```

When designing an interface, ask: can I reduce the number of methods, simplify
the parameters, hide more complexity inside?

## Principles

- **The interface is the test surface.** Callers and tests cross the same seam.
  If you want to test _past_ the interface, the module is probably the wrong
  shape.
- **Depth is a property of the interface, not the implementation.** A deep
  module can be built from small, swappable parts; they just aren't part of its
  interface. Its internal seams serve its own tests and stay out of the
  interface.
- **One adapter means a hypothetical seam; two adapters mean a real one.** Don't
  introduce a seam unless something actually varies across it, typically
  production and test.
- **The deletion test.** Imagine deleting the module. If complexity vanishes, it
  was a pass-through. If it reappears across many callers, it was earning its
  keep.

## How a dependency is tested across its seam

| Dependency | Example | At the seam |
|---|---|---|
| In-process | pure computation, in-memory state | test through the interface directly; no adapter |
| Local stand-in exists | an embedded database, an in-memory filesystem | run the stand-in in the suite |
| Remote but owned | your own service across a network | a port at the seam; an in-memory adapter in tests |
| Truly external | a payment or messaging provider | an injected port; a mock adapter in tests ([mocking.md](mocking.md)) |

## Designing for testability

1. **Accept dependencies, don't create them.**

   ```typescript
   // Testable
   function processOrder(order, paymentGateway) {}

   // Hard to test
   function processOrder(order) {
     const gateway = new StripeGateway();
   }
   ```

2. **Return results, don't produce side effects.**

   ```typescript
   // Testable
   function calculateDiscount(cart): Discount {}

   // Hard to test
   function applyDiscount(cart): void {
     cart.total -= discount;
   }
   ```

3. **Small surface area.** Fewer methods mean fewer tests; fewer parameters mean
   simpler setup.
