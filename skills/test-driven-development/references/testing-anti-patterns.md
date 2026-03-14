# Testing Anti-Patterns

Avoid these unless you have a concrete reason:

- tests that only verify a mock was called
- test-only branches or methods added to production code
- broad end-to-end tests where a unit or integration test would isolate the behavior better
- hidden setup in helpers that makes failures hard to read
- assertions that prove implementation details instead of user-visible behavior

Good tests explain the contract. Bad tests explain the current implementation.
