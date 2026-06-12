#!/usr/bin/env bash
# Renderer do Caminho A: service.yaml (intenção) -> conteúdo do gitops repo.
# A FORMA dos arquivos mora em templates/ (gomplate); este script só decide
# quais templates renderizar e injeta o que não vem da intenção.
#
# Contrato de propriedade: o gitops repo é 100% escrito por máquina —
# kustomization.yaml, claims/ e a cópia de service.yaml são sobrescritos sem
# dó (edição manual converge pra intenção no próximo render). newTag é a
# exceção: pertence ao fluxo de promoção (ci-tag), então é PRESERVADO do
# kustomization existente em vez de derivado da intenção.
#
# Uso: render.sh <service.yaml> <gitops-dir> <provenance>
#   provenance: "owner/repo@sha" do app repo que originou o render.
# Requer: yq (mikefarah) e gomplate no PATH.
set -euo pipefail

SERVICE_FILE="$1"
GITOPS_DIR="$2"
PROVENANCE="$3"
TEMPLATES="$(cd "$(dirname "$0")" && pwd)/templates"

export PROVENANCE

# newTag: do kustomization existente (a promoção é dona dele), senão latest.
NEW_TAG="latest"
if [ -f "$GITOPS_DIR/kustomization.yaml" ]; then
  existing=$(yq -r '(.images[] | select(.name == "app-image") | .newTag) // ""' \
    "$GITOPS_DIR/kustomization.yaml")
  [ -n "$existing" ] && NEW_TAG="$existing"
fi
export NEW_TAG

render() { # render <template> <destino>
  gomplate --context "svc=${SERVICE_FILE}" -f "$TEMPLATES/$1" -o "$2"
}

render kustomization.yaml.tmpl "$GITOPS_DIR/kustomization.yaml"

# claims/ é dir totalmente owned: capability removida da intenção = claim
# removida do repo (day-2 é aditivo E subtrativo).
mkdir -p "$GITOPS_DIR/claims"
generated="appnamespace.yaml"
render claim-appnamespace.yaml.tmpl "$GITOPS_DIR/claims/appnamespace.yaml"

for cap in $(yq -r '(.capabilities // []) | .[]' "$SERVICE_FILE"); do
  render "claim-app${cap}.yaml.tmpl" "$GITOPS_DIR/claims/app${cap}.yaml"
  generated="${generated} app${cap}.yaml"
done

for f in "$GITOPS_DIR"/claims/*.yaml; do
  base=$(basename "$f")
  case " $generated " in
    *" $base "*) ;;
    *) rm "$f" ;;
  esac
done

# Cópia da intenção como provenance: gitops repo auto-contido pra auditoria
# ("que intenção gerou isso?") sem depender do repo de app.
{
  echo "# GENERATED pelo gitops-render a partir de ${PROVENANCE} — NÃO EDITE."
  echo "# Fonte da verdade: o service.yaml do repo de aplicação."
  cat "$SERVICE_FILE"
} > "$GITOPS_DIR/service.yaml"

echo "render ok: ${GITOPS_DIR} (newTag preservado: ${NEW_TAG})"
