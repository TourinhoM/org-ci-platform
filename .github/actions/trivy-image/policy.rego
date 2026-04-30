# Trivy ignore policy — gate de severidade do pipeline.
#
# Display: o relatório no log mostra TODAS as severidades (UNKNOWN..CRITICAL).
# Gate: apenas findings de HIGH e CRITICAL fazem o trivy-action retornar exit-code 1.
#
# Por que via Rego: o Trivy não tem flag separada pra "reportar tudo, falhar só em X".
# `--severity` controla display E gate juntos. Esta policy desacopla os dois conceitos
# usando `--ignore-policy`, que filtra findings ANTES da avaliação do exit-code.
#
# Referência: https://trivy.dev/latest/docs/configuration/filtering/#by-rego

package trivy

default ignore = false

ignore_severities := {"UNKNOWN", "LOW", "MEDIUM"}

ignore {
	input.Severity == ignore_severities[_]
}
