# Trivy ignore policy — gate de severidade pra config scan (Dockerfile lint).
#
# Mesma logica de trivy-fs/trivy-image: display reporta tudo, gate so falha em
# HIGH e CRITICAL. Dockerfile geralmente acumula MEDIUM facil (ex.: HEALTHCHECK
# ausente), entao filtrar abaixo de HIGH evita bloquear pipeline em hygiene
# warnings que podem ser tratados depois.

package trivy

default ignore = false

ignore_severities := {"UNKNOWN", "LOW", "MEDIUM"}

ignore {
	input.Severity == ignore_severities[_]
}
