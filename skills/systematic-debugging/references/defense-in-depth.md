# Defense In Depth

Use this after identifying the root cause when the same class of failure could reappear at multiple boundaries.

## Pattern

1. Fix the origin of the problem.
2. Add validation or assertions at the next important boundary.
3. Add clear error reporting where bad state would otherwise be silent.
4. Keep the checks narrow and meaningful.

Do not use this as a substitute for root-cause work. Validation at multiple layers is useful after you understand the failure mode, not before.
