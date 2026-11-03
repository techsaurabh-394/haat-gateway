# Publish the repository (for Saurabh)

Step by step, from this folder to a public repo with CI, labels and issues. Commands assume Git and the GitHub CLI (`gh`) are installed and you are logged in (`gh auth login`).

## 1. Check it locally first

```bash
cd haat-gateway
node --version            # must be 22.18 or newer
npm install
npm run check             # typecheck + lint + 126 tests
npm run demo              # approve with "y" and watch the whole flow
```

## 2. Create the repo and push

```bash
git init -b main
git add -A
git commit -m "Haat gateway v0.1: Poppy draft 0.3 gateway for ONDC"
gh repo create techsaurabh-394/haat-gateway --public --source . --push \
  --description "Let personal AI agents shop on India's open network (ONDC), only with your approval. Personal Agent Protocol gateway."
```

## 3. Repository settings (one time)

```bash
gh repo edit techsaurabh-394/haat-gateway \
  --enable-discussions --enable-issues \
  --add-topic personal-agent-protocol --add-topic ondc --add-topic beckn \
  --add-topic ai-agents --add-topic hinglish --add-topic india --add-topic typescript \
  --homepage "https://github.com/techsaurabh-394/haat-gateway#readme"
```

Then in the browser:

- **Settings → Code security**: enable private vulnerability reporting, Dependabot alerts, secret scanning with push protection, and CodeQL code scanning (choose "Default setup"; it needs no workflow file).
- **Settings → Rules → Rulesets → New branch ruleset** for `main`: require a pull request, require the `CI` status checks (`test (22.x)` and `test (24.x)`), and block force pushes.
- **Discussions**: create the categories Q&A, Ideas and Show and tell.
- Install the [all-contributors app](https://allcontributors.org/docs/en/bot/installation) so contributors are credited.

## 4. Labels and the 20 starter issues

```bash
scripts/github/create-labels.sh
scripts/github/create-issues.sh techsaurabh-394/haat-gateway --dry-run   # preview
scripts/github/create-issues.sh techsaurabh-394/haat-gateway
```

Create milestones `v0.2`, `v0.3` and `v0.4` (Issues → Milestones) and assign the issues to them, following ROADMAP.md.

## 5. First release

```bash
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
gh release create v0.1.0 --title "v0.1.0: works locally" --notes-file CHANGELOG.md
```

## 6. Before you announce

- Confirm CI is green on GitHub (it has not run there yet; it has only run in my environment).
- Pin the repository on your profile.
- Ask 3 to 5 people to try their first PR from the good first issues and tell you where they got stuck. Fix the docs before the launch post.
- See `docs/launch.md` for the launch checklist and post drafts.
