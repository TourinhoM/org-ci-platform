#!/usr/bin/env node
/*
 * Renderer day-2 da plataforma: platform.yaml (intenção) -> conteúdo do gitops repo.
 *
 * Anti-drift: usa os MESMOS templates do scaffolder (platform-templates
 * _skeletons/gitops + _skeletons/capabilities), renderizados pelo MESMO engine
 * (nunjucks com os delimitadores do Backstage: ${{ }} variável, {% %} bloco).
 * Day-1 (Backstage) e day-2 (este CI) não podem divergir porque rendem do
 * mesmo arquivo — não há segunda implementação da forma pra sair de sincronia.
 *
 * Espelha exatamente o que os steps do scaffolder fazem:
 *   - fetch:template no skeleton (nunjucks) EXCETO .github/workflows/** (verbatim,
 *     copyWithoutTemplating: têm ${{ }} de GitHub Actions que colide com nunjucks).
 *   - fetch:plain do externalsecret (verbatim, preserva o {{ }} do ESO engine v2)
 *     + fs:replace dos placeholders __APP__/__ENV__.
 *
 * Propriedade do gitops repo: 100% escrito por máquina — kustomization, claims/
 * e o externalsecret são derivados da intenção (edição manual converge no
 * próximo render). Exceção: newTag (a promoção/ci-tag é dona) é PRESERVADO do
 * kustomization existente em vez de resetado pra latest.
 *
 * Uso: node render.js <platform.yaml> <skeleton-dir> <gitops-dir> [environment]
 *   skeleton-dir: dir que contém gitops/ e capabilities/ (templates/_skeletons).
 *   environment:  resolve __ENV__ do ExternalSecret (default dev; vira por-overlay no A3).
 * Requer: nunjucks e js-yaml resolvíveis a partir deste arquivo.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const nunjucks = require('nunjucks');

const [, , PLATFORM_FILE, SKELETON_DIR, GITOPS_DIR, ENVIRONMENT] = process.argv;
const environment = ENVIRONMENT || 'dev';

const fail = (msg) => { console.error(`::error::${msg}`); process.exit(1); };

// --- 1. Lê a intenção e aplica os defaults (overlay esparso) -----------------
// Campo presente substitui o default; ausente/null cai no default — nunca zera
// o gitops. É o que torna o contrato incrementável sem quebrar repo antigo.
let raw = {};
if (fs.existsSync(PLATFORM_FILE)) {
  raw = yaml.load(fs.readFileSync(PLATFORM_FILE, 'utf8')) || {};
} else {
  fail(`${PLATFORM_FILE} ausente — render abortado (o gate de contrato roda antes).`);
}
const pick = (key, def) => (raw[key] === undefined || raw[key] === null ? def : raw[key]);

if (!raw.name) fail('platform.yaml sem `name` (campo obrigatório do contrato).');

// Mapeia os nomes do contrato (platform.yaml) p/ os nomes que o skeleton espera
// (values.*) — o MESMO mapa que o step fetch-gitops do scaffolder usa.
const values = {
  name: raw.name,
  teamName: pick('team', '') || raw.name,   // vazio = deriva do name
  memLimit: pick('memory', '256Mi'),
  exposeHttp: pick('http', true),
  autoscaling: pick('autoscaling', false),
  connectDatabase: pick('database', false),
  newTag: 'latest',
};

// --- 2. Preserva o newTag promovido do kustomization existente ---------------
const ksDst = path.join(GITOPS_DIR, 'kustomization.yaml');
if (fs.existsSync(ksDst)) {
  try {
    const ks = yaml.load(fs.readFileSync(ksDst, 'utf8')) || {};
    const img = (ks.images || []).find((i) => i.name === 'app-image');
    if (img && img.newTag) values.newTag = img.newTag;
  } catch (_) { /* kustomization quebrado: o render sobrescreve com latest */ }
}

// --- 3. Engine nunjucks com os delimitadores do Backstage scaffolder ---------
const env = new nunjucks.Environment(null, {
  autoescape: false,
  throwOnUndefined: false,
  tags: {
    variableStart: '${{', variableEnd: '}}',
    blockStart: '{%', blockEnd: '%}',
    commentStart: '{#', commentEnd: '#}',
  },
});

// --- 4. Renderiza o skeleton/gitops no gitops repo ---------------------------
const SK_GITOPS = path.join(SKELETON_DIR, 'gitops');
if (!fs.existsSync(SK_GITOPS)) fail(`skeleton não encontrado em ${SK_GITOPS}`);

const isVerbatim = (rel) => rel.split(path.sep).join('/').startsWith('.github/workflows/');

const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(abs); continue; }
    const rel = path.relative(SK_GITOPS, abs);
    const dst = path.join(GITOPS_DIR, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const content = fs.readFileSync(abs, 'utf8');
    // .github/workflows/** verbatim (mesma razão do copyWithoutTemplating no day-1).
    fs.writeFileSync(dst, isVerbatim(rel) ? content : env.renderString(content, { values }));
  }
};
walk(SK_GITOPS);

// --- 5. Capability database: ExternalSecret (verbatim + placeholders) --------
// fetch:plain + fs:replace do day-1: NÃO passa por nunjucks (preserva o {{ }}
// do ESO). Day-2 é subtrativo: desligar o banco remove o ExternalSecret.
const esDst = path.join(GITOPS_DIR, 'externalsecret.yaml');
if (values.connectDatabase) {
  const esSrc = path.join(SKELETON_DIR, 'capabilities', 'database', 'externalsecret.yaml');
  if (!fs.existsSync(esSrc)) fail(`capability database não encontrada em ${esSrc}`);
  const es = fs.readFileSync(esSrc, 'utf8')
    .split('__APP__').join(values.name)
    .split('__ENV__').join(environment);
  fs.writeFileSync(esDst, es);
} else if (fs.existsSync(esDst)) {
  fs.unlinkSync(esDst);
}

console.log(
  `render ok: ${GITOPS_DIR} (env=${environment}, newTag preservado=${values.newTag}, database=${values.connectDatabase})`
);
