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
| Tag `v*` | `ci-tag.yml` | Trivy FS · Trivy Config → Docker build → Trivy image → Docker push (com `:latest`) |

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
    docker-push-artifact/    # Download artifact → load → push
    prepare-image-tag/       # Calcula repo + tag + push_tags a partir do evento
    semantic-commit-check/   # commitlint pra conventional commits

  workflows/
    ci-pr.yml
    ci-push.yml
    ci-release.yml
    ci-tag.yml
    deploy-railway.yml       # WIP — implementacao planejada
    _caller-ci-pr.yml.example
    _caller-ci-push.yml.example
    _caller-ci-release.yml.example
    _caller-ci-tag.yml.example

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
| `SONAR_COVERAGE_EXCLUSIONS` | var | PR (opcional) | Glob de paths excluídos do coverage |

Imagens vão pro **GHCR** usando `GITHUB_TOKEN` automaticamente — sem secret adicional. Nome da imagem é derivado de `${{ github.repository }}` (ex.: `ghcr.io/seu-user/seu-repo:<sha>` em branch, `:<tag>` + `:latest` em tag).

---

## Security posture

**Camadas de scan**, todas com gate em **HIGH/CRITICAL** e SARIF condicional ao Security tab (ativo quando repo público):

| Camada | Action | O que cobre |
|--------|--------|-------------|
| Filesystem | `trivy-fs` | Vulnerabilidades de libs + secrets no working tree |
| Container image | `trivy-image` | CVE no artefato antes do push |
| Dockerfile | `trivy-config` | Misconfig estática (USER root, HEALTHCHECK, etc.) |
| Git history | `secret-scan` | Gitleaks — credenciais leaked no histórico |

### Gate via OPA Rego

As actions de Trivy usam `--ignore-policy` com OPA Rego pra **separar visibilidade de enforcement**:

- **Display:** o log mostra todas severidades (UNKNOWN, LOW, MEDIUM, HIGH, CRITICAL).
- **Gate:** `policy.rego` filtra UNKNOWN/LOW/MEDIUM antes do `--exit-code` — pipeline falha apenas em **HIGH** e **CRITICAL**.

Por que via Rego: Trivy não tem flag separada pra "reportar tudo, falhar só em X" — o `--severity` filtra display E gate juntos. A policy desacopla os dois conceitos em uma única chamada.

Cada action carrega seu próprio `policy.rego`. Pra mudar a threshold, edite a policy ou forke a action.

### Supply chain

Actions third-party (Trivy, Sonar, Docker, Semantic Release, Commitlint, Gitleaks) pinned por **SHA do commit** com comentário `# vX.Y.Z` pra leitura humana. Mitigação contra tag rewrite ([tj-actions/changed-files em 2024](https://github.com/tj-actions/changed-files/issues/2463) é o caso canônico).

Dependabot (`.github/dependabot.yml`) bumpa SHA + comentário semanalmente.

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
