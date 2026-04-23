# Node Tester — Handoff

## WORKING ON (2026-04-23)
Wave A backend changes — Tasks 1-6

## Last Session Summary
Implementing Wave A backend changes per spec:
- Task 1: Fix subscription-plan status filter (STATUS_ACTIVE)
- Task 2: Pre-broadcast feegrant re-verification
- Task 3: RPC-first for 4 missing call sites
- Task 4: Batch-model public testing in continuous.js
- Task 5: Server-side mode gating (public|dev)
- Task 6: Security audit report

## Project State
- Port: 3001
- DB: data/audit.db (SQLite, migration v3 active)
- Key files: server.js, core/chain.js, core/constants.js, audit/continuous.js, audit/pipeline.js, core/db.js

## Known Context
- Chain returns "STATUS_ACTIVE" not "active" — filter at line 614 of chain.js drops all subs
- constants.js LCD_ENDPOINTS is missing lcd.sentinel.co (first entry per CLAUDE.md)
- continuous.js loops "iterations" — needs rework to explicit batch model
- queryFeeGrant in chain.js line 723 is LCD-only — needs RPC-first wrapper
