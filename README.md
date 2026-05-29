# org-ci-platform

Plataforma de CI/CD reutilizável para múltiplos repositórios. **Não contém código de aplicação** — apenas workflows callable e composite actions de responsabilidade única, consumidas por callers minimalistas no projeto final.

## Separação de responsabilidades

| Camada | Onde | Responsabilidade |
|--------|------|------------------|
| **Composite Actions** | `.github/actions/<nome>/` | Um passo lógico cada: scan, test, build, push, etc. |
| **Reusable Workflows** | `.github/workflows/ci-*.yml` | Orquestração por evento (PR, push, release, tag). |
| **Callers** | `.github/workflows/_caller-*.yml.example` | Templates mínimos pra colar no projeto consumidor. |

Cada action faz **uma coisa só**; cada workflow callable encadeia actions pra um evento específico.

---

## Modelo de pipeline: per-event

No GitHub cada workflow tem seu próprio gatilho (`on:`). Esta plataforma adota **um workflow callable por evento** e o projeto consumidor copia **um caller por evento** que precisa cobrir:

| Evento | Workflow callable | O que roda |
|--------|-------------------|------------|
| Pull Request → main | `ci-pr.yml` | Trivy FS · Secret Scan · Unit test → SonarQube → Semantic commit check |
| Push em branch (≠ main) | `ci-push.yml` | Trivy FS · Secret Scan · Trivy Config · Unit test → SonarQube → Docker build → Trivy image → Docker push |
| Push em main | `ci-release.yml` | Semantic Release (cria tag a partir de conventional commits) |
| Tag `v*` | `ci-tag.yml` | Trivy FS · Trivy Config → Docker build → Trivy image → Docker push → cosign sign · SBOM · SLSA |
| Repos GitOps (manifests k8s) | `lint-k8s.yml` | Schema (kubeconform) · Best-practices (kube-linter) · Misconfig (trivy-k8s) — todos sobre output do `kustomize build` |
| Repos GitOps (commit hygiene) | `commitlint.yml` | Conventional Commits validation em PR (wagoid/commitlint). Apps que usam `ci-pr.yml` já rodam essa checagem internamente — `commitlint.yml` standalone existe pra repos GitOps que não consomem `ci-pr.yml` |

> Optei por per-event no lugar de um workflow único decidindo por `if:` — fica mais explícito, evita árvore de condicionais misturando lógica de eventos diferentes, e cada arquivo de workflow tem responsabilidade única.

---

## Estrutura

```
.github/
  actions/
    trivy-fs/                # Scan filesystem (vuln + secret) + SARIF + Rego gate
    trivy-image/             # Scan imagem + SARIF + Rego gate
    trivy-config/            # Lint de Dockerfile (USER root, HEALTHCHECK, etc.) + Rego gate
    secret-scan/             # Gitleaks no historico git (defesa em profundidade)
    sonarqube/               # SonarCloud com sanitização de project key
    unit-test/               # Testes Node (npm test, publica coverage/lcov.info)
    unit-test-python/        # Testes Python (pytest, publica coverage.xml)
    docker-build-artifact/   # Build → tar → upload artifact (sem push)
    docker-push-artifact/    # Download artifact → load → push (emite digest)
    prepare-image-tag/       # Calcula repo + tag + push_tags a partir do evento
    cosign-sign/             # Assina imagem por digest (keyless), tlog adapta a visibilidade
    sbom-attest/             # Gera SBOM SPDX (syft) e attesta com cosign
    slsa-attest/             # Predicado SLSA v1 in-toto + cosign attest
    semantic-commit-check/   # commitlint pra conventional commits

    # Lint de manifests Kubernetes (repos GitOps)
    kustomize-prepare/       # Install kustomize + auto-discovery top-level
    kubeconform/             # Schema validation (k8s API + CRDs catalog datreeio)
    kube-linter/             # Best-practices (resources, probes, securityContext) + SARIF
    polaris/                 # Security/reliability/efficiency com per-resource exemption + Step Summary

    # Disponivel mas fora do lint-k8s.yml default — usar via caller custom.
    trivy-k8s/               # CIS + NSA misconfig em rendered Kustomize + Rego gate + SARIF

  workflows/
    ci-pr.yml
    ci-push.yml
    ci-release.yml
    ci-tag.yml
    lint-k8s.yml             # Lint k8s pra repos GitOps (zero-input, plug-and-play)
    commitlint.yml           # Conventional Commits standalone (pra repos sem ci-pr.yml)
    deploy-railway.yml       # WIP — implementacao planejada
    _caller-ci-pr.yml.example
    _caller-ci-push.yml.example
    _caller-ci-release.yml.example
    _caller-ci-tag.yml.example
    _caller-lint-k8s.yml.example
    _caller-commitlint.yml.example

templates/                   # Configs opcionais pro projeto consumidor
  .commitlintrc.json
  sonar-project.properties.example
  .releaserc.example
```

---

## Como usar

No projeto consumidor, copie os 4 callers de `.github/workflows/_caller-*.yml.example` pra `.github/workflows/` removendo o sufixo `.example`. Cada caller já tem `on:` correto e chama o workflow callable equivalente.

1. Copie `_caller-ci-pr.yml.example` → `.github/workflows/ci-pr.yml`
2. Copie `_caller-ci-push.yml.example` → `.github/workflows/ci-push.yml`
3. Copie `_caller-ci-release.yml.example` → `.github/workflows/ci-release.yml`
4. Copie `_caller-ci-tag.yml.example` → `.github/workflows/ci-tag.yml`
5. Configure secrets/vars no projeto (ver tabela abaixo)
6. (Opcional) Copie configs de `templates/` pra raiz do projeto

Os callers usam `${{ github.repository_owner }}` no `uses:`, então funcionam em usuário ou organização sem alteração — desde que o platform esteja sob o mesmo owner.

### Secrets e vars necessários no projeto consumidor

| Item | Tipo | Onde | Descrição |
|------|------|------|-----------|
| `SONAR_TOKEN` | secret | PR, Push | Token SonarCloud |
| `SONAR_ORG` | var | PR, Push | Organização SonarCloud |
| `SONAR_COVERAGE_EXCLUSIONS` | var | PR, Push (opcional) | Glob de paths excluídos da medição de cobertura. Configurar como repo var em `Settings → Secrets and variables → Actions → Variables → New repository variable`. Ex: **Name** = `SONAR_COVERAGE_EXCLUSIONS`, **Value** = `**/*.spec.ts,**/__tests__/**`. Se não setada, nada é excluído. |
| `RELEASE_APP_ID` | var | Release (opcional) | App ID do GitHub App usado pra push de tag |
| `RELEASE_APP_PRIVATE_KEY` | secret | Release (opcional) | Conteúdo do `.pem` do GitHub App |

Imagens vão pro **GHCR** usando `GITHUB_TOKEN` automaticamente — sem secret adicional. Nome da imagem é derivado de `${{ github.repository }}` (ex.: `ghcr.io/seu-user/seu-repo:<sha>` em branch, `:<tag>` + `:latest` em tag).

#### Por que `RELEASE_APP_*` é opcional mas recomendado

GitHub não dispara workflows a partir de eventos gerados pelo `GITHUB_TOKEN` (safety contra loops). Sem o GitHub App, semantic-release cria a tag mas o `ci-tag.yml` não roda. Com App ID + Private Key configurados, `ci-release.yml` gera install token efêmero via `actions/create-github-app-token` e empurra a tag com identidade do App — disparando `ci-tag.yml` normalmente.

Permissões mínimas do App: **Contents: Read & Write**, **Issues: Write**, **Pull requests: Write**, **Metadata: Read**.

---

## Lint K8s pra repos GitOps

Pipeline separado dos workflows de app CI — destinado a repos que carregam **manifests Kubernetes** (Argo CD, Helm rendered, Kustomize). Roda 3 scanners em paralelo, todos sobre o **output do `kustomize build`** (não sobre arquivos crus — patches strategic-merge fragmentam a verdade).

### Uso (plug-and-play, zero inputs)

Copia `_caller-lint-k8s.yml.example` → `.github/workflows/lint.yml` no repo consumer:

```yaml
name: Lint
on:
  push:
  schedule:
    - cron: '0 8 * * 1'   # pega drift do CRDs catalog
  workflow_dispatch:
jobs:
  lint:
    permissions:
      contents: read
      security-events: write
    uses: TourinhoM/org-ci-platform/.github/workflows/lint-k8s.yml@main
```

Sem `with:`. O workflow descobre tudo: encontra `kustomization.yaml` top-level, instala kustomize, renderiza, escaneia.

### O que cada scanner cobre

| Scanner | Action | Foco |
|---------|--------|------|
| **kubeconform** | `kubeconform` | Schema validation contra k8s API + CRDs catalog (datreeio) — pega campo errado, kind inválido |
| **kube-linter** | `kube-linter` | Best-practices (resources/limits, probes, securityContext, capabilities) — auto-detecta `.kube-linter.yaml` se existir |
| **polaris** | `polaris` | Security/reliability/efficiency (TLS, hostPort, image policies, PriorityClass, single replica, etc.) — gate em `danger`. Auto-detecta `polaris.yaml` se existir |

### Pipeline interna

```
kustomize-prepare    →    [3 scanners em paralelo]
(install + discover)      ├─ kubeconform (per-dir)
                          ├─ kube-linter (concat rendered.yaml)
                          └─ polaris (concat rendered.yaml)
```

`kustomize-prepare` é shared: instala o binário e auto-detecta entry points top-level. Os 3 scanners consomem os entry points renderizados.

### Escape hatches no repo consumer

| Arquivo | Quando criar |
|---------|--------------|
| `.kube-linter.yaml` | Customizar regras do kube-linter (auto-detectado) |
| `polaris.yaml` | Customizar checks do Polaris (desativar, mudar severidade, scoping por namespace) — auto-detectado |

Per-resource exemption sem precisar arquivo:

- **kube-linter:** annotation `ignore-check.kube-linter.io/<rule>: "<reason>"` no metadata do workload
- **polaris:** annotation `polaris.fairwinds.com/<check>-exempt: "true"` no metadata do workload (também aceita scope `polaris.fairwinds.com/exempt: true` pra exemptar todos os checks)

### Onde os findings aparecem

- **kube-linter** → SARIF na **Security tab** (se repo público) + resumo no **Step Summary**
- **polaris** → resumo no **Step Summary** com breakdown por severidade + top checks + tabela colapsável de detalhes (Polaris não tem SARIF nativo)
- **kubeconform** → output direto no log (schema findings tendem a ser raros e bloqueantes)

---

## Security posture

**Camadas de scan**, com gate apropriado por camada:

| Camada | Action | Gate | O que cobre |
|--------|--------|------|-------------|
| Filesystem | `trivy-fs` | HIGH/CRITICAL via Rego | Vulnerabilidades de libs + secrets no working tree |
| Container image | `trivy-image` | HIGH/CRITICAL via Rego | CVE no artefato antes do push |
| Dockerfile | `trivy-config` | HIGH/CRITICAL via Rego | Misconfig estática (USER root, HEALTHCHECK, etc.) |
| K8s manifests (best-practices) | `kube-linter` | qualquer finding | Resources, probes, securityContext, capabilities, etc. |
| K8s manifests (security/reliability) | `polaris` | severidade `danger` | TLS, hostPort, image pull policy, PriorityClass, single replica, etc. |
| Git history | `secret-scan` | qualquer secret encontrado | Gitleaks — credenciais leaked no histórico |

### Gate via OPA Rego

As actions de Trivy usam `--ignore-policy` com OPA Rego pra **separar visibilidade de enforcement**:

- **Display:** o log mostra todas severidades (UNKNOWN, LOW, MEDIUM, HIGH, CRITICAL).
- **Gate:** `policy.rego` filtra UNKNOWN/LOW/MEDIUM antes do `--exit-code` — pipeline falha apenas em **HIGH** e **CRITICAL**.

Por que via Rego: Trivy não tem flag separada pra "reportar tudo, falhar só em X" — o `--severity` filtra display E gate juntos. A policy desacopla os dois conceitos em uma única chamada.

Cada action carrega seu próprio `policy.rego`. Pra mudar a threshold, edite a policy ou forke a action.

### Supply chain

Actions third-party (Trivy, Sonar, Docker, Semantic Release, Commitlint, Gitleaks) pinned por **SHA do commit** com comentário `# vX.Y.Z` pra leitura humana. Mitigação contra tag rewrite ([tj-actions/changed-files em 2024](https://github.com/tj-actions/changed-files/issues/2463) é o caso canônico).

Dependabot (`.github/dependabot.yml`) bumpa SHA + comentário semanalmente.

### Image attestations (Sigstore keyless)

Em `ci-tag.yml`, depois do `docker-push`, o job `supply-chain` aplica três attestations sobre o **digest** da imagem:

| Action | Predicado | O que assina |
|--------|-----------|--------------|
| `cosign-sign` | (signature) | A própria imagem, prova de origem |
| `sbom-attest` | `spdxjson` | SBOM SPDX gerado pelo syft |
| `slsa-attest` | `slsaprovenance1` | Predicado SLSA v1 in-toto (workflow ref + commit + run) |

Todos usam **cosign keyless** (cert efêmero do Fulcio via OIDC do GitHub Actions, sem chave persistente).

#### Política de transparência adapta à visibilidade do repo

Detecção via `${{ github.event.repository.visibility }}`:

- **Repo público** → `cosign sign/attest` faz upload pro Rekor público. Auditável por terceiros via `rekor-cli search`.
- **Repo privado** → `--tlog-upload=false`. Assinatura/attestation ficam **só no GHCR junto à imagem**, sem metadados em log público.

#### Verificação

```bash
# Repo público — verificação completa com Rekor
cosign verify \
  --certificate-identity-regexp 'github.com/<owner>/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/<owner>/<repo>@sha256:<digest>

# Repo privado — sem prova de timestamp do Rekor
cosign verify --insecure-ignore-tlog \
  --certificate-identity-regexp 'github.com/<owner>/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/<owner>/<repo>@sha256:<digest>

# Baixar SBOM SPDX da attestation
cosign download attestation \
  --predicate-type https://spdx.dev/Document \
  ghcr.io/<owner>/<repo>@sha256:<digest>
```

> **Por que predicado SLSA manual em vez de `actions/attest-build-provenance@v1`:** a action oficial sempre publica no Rekor público, sem flag pra desativar. O caminho manual permite controlar a flag `--tlog-upload` por visibilidade. Em produção real, a única diferença seria trocar `cosign keyless` por `cosign sign --key awskms://...` (KMS) — arquitetura idêntica.

---

## Imagens e tags

`prepare-image-tag` (composite) calcula a partir do evento:

- **Push em branch:** `ghcr.io/<repo>:<sha>`
- **Push em tag:** `ghcr.io/<repo>:<tag>` + `ghcr.io/<repo>:latest`

Nome do repo é normalizado pra lowercase. Sem input de `image-name` — derivação automática a partir de `GITHUB_REPOSITORY`.

---

## Requisitos do projeto consumidor

- **Testes:** ou Node (`package.json` com script `test`) ou Python (`tests/` com pytest e coverage). Falha de teste quebra o pipeline.
- **Dockerfile:** na raiz do repo (ou caminho passado em `dockerfile-path`). Imagem é buildada como artifact e escaneada antes do push.
- **Conventional commits:** `ci-pr.yml` usa commitlint (falha o PR se commit não for conventional); `ci-release.yml` usa semantic-release pra criar tag automaticamente a partir de feat/fix/etc.
