#!/usr/bin/env bash
set -euo pipefail

old_product_name='Axo''nel'
matches="$(
  git grep -n -I -i -e "$old_product_name" -- .     | grep -vE 'github\.com/axonel/|raw\.githubusercontent\.com/axonel/|security@axonel\.dev'     || true
)"

if [[ -n "$matches" ]]; then
  echo "Found stale product-brand references:"
  printf '%s\n' "$matches"
  exit 1
fi

echo "Sentinel branding check passed."
