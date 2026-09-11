# Refresh Modes

## Purpose

Lets MCP callers choose how a query interacts with index catch-up — serve
immediately, wait for a bounded incremental refresh then re-search, or skip
async catch-up — and keeps long-lived sessions honest with a periodic
reconcile probe when file-watch events are missed.

## Requirements

### Requirement: Refresh mode parameter on query tools

`code_search`, `code_symbol`, and `code_impact` SHALL accept an optional
`refresh` parameter with values `"background" | "wait" | "off"`, defaulting to
`"background"`. The parameter SHALL NOT change ranking, match types, preview
modes, or the meaning of per-hit `freshness` and response `indexFreshness`.

#### Scenario: Default is background (today’s behavior)

- **WHEN** a client omits `refresh` on `code_search`
- **THEN** the tool serves immediately using the current index, marks freshness as today, and any watcher-triggered catch-up proceeds asynchronously

#### Scenario: Mode is accepted on all three query tools

- **WHEN** a client passes `refresh: "off"` to `code_search`, `code_symbol`, and `code_impact`
- **THEN** each tool accepts the parameter and does not initiate a catch-up reindex from that call

### Requirement: Wait refreshes then re-searches

When `refresh: "wait"` is set, the tool SHALL: allow the watcher debounce/settle
window to apply if events are pending; probe index drift; if dirty, submit an
**incremental** reindex through the shared serialized scheduler (never
`full`); await that run; then execute the original query against the refreshed
index. If the probe is clean, the tool SHALL run the query without submitting a
reindex. On success the response SHALL reflect post-refresh freshness marks.

#### Scenario: Dirty index waits then returns refreshed hits

- **WHEN** a file was edited after the last index and the client calls `code_search` with `refresh: "wait"`
- **THEN** the tool runs incremental catch-up before returning, and results include the edited symbol without a separate `code_index` call

#### Scenario: Clean index does not reindex

- **WHEN** the index has no drift and the client calls with `refresh: "wait"`
- **THEN** no reindex is submitted and the query returns immediately with `indexFreshness: "fresh"`

#### Scenario: Wait never issues a full reindex

- **WHEN** any number of `refresh: "wait"` calls observe a dirty index
- **THEN** only incremental mode is submitted to the scheduler

### Requirement: Wait timeout honesty

`refresh: "wait"` SHALL be bounded by a timeout. If catch-up does not complete
within the timeout, the tool SHALL return the current (pre-refresh or
mid-refresh) query results with honest `possibly_stale` marks rather than
blocking indefinitely or throwing away the query.

#### Scenario: Timeout returns stale-but-honest results

- **WHEN** `refresh: "wait"` is used and incremental catch-up exceeds the timeout
- **THEN** the client receives a normal tool result with `indexFreshness: "possibly_stale"` (and per-hit marks as determined), not an unbounded hang

### Requirement: Concurrent wait callers share one run

Multiple simultaneous `refresh: "wait"` (or watcher / `code_index`) triggers
SHALL serialize through the existing single reindex queue: at most one
indexing run is active; triggers during an active run coalesce into at most one
follow-up. Concurrent `wait` callers SHALL await the shared in-flight or
coalesced run rather than each forcing an additional sequential run.

#### Scenario: Two waiters coalesce into one follow-up

- **WHEN** a catch-up is active and two clients call with `refresh: "wait"`
- **THEN** at most one follow-up incremental run executes and both waiters re-search after that shared run completes

### Requirement: Refresh off skips async catch-up from the query

With `refresh: "off"`, the tool SHALL serve the current index without
submitting a reindex and without waiting. Freshness marks SHALL still report
per-hit and response-level truth.

#### Scenario: Off still marks staleness

- **WHEN** the index is dirty and the client calls with `refresh: "off"`
- **THEN** results return immediately and `indexFreshness` is `possibly_stale` when watcher/catch-up state indicates drift

### Requirement: Hourly reconcile on long-lived sessions

While a long-lived MCP session runs (stdio or HTTP serve), the process SHALL
periodically probe for drift on an hourly cadence. If the probe is clean, no
reindex runs. If dirty, the process SHALL submit an incremental reindex
through the shared scheduler. The timer SHALL stop on session shutdown.

#### Scenario: Missed watch events are reconciled without restart

- **WHEN** `fs.watch` missed edits for over an hour in a live serve process
- **THEN** the next reconcile probe detects drift and an incremental reindex runs without requiring a process restart

#### Scenario: Clean reconcile is a no-op

- **WHEN** the hourly probe finds no drift
- **THEN** no reindex is submitted and watcher status remains `idle`

#### Scenario: Shutdown stops the timer

- **WHEN** the session receives SIGINT / stop
- **THEN** the reconcile timer is cleared and no further probes run after shutdown
