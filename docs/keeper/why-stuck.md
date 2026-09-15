# Why a run is stuck or failed

Keywords: stuck, failed, why, not progressing, error, broken, hang, blocked

Open the workflow run and ask the Keeper about it, or read its step detail. The usual causes, in order:

1. **Waiting for approval**: see Approvals.
2. **Paused**: resume it.
3. **An emergency stop** at some scope.
4. **A model or tool call in flight**: each Claude call is time-bounded; the run continues when it returns.
5. **Failed**: the failing invocation shows its reason and error code: a Policy denial, a budget refusal, a rejected or expired approval, a provider error, or an invalid output.

Retries: a failed model call of unknown consumption, or an invalid output, is retried automatically up to two more times for ordinary steps. Autonomous objectives are not retried.
