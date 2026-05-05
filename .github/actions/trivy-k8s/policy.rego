# Trivy ignore policy — gate de severidade pra config scan em manifests k8s.
#
# Mesma logica de trivy-fs/trivy-config: display reporta tudo, gate so falha em
# HIGH e CRITICAL. CIS Kubernetes Benchmark e NSA hardening guide tem MEDIUM
# em coisas tipo "imagePullPolicy: Always nao definido" — uteis pra ver, mas
# nao bloqueantes. Manifests k8s acumulam essas warnings rapido.

package trivy

default ignore = false

ignore_severities := {"UNKNOWN", "LOW", "MEDIUM"}

ignore {
	input.Severity == ignore_severities[_]
}
