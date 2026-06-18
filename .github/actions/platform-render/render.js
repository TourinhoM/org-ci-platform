#!/usr/bin/env node
/*
 * Renderer day-2 da plataforma: platform.yaml (intenção) -> conteúdo do gitops repo.
 *
 * Anti-drift: usa os MESMOS templates do scaffolder (platform-templates
 * _skeletons/gitops), renderizados pelo MESMO engine (nunjucks com os
 * delimitadores do Backstage: ${{ }} variável, {% %} bloco). Day-1 (Backstage)
 * e day-2 (este CI) não podem divergir porque rendem do mesmo arquivo.
 *
 * Estrutura multi-ambiente (A3): o skeleton já traz base/ + overlays/{dev,hml,prod}
 * com o ENV baked em cada overlay (claim <app>-<env>, Vault databases/<env>/<app>).
 * O renderer só renderiza a árvore inteira — não tem loop de env (os 3 dirs SÃO
 * o loop, desenrolado), o que o mantém burro e simétrico com o day-1.
 *
 * Regras por arquivo (espelham os steps do scaffolder):
 *   - .github/workflows (verbatim — têm ${{ }} de GitHub Actions).
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

// --- 1. Lê a intenção e aplica os defaults (overlay esparso) -----------------
let raw = {};
if (fs.existsSync(PLATFORM_FILE)) {
  raw = yaml.load(fs.readFileSync(PLATFORM_FILE, 'utf8')) || {};
} else {
  fail(`${PLATFORM_FILE} ausente — render abortado (o gate de contrato roda antes).`);
}
const pick = (key, def) => (raw[key] === undefined || raw[key] === null ? def : raw[key]);
if (!raw.name) fail('platform.yaml sem `name` (campo obrigatório do contrato).');

// Mapeia os nomes do contrato p/ os nomes que o skeleton espera (values.*) — o
// MESMO mapa que o fetch-gitops do scaffolder usa.
const values = {
  name: raw.name,
  teamName: pick('team', '') || raw.name,
  memLimit: pick('memory', '256Mi'),
  exposeHttp: pick('http', true),
  // defaults TÊM que bater 1:1 com schema.json (contrato) e com as constantes do
  // day-1 (scaffolder fetch-gitops): tudo on (http+autoscaling), banco off.
  autoscaling: pick('autoscaling', true),
  connectDatabase: pick('database', false),
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

    // overlays/*/externalsecret.yaml: verbatim + __APP__; subtrativo se db off.
    if (/^overlays\/[^/]+\/externalsecret\.yaml$/.test(rel)) {
      if (values.connectDatabase) mkWrite(dst, content.split('__APP__').join(values.name));
      else if (fs.existsSync(dst)) fs.unlinkSync(dst);
      continue;
    }

    // overlays/*/claims/appdatabase.yaml: claim de provisionamento (par do
    // externalsecret). nunjucks (sem colisão {{ }}); subtrativo se db off.
    if (/^overlays\/[^/]+\/claims\/appdatabase\.yaml$/.test(rel)) {
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
  `render ok: ${GITOPS_DIR} (overlays dev/hml/prod, database=${values.connectDatabase})`
);
