# Governance

## Today

Haat is maintained by Saurabh Pathak ([@techsaurabh-394](https://github.com/techsaurabh-394)), who has final say while the project is young. Decisions are made in public: in issues, pull requests and Discussions.

## Roles

- **Contributors**: anyone who opens an issue, PR or discussion.
- **Pack maintainers**: listed in a pack's `maintainers`; they review changes to that pack.
- **Maintainers**: can merge. After 5 merged, meaningful PRs and steady reviewing, a contributor can be invited (or ask) to become a maintainer. Maintainers are listed in `.github/CODEOWNERS`.

## Decisions

- Small changes: one maintainer approval.
- Changes to the approval gate, Session verification or Beckn signing: two approvals once there are two maintainers, and always a test.
- Big changes (new protocol versions, new runtime dependencies, licensing): an issue labelled `rfc`, open for at least 7 days.

## When the project grows

When there are three or more active maintainers, governance moves to simple majority voting among them, and this document will be updated through an RFC.
