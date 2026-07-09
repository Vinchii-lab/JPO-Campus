#!/usr/bin/env bash
# Runs the load test as a Replit workflow (bash-tool sessions can't keep
# long-running children alive, workflows can). Params come from
# loadtest/run-params (one line of loadtest.mjs args); output goes to
# loadtest/results/run.log. After the run the script idles so the workflow
# stays "running" instead of re-triggering on restarts.
set -u
cd "$(dirname "$0")/.."
PARAMS=$(cat loadtest/run-params 2>/dev/null || echo "--n 10 --duration 20")
echo "[run-workflow] params: $PARAMS" > loadtest/results/run.log
node loadtest/loadtest.mjs $PARAMS >> loadtest/results/run.log 2>&1
echo "[run-workflow] done ec=$?" >> loadtest/results/run.log
sleep infinity
