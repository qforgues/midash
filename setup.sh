#!/usr/bin/env bash
# ============================================================
# miDash — one-shot GitHub + Pages setup
# Run this once from inside the miDash folder:
#     cd ~/miDash && bash setup.sh
# Requires the GitHub CLI (gh). Install: https://cli.github.com
# ============================================================
set -e

REPO_NAME="${1:-midash}"     # pass a different name as the first arg if you like
VISIBILITY="public"          # GitHub Pages on free accounts needs a public repo

echo "→ miDash setup starting (repo: $REPO_NAME, $VISIBILITY)"

# 1. Make sure gh is installed and authenticated
if ! command -v gh >/dev/null 2>&1; then
  echo "✗ GitHub CLI 'gh' not found. Install it from https://cli.github.com then re-run."
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "→ Logging you into GitHub…"
  gh auth login
fi

# 2. Init git + first commit (safe to re-run)
[ -d .git ] || git init -b main
git add -A
git commit -m "miDash: initial dashboard" >/dev/null 2>&1 || echo "  (nothing new to commit)"

# 3. Create the repo on your account and push (creates remote if missing)
if git remote get-url origin >/dev/null 2>&1; then
  echo "→ Remote already set, pushing…"
  git push -u origin main
else
  gh repo create "$REPO_NAME" --"$VISIBILITY" --source=. --remote=origin --push
fi

# 4. Turn on GitHub Pages from the main branch root
USER=$(gh api user --jq .login)
echo "→ Enabling GitHub Pages…"
gh api -X POST "repos/$USER/$REPO_NAME/pages" \
  -f "source[branch]=main" -f "source[path]=/" >/dev/null 2>&1 \
  || gh api -X PUT "repos/$USER/$REPO_NAME/pages" \
       -f "source[branch]=main" -f "source[path]=/" >/dev/null 2>&1 \
  || echo "  (Pages may already be enabled — check repo Settings → Pages)"

echo ""
echo "✓ Done!"
echo "  Repo:  https://github.com/$USER/$REPO_NAME"
echo "  Site:  https://$USER.github.io/$REPO_NAME/  (live in ~1 min)"
echo ""
echo "Daily workflow from now on:"
echo "  edit index.html  →  git add -A && git commit -m 'update' && git push"
