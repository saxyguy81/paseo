# Deterministic failure notifications

Paseo owns turn lifecycle events. The optional `PASEO_TURN_FAILURE_COMMAND` JSON argv
receives metadata on stdin through a durable outbox. Delivery retries do not run a
model. An operator's receiver may notify a Codex thread, whose later diagnosis is
separate from detection. No detector sends prompts, cancels work, or restarts a service.

## Detection and ownership

| Condition                                                                                       | Detector                            | Meaning                                                      |
| ----------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------ |
| Provider terminal failure, including system/model/authentication/quota/context/transport errors | Agent manager's `turn_failed` event | The turn failed after any provider-owned recovery            |
| Unexpected process exit, SIGTERM, or upstream abort                                             | Provider adapter and manager        | Not a user cancellation; notify                              |
| Synthetic API error followed only by SDK `success`                                              | Claude adapter                      | Preserve the error; bare success is not proof of recovery    |
| Retryable API failure before assistant, tool, permission, or subagent activity                  | Claude adapter and durable FIFO     | Retain the request and retry with capped exponential backoff |
| Failed child agent                                                                              | Live subagent descriptor transition | Child failure only; parent may remain healthy                |
| History request failure, hydration timeout, or contradictory empty tail                         | Client incident queue               | History/display failure, not evidence that execution failed  |
| Root render exception or failed queued-message admission                                        | Client incident queue               | Client failure, not permission to replay the message         |
| Sustained foreground disconnection                                                              | Client incident queue               | Retained locally and reported when connection returns        |

Client reporting uses the optional `server_info.features.diagnosticIncidents`
capability and `diagnostics.incident.report.request/response`. Reports contain a UUID,
an optional agent ID and a fixed category, never page contents, raw errors or prompts.
The client keeps a bounded, seven-day queue (64 records), coalesces a category per
agent for five minutes, and retains unacknowledged reports across reloads. The daemon
also coalesces repeated client categories for five minutes. Subagent failures use
their own identities so separate failed children do not suppress each other.

Every Claude runtime creates a unique turn epoch. Recreating a runtime cannot reuse
`autonomous-turn-1` and accidentally deduplicate a new failure. Starting a request
after an unacknowledged interrupt retires the interrupted query first; its trailing
result cannot be confused with the new request's result. Explicit user cancellations,
controlled shutdown, stale query frames and read-only history are not failures.

The Claude adapter first makes its bounded same-session recovery attempt. If an eligible
408, 5xx, timeout, or connection failure still ends the turn before any work begins, the agent
manager returns the original FIFO item to `queued` instead of deleting it. It then sends a hidden
continuation after 30 seconds, doubles the delay after each failed attempt, and caps the interval
at five minutes. The durable item survives daemon restarts. Authentication, quota, model-access,
context-overflow, cancellation, and any failure after observable work are never replayed through
this path.

## Reconciliation outside Paseo

The companion `claude-env/scripts/paseo-failure-watch.mjs` runs as a separate
five-minute LaunchAgent on the Mini. It checks canonical native transcripts, durable
prompt queues, daemon health, CCProxy, Headroom and public ingress. A second watcher
on the M2 checks Mini reachability and ingress, so a stopped Mini cannot hide its own
outage. Episodes require two observations at least five minutes apart, survive
watcher restarts, and are delivered through the same outbox implementation. Existing
daemon incidents suppress duplicate reconciliation notifications.

An idle latest human request without a later clean completion is unfinished, not
complete just because attention was cleared. An unanswered AskUserQuestion or
permission request remains a legitimate user wait. An idle pending queue is stranded.
A running conversation without transcript progress for 45 minutes is a **suspected
stall**, not a proven failure. Investigation must check long-running external jobs
before taking action.

## Limits and verification

This is failure coverage, not proof that every possible UI defect can be recognized.
An arbitrary wrong-looking but internally consistent page, a browser killed before
it saves a report, or both machines being offline cannot generate an immediate
notification. Cloudflare login expiry can delay client delivery until reconnect.
Notifications may remain queued while the Codex app is unavailable.

Focused verification includes adapter error/cancellation contracts, distinct
runtime identities, client offline/reload replay, and a real isolated WebSocket
request through daemon persistence to an executable receiver. The companion watcher
test exercises native JSONL through two observations and a real executable delivery.
Normal completed turns, read-only predecessors, user waits and transient disconnects
are negative cases. Do not run the repository's full test suite for this feature.
