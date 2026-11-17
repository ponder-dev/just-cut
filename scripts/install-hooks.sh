#!/bin/sh
#
# Puts the hooks in scripts/hooks into this checkout.
#
#   ./scripts/install-hooks.sh
#
# Git does not track hooks, so a clone arrives with none and this is run once
# per checkout. It only ever adds; an existing hook of the same name is left
# alone and reported, because overwriting somebody's own hook is not this
# script's business.

set -e

root=$(git rev-parse --show-toplevel)
into=$(git rev-parse --git-path hooks)
from="$root/scripts/hooks"

mkdir -p "$into"

for hook in "$from"/*; do
  name=$(basename "$hook")
  if [ -e "$into/$name" ]; then
    echo "  $name is already there, left alone"
    continue
  fi
  cp "$hook" "$into/$name"
  chmod +x "$into/$name"
  echo "  $name installed"
done
