# Condition-Based Waiting

Use this when tests or integrations are flaky because of timing.

## Replace Timeouts With Conditions

Bad pattern:

- sleep 500 ms
- wait 2 seconds
- retry blindly with arbitrary delays

Better pattern:

1. Identify the condition that proves readiness.
2. Poll for that condition with a timeout.
3. Log what you are waiting for when the timeout expires.

## Examples Of Real Conditions

- an element exists and is visible
- a queue is empty
- a status becomes `completed`
- a record appears in storage
- a job count reaches the expected value

If you do not know the condition, you do not yet understand the system well enough to make the wait reliable.
