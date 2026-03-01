# org-ci-platform

Plataforma de CI/CD reutilizável para a organização. **Não contém código de aplicação** — apenas workflows (orquestradores) e **actions de responsabilidade única** para múltiplos repositórios (hoje projetos Python).

## Separação de responsabilidades

| Camada | Onde | Responsabilidade |
|--------|------|------------------|
| **Actions** | `.github/actions/<nome>/` | Um passo lógico cada: Trivy FS, testes, Sonar, Docker, etc. |
| **Workflows** | `.github/workflows/*.yml` | Só orquestração: quando rodar e em que ordem chamar as actions. |

Cada action faz **uma coisa só**; os workflows apenas as encadeiam. Assim você pode reutilizar uma action em outro workflow ou ajustar uma etapa sem mexer nas outras.

---

## Estrutura do repositório

```
.github/
  actions/                    # Responsabilidade única (composite actions)
    trivy-fs/                 # Scan filesystem Trivy + upload SARIF
    sonarqube/                # Scan SonarQube (coverage opcional)
    docker-build-push/        # Build e push da imagem
    trivy-image/              # Scan imagem com Trivy + upload SARIF
    semantic-commit-check/    # Commitlint (conventional commits)
  workflows/
    ci.yml                    # ★ Pipeline único – o projeto só chama este (como include no GitLab)
    ci-push.yml               # (opcional) Chamada separada para push
    ci-pr.yml                 # (opcional) Chamada separada para PR
    ci-tag.yml                # (opcional) Chamada separada para tag
    ci-semantic-release.yml   # (opcional) Só semantic release
    deploy-railway.yml        # Placeholder deploy Railway
    _caller-example.yml.example   # Exemplo mínimo para colar no projeto
templates/                    # Configs opcionais para copiar nos projetos
  .commitlintrc.json
  sonar-project.properties.example
  .releaserc.example
README.md
```

---

## Como usar

Toda a lógica de pipeline fica **neste repositório**. No projeto final você só tem um workflow que **chama** o pipeline único.

1. No seu projeto, crie `.github/workflows/ci.yml` com base em [.github/workflows/_caller-example.yml.example](.github/workflows/_caller-example.yml.example).
2. Deixe como está: o caller usa `${{ github.repository_owner }}` — se o projeto está no seu usuário (ex.: `seu-user/meu-app`), ele chama `seu-user/org-ci-platform`. Mesmo vale para org.
3. Configure no repositório do projeto os secrets: `DOCKER_USERNAME`, `DOCKER_PASSWORD`, `SONAR_TOKEN`.
4. (Opcional) Copie arquivos de `templates/` para o projeto.

O **caller** fica mínimo: um único job `ci` que chama `ci.yml` com `secrets: inherit`. Quem decide o que rodar (push vs PR vs tag) é o **ci-platform**, pelo evento, como no include do GitLab.

**Imagem Docker:** o pipeline já usa **tag dinâmica**: em push para branch usa `nome_do_repo:sha` (commit SHA); em push de tag usa `nome_do_repo:tag` (ex.: `v1.0.0`). Para o nome da imagem ser o nome do repositório, use no caller `image-name: ${{ github.repository }}` (ex.: `minha-org/meu-app`). Se o registry tiver outro usuário, use algo como `'dockerhub-user/meu-app'`.

**Secrets no seu repo**

| Secret | Onde | Descrição |
|--------|------|-----------|
| `DOCKER_USERNAME` | Push / Tag | Usuário Docker Hub (registry) |
| `DOCKER_PASSWORD` | Push / Tag | Senha ou token Docker Hub |
| `SONAR_TOKEN` | Push / PR | Token SonarQube/SonarCloud |
| `RAILWAY_TOKEN` | Deploy (futuro) | Token Railway |

---

## Pipelines (resumo)

- **Push (main):** Trivy FS → SonarQube → Docker build & push → Trivy image.
- **Pull Request:** SonarQube (PR) → Semantic commit check.
- **Merge em main (opcional):** Semantic Release (tag + release).
- **Tag (ex.: v*):** Docker build & push → Trivy image.
- **Deploy:** Placeholder Railway.

Os workflows rodam no **repositório que chama** (seu projeto); as actions são carregadas deste repositório (`ci-platform-repo`).

**GitLab vs GitHub:** No GitLab o projeto só faz `include:` de um arquivo remoto e os jobs vêm todos de lá. No GitHub o projeto precisa definir os **gatilhos** (`on: push`, `pull_request`, `tags`) no próprio repo, mas o **conteúdo** do pipeline (todos os jobs e steps) fica no ci-platform — o caller só dispara uma chamada ao `ci.yml` remoto. O efeito é o mesmo: estrutura grande no ci-platform, arquivo mínimo no projeto.

**Requisitos de lógica:** O projeto deve ter testes em `tests/` que gerem `coverage.xml`; falha de teste quebra o pipeline. Scan de imagem com Trivy faz login no registry antes do scan para imagens privadas (Docker Hub/registry).
