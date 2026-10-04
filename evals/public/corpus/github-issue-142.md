---
source: github
repo: acme/web-app
issue: 142
---
# Issue #142: Users are logged out randomly

Opened by dana-k. Assigned to omar-dev. Labels: bug, auth, launch-blocker.

## Description

Several users report being logged out while working. It happens more often for people with many tabs open.

## Comment by omar-dev

Root cause found: a race condition in token refresh. When two tabs refresh the access token at the same moment, the second refresh invalidates the first token and the first tab is logged out.

## Comment by omar-dev

Fix plan: serialize refreshes with a cross-tab lock using the BroadcastChannel API, and retry once with the newest token if a request fails with 401.

## Comment by dana-k

Please add a regression test before merging. This blocks the October launch.
