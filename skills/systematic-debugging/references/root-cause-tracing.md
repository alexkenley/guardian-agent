# Root Cause Tracing

Use this when the visible error is far away from the real source.

## Backward Trace Pattern

1. Start at the failing line, response, or rendered output.
2. Identify the immediate bad value or missing state.
3. Find who passed that value in.
4. Repeat until you reach the first incorrect assumption, transformation, or missing guard.
5. Fix the origin, not every downstream symptom.

## What To Capture

- exact bad value
- where it was first observed
- where it should have been set correctly
- what component boundary changed or dropped it

## Common Failure Mode

The bug appears in component C, but the root cause is:

- invalid input from A
- a missing transform in B
- stale shared state between A and B
- an assumption mismatch across boundaries

Do not stop at C just because that is where the exception was thrown.
