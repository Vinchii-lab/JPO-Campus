---
name: Running long processes from the agent
description: Bash tool sessions can't keep long-running/background children alive — use a temporary workflow instead.
---

The rule: **any process that must outlive a single bash call (long test runs, detached servers, background jobs) must run as a Replit workflow, not from the bash tool.**

**Why:** Observed in this workspace (2 vCPUs): when a bash call completes normally, its whole process group is killed — `&`, `nohup`, `setsid`, and code_execution-spawned children all die (the code_execution notebook itself gets recycled too). Long foreground runs are also unreliable: calls sometimes die at the tool timeout with ALL output discarded (exit -1). `/tmp` is per-call — write logs into the workspace.

**How to apply:** Write params to a small file, configure a temporary console workflow running a wrapper script (`node run.mjs > results/run.log 2>&1; sleep infinity` — the sleep keeps it from re-running on restarts), `restart_workflow` per run, poll the workspace log file with short bash calls, and **remove the workflow when done** so it doesn't re-run on repl boot. Working example: `artifacts/jpo-huddle/loadtest/run-workflow.sh`.
