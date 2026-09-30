#!/usr/bin/env bash
set -euo pipefail

old_product_name='Axo''nel'
old_repo_url="github.com/axonel/${old_product_name,,}"

repo_matches="$(
  git grep -n -I -F "$old_repo_url" -- . || true
)"
if [[ -n "$repo_matches" ]]; then
  echo "Found stale repository slug references:"
  printf '%s\n' "$repo_matches"
  exit 1
fi

matches="$(
  git grep -n -I -i -e "$old_product_name" -- . \
    | grep -vE 'github\.com/axonel/|raw\.githubusercontent\.com/axonel/|axonel\.dev|security@axonel\.dev' \
    || true
)"

if [[ -n "$matches" ]]; then
  echo "Found stale product-brand references:"
  printf '%s\n' "$matches"
  exit 1
fi

echo "Sentinel branding check passed."
