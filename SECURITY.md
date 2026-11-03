# Security policy

Haat mediates purchases made by AI agents, so security reports are taken seriously.

## Reporting

Please **do not** open a public issue. Use GitHub's private vulnerability reporting (Security tab → "Report a vulnerability"), or email saurabhpathak394@gmail.com with "Haat security" in the subject.

Include what you found, how to reproduce it, and the impact. You'll get an acknowledgement within 72 hours. Fixes are released as soon as practical, and reporters are credited unless they prefer otherwise.

## Scope

In scope: Session verification, the approval gate (orders without approval, double orders, approval reuse), Beckn signature handling, SSRF, data leaks between Users.

Out of scope: the mock network in `mock-network/` (it is test scaffolding), and denial of service against a local development instance.

## Supported versions

Only the latest release on `main` receives fixes during v0.x.
