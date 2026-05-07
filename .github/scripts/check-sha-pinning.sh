#!/usr/bin/env bash
# Falha se algum `uses:` em .github/ apontar pra ref que nao e 40-char SHA.
#
# Excecoes:
#   - Auto-refs `TourinhoM/org-ci-platform/...` usam @main por design
#     (versao = branch sendo editado, nao adianta pinar SHA aqui).
#   - Local refs `./...` nao precisam de pin (mesmo repo, mesmo commit).
set -euo pipefail

ROOT="${1:-.github}"

# Coleta linhas `uses: <x>@<ref>` em .yml/.yaml dentro de workflows + actions.
# Filtra auto-refs e locais.
mapfile -t lines < <(grep -rEn --include='*.yml' --include='*.yaml' \
    '^[[:space:]]*-?[[:space:]]*uses:[[:space:]]+\S+@\S+' "$ROOT" \
  | grep -v 'TourinhoM/org-ci-platform' \
  | grep -vE 'uses:[[:space:]]+\./')

violations=0
for line in "${lines[@]}"; do
  ref="${line#*@}"
  ref="${ref%% *}"   # corta no primeiro espaco (antes de comentario)
  ref="${ref%%#*}"   # corta no #
  ref="${ref%%[[:space:]]*}"

  if ! [[ "$ref" =~ ^[0-9a-f]{40}$ ]]; then
    echo "::error::nao pinado por SHA: $line"
    violations=$((violations + 1))
  fi
done

if (( violations > 0 )); then
  echo ""
  echo "::error::$violations action(s) third-party nao pinada(s) por SHA de 40 chars."
  echo "Resolva via: git ls-remote --tags https://github.com/<org>/<repo>.git '<tag>*'"
  echo "Pin formato: uses: <org>/<repo>@<sha40> # <vX.Y.Z>"
  exit 1
fi

echo "OK: todas third-party actions pinadas por SHA."
