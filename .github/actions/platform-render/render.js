#!/usr/bin/env node
/*
 * Renderer day-2 da plataforma: platform.yaml (intenção) -> conteúdo do gitops repo.
 *
 * Anti-drift: usa os MESMOS templates do scaffolder (platform-templates
 * _skeletons/gitops), renderizados pelo MESMO engine (nunjucks com os
 * delimitadores do Backstage: ${{ }} variável, {% %} bloco). Day-1 (Backstage)
 * e day-2 (este CI) não podem divergir porque rendem do mesmo arquivo.
 *
 * Estrutura multi-ambiente: base/ + overlays/dev (ATIVO) + stages/{hml,prod}
 * (INERTES), com o ENV baked em cada um (claim <app>-<env>, Vault
 * databases/<env>/<app>). O ApplicationSet (git directories overlays/*) só sobe
 * o dev; hml/prod ficam de prontidão em stages/ até o Kargo promover (copy
 * stages/<env> -> overlays/<env>). O renderer só renderiza a árvore inteira —
 * não tem loop de env (os dirs SÃO o loop, desenrolado), simétrico com o day-1.
 *
 * Regras por arquivo (espelham os steps do scaffolder):
 *   - .github/workflows: NÃO mora no skeleton de render. O CI do gitops é
 *       provisionado no day-1 (bootstrap, via Backstage) porque o token do render
 *       (RELEASE_APP) não tem permissão `workflows`. A branch verbatim abaixo fica
 *       defensiva, mas no fluxo normal não há workflow pra renderizar aqui.
 *   - externalsecret.yaml dos overlays: verbatim + replace __APP__ (preserva o
 *       {{ }} do ESO; env já está baked). Day-2 subtrativo: database:false remove.
 *   - kustomization.yaml de overlay   -> nunjucks; o images.newTag é PRESERVADO do
 *       arquivo existente (a promoção/ci-tag é dona, por overlay).
 *   - resto                           -> nunjucks.
 *
 * Uso: node render.js <platform.yaml> <skeleton-dir> <gitops-dir>
 *   skeleton-dir: dir que contém gitops/ (templates/_skeletons).
 * Requer: nunjucks e js-yaml resolvíveis a partir deste arquivo.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const nunjucks = require('nunjucks');

const [, , PLATFORM_FILE, SKELETON_DIR, GITOPS_DIR] = process.argv;

const fail = (msg) => { console.error(`::error::${msg}`); process.exit(1); };

// --- 1. Lê a intenção e aplica os defaults DO CONTRATO -----------------------
// Os defaults NÃO moram mais aqui: vêm do schema.json (o contrato) — SoT único.
// O schema é uma sibling action no mesmo repo (service-definition-validate),
// sempre presente no checkout. Assim, adicionar/mudar um default é uma edição em
// UM lugar e o renderer herda — acabou a triplicação (schema × render × scaffolder).
// Sem ajv de propósito: leitura direta de properties[k].default (schema flat,
// draft-07) — zero dependência nova no renderer.
const SCHEMA_FILE = path.join(__dirname, '..', 'service-definition-validate', 'schema.json');
let schemaProps = {};
try {
  schemaProps = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8')).properties || {};
} catch (e) {
  fail(`schema.json do contrato ilegível em ${SCHEMA_FILE}: ${e.message}`);
}
const schemaDefault = (key) => (schemaProps[key] ? schemaProps[key].default : undefined);

let raw = {};
if (fs.existsSync(PLATFORM_FILE)) {
  raw = yaml.load(fs.readFileSync(PLATFORM_FILE, 'utf8')) || {};
} else {
  fail(`${PLATFORM_FILE} ausente — render abortado (o gate de contrato roda antes).`);
}
if (!raw.name) fail('platform.yaml sem `name` (campo obrigatório do contrato).');
// Overlay esparso: campo presente substitui; ausente cai no default DO SCHEMA.
const pick = (key) => (raw[key] === undefined || raw[key] === null ? schemaDefault(key) : raw[key]);

// health é o 1º campo ANINHADO do contrato. pick('health') devolve o objeto do
// platform.yaml ou, se ausente, o default-objeto do schema (ambas as chaves).
// Override esparso por sub-chave: se o dev declara só readiness, liveness ainda
// cai no default aninhado do schema — por isso o fallback explícito por chave.
const healthProps = (schemaProps.health && schemaProps.health.properties) || {};
const healthDefault = (k) => (healthProps[k] ? healthProps[k].default : undefined);
const health = pick('health') || {};

// Mapeia os nomes do contrato p/ os nomes que o skeleton espera (values.*). É só
// renomeação — os VALORES default vêm todos do schema lido acima.
const values = {
  name: raw.name,
  teamName: pick('team') || raw.name,   // default de team no schema é "" → vira name
  memLimit: pick('memory'),
  exposeHttp: pick('http'),
  autoscaling: pick('autoscaling'),
  connectDatabase: pick('database'),
  // Paths das probes → literais no app-config; o replacement do workload base
  // (platform-app-base) injeta nos httpGet.path do Deployment remoto.
  healthReadiness: health.readiness != null ? health.readiness : healthDefault('readiness'),
  healthLiveness: health.liveness != null ? health.liveness : healthDefault('liveness'),
};

// --- 2. Engine nunjucks com os delimitadores do Backstage scaffolder ---------
const env = new nunjucks.Environment(null, {
  autoescape: false,
  throwOnUndefined: false,
  tags: {
    variableStart: '${{', variableEnd: '}}',
    blockStart: '{%', blockEnd: '%}',
    commentStart: '{#', commentEnd: '#}',
  },
});

// --- 3. Renderiza a árvore do skeleton no gitops repo ------------------------
const SK_GITOPS = path.join(SKELETON_DIR, 'gitops');
if (!fs.existsSync(SK_GITOPS)) fail(`skeleton não encontrado em ${SK_GITOPS}`);

const mkWrite = (dst, content) => {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, content);
};

// newTag promovido do overlay existente (a promoção é dona; por overlay).
const preservedNewTag = (dst) => {
  if (!fs.existsSync(dst)) return 'latest';
  try {
    const ks = yaml.load(fs.readFileSync(dst, 'utf8')) || {};
    const img = (ks.images || []).find((i) => i.name === 'app-image');
    if (img && img.newTag) return img.newTag;
  } catch (_) { /* render sobrescreve com latest */ }
  return 'latest';
};

const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(abs); continue; }
    const rel = path.relative(SK_GITOPS, abs).split(path.sep).join('/');
    const dst = path.join(GITOPS_DIR, rel);
    const content = fs.readFileSync(abs, 'utf8');

    // .github/workflows/** verbatim (colisão ${{ }} Actions).
    if (rel.startsWith('.github/workflows/')) { mkWrite(dst, content); continue; }

    // {overlays,stages}/*/externalsecret.yaml: verbatim + __APP__; subtrativo se
    // db off. stages/ = overlays inertes de hml/prod (Kargo promove via copy);
    // o subtrativo vale pros dois pra db on/off ficar consistente entre envs.
    if (/^(overlays|stages)\/[^/]+\/externalsecret\.yaml$/.test(rel)) {
      if (values.connectDatabase) mkWrite(dst, content.split('__APP__').join(values.name));
      else if (fs.existsSync(dst)) fs.unlinkSync(dst);
      continue;
    }

    // {overlays,stages}/*/claims/appdatabase.yaml: claim de provisionamento (par
    // do externalsecret). nunjucks (sem colisão {{ }}); subtrativo se db off.
    if (/^(overlays|stages)\/[^/]+\/claims\/appdatabase\.yaml$/.test(rel)) {
      if (values.connectDatabase) mkWrite(dst, env.renderString(content, { values }));
      else if (fs.existsSync(dst)) fs.unlinkSync(dst);
      continue;
    }

    // resto: nunjucks. Em kustomization de overlay, preserva o newTag promovido.
    const ctx = { values: { ...values, newTag: preservedNewTag(dst) } };
    mkWrite(dst, env.renderString(content, ctx));
  }
};
walk(SK_GITOPS);

console.log(
  `render ok: ${GITOPS_DIR} (overlays/dev ativo + stages/{hml,prod}, database=${values.connectDatabase})`
);
