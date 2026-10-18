#!/bin/sh
patterns=$(git config --local --get aireins.privatePatterns || :)
if [ -n "$patterns" ] && [ -f "$patterns" ]; then
  exec node scripts/check-privacy.mjs "$@" --patterns "$patterns"
fi
printf '%s\n' 'AIReins privacy warning: aireins.privatePatterns is unset or its file is missing; continuing with generic rules only.' >&2
exec node scripts/check-privacy.mjs "$@"
