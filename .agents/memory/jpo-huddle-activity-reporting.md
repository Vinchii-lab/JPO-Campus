---
name: JPO Huddle activity reporting
description: Privacy boundary for owner-visible participation reporting.
---

Activity reporting must remain aggregate-only: daily per-person active seconds, idle seconds, server-confirmed completed-action counts, and passive office coins. Do not retain raw input events, event details, precise per-person activity timestamps (including generic row update timestamps), or live active/idle status in owner reports.

**Why:** Even a generic `updated_at` field becomes precise behavioral timing telemetry when the row is updated by activity pulses. The report is intended to show broad participation context, not enable live monitoring or prove productivity.

**How to apply:** New activity features must fit into daily counters, stay owner-only, retain at most 30 days, and never affect rewards. Keep the visible disclosure explicit about included aggregates, excluded data, and the “not proof of productivity” limitation.