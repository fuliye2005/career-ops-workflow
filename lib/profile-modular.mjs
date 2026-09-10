import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import yaml from 'js-yaml';

const ITEM_TYPES = new Set(['skill', 'experience', 'project', 'education', 'preference']);
const PROFILE_DIRS = [
  ['skills', 'skill'],
  ['experience', 'experience'],
  ['projects', 'project'],
  ['education', 'education'],
  ['preferences', 'preference'],
];

function text(value, fallback = '') {
  return value === undefined || value === null ? fallback : String(value).trim();
}

function list(value) {
  if (Array.isArray(value)) return value.map(item => text(item)).filter(Boolean);
  return text(value).split(/[,，、|]/).map(item => item.trim()).filter(Boolean);
}

function familiarity(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return { value: 3, needsReview: true };
  return { value: Math.min(5, Math.max(1, Math.round(numeric))), needsReview: false };
}

function parseYaml(source, filePath) {
  try {
    return yaml.load(source) || {};
  } catch (error) {
    throw new Error(`无法读取模块化资料 ${filePath}: ${error.message}`);
  }
}

function normalizeItem(raw, container, index) {
  const score = familiarity(raw?.familiarity ?? raw?.priority);
  return {
    id: text(raw?.id, `${container.id}-${index + 1}`),
    type: container.type,
    containerId: container.id,
    containerTitle: container.title,
    title: text(raw?.title ?? raw?.name, container.title),
    content: text(raw?.content ?? raw?.text ?? raw?.description ?? raw?.summary),
    familiarity: score.value,
    needsReview: score.needsReview || raw?.needs_review === true || raw?.needsReview === true,
    evidenceLevel: text(raw?.evidence_level ?? raw?.evidenceLevel, 'confirmed'),
    roleTags: list(raw?.role_tags ?? raw?.roleTags),
    domainTags: list(raw?.domain_tags ?? raw?.domainTags ?? raw?.tags),
    jdKeywords: list(raw?.jd_keywords ?? raw?.jdKeywords),
    includeInCv: raw?.include_in_cv !== false && raw?.includeInCv !== false,
    order: Number.isFinite(Number(raw?.order)) ? Number(raw.order) : index,
  };
}

function normalizeContainer(raw, filePath, typeHint) {
  const type = ITEM_TYPES.has(raw?.type) ? raw.type : typeHint;
  const id = text(raw?.id, basename(filePath, extname(filePath)));
  const title = text(raw?.title ?? raw?.name, id);
  let rawItems = Array.isArray(raw?.items) ? raw.items : [];
  if (!rawItems.length && (raw?.content || raw?.text || raw?.description || raw?.summary)) rawItems = [raw];
  return {
    id,
    type,
    title,
    organization: text(raw?.organization ?? raw?.company),
    period: text(raw?.period ?? raw?.date),
    tags: list(raw?.tags ?? raw?.domain_tags),
    source: filePath,
    items: rawItems.map((item, index) => normalizeItem(item, { id, type, title }, index)),
  };
}

async function yamlFiles(dir) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && ['.yml', '.yaml'].includes(extname(entry.name).toLowerCase()))
    .map(entry => join(dir, entry.name));
}

function keywords(value) {
  const source = text(value).toLowerCase();
  const english = source.match(/[a-z][a-z0-9+#./-]{1,}/g) || [];
  const chinese = source.match(/[\u4e00-\u9fff]{2,}/g) || [];
  return [...new Set([...english, ...chinese])];
}

function jdMatch(item, jdText) {
  const jd = text(jdText).toLowerCase();
  if (!jd) return 0;
  const terms = [...new Set([
    ...item.jdKeywords,
    ...item.roleTags,
    ...item.domainTags,
    ...keywords(item.content),
    ...keywords(item.title),
  ].map(term => term.toLowerCase()).filter(term => term.length >= 2))];
  if (!terms.length) return 0;
  const hits = terms.filter(term => jd.includes(term));
  const ratio = hits.length / terms.length;
  const score = Math.min(5, ratio * 5 + (hits.length >= 2 ? 0.5 : 0));
  return Math.round(score * 10) / 10;
}

function phrasing(familiarityScore) {
  if (familiarityScore >= 5) return '负责、设计、推动';
  if (familiarityScore >= 4) return '参与、完成';
  if (familiarityScore >= 2) return '协助、验证、基础使用';
  return '接触、了解';
}

export async function loadModularProfile(root) {
  const profileRoot = join(root, 'workflow-input', 'profile');
  const configPath = join(profileRoot, 'profile.yml');
  const config = existsSync(configPath) ? parseYaml(await readFile(configPath, 'utf8'), configPath) : {};
  const containers = [];
  for (const [directory, type] of PROFILE_DIRS) {
    for (const filePath of await yamlFiles(join(profileRoot, directory))) {
      containers.push(normalizeContainer(parseYaml(await readFile(filePath, 'utf8'), filePath), filePath, type));
    }
  }
  if (!containers.length && !existsSync(configPath)) return null;
  return { version: 1, root: profileRoot, config, containers, items: containers.flatMap(container => container.items), hasItems: containers.some(container => container.items.length) };
}

export function rankProfileItems(profile, jdText) {
  return (profile?.items || [])
    .filter(item => item.includeInCv)
    .map(item => {
      const match = jdMatch(item, jdText);
      const composite = Math.round((item.familiarity * 0.4 + match * 0.6) * 100) / 100;
      return { ...item, jdMatch: match, composite, phrasing: phrasing(item.familiarity) };
    })
    .sort((a, b) => b.composite - a.composite || b.jdMatch - a.jdMatch || b.familiarity - a.familiarity || a.order - b.order);
}

export function profileSummary(profile, jdText = '') {
  const items = rankProfileItems(profile, jdText);
  return {
    weights: { familiarity: 0.4, jdMatch: 0.6 },
    total: items.length,
    needsReview: items.filter(item => item.needsReview).map(item => item.id),
    items,
    selectedItems: selectProfileItems(items),
  };
}

export function selectProfileItems(rankedItems, quotas = {}) {
  const defaults = { skill: 8, experience: 6, project: 6, education: 3, preference: 3 };
  const limits = { ...defaults, ...quotas };
  const selected = [];
  for (const type of Object.keys(defaults)) {
    selected.push(...rankedItems.filter(item => item.type === type).slice(0, Math.max(0, Number(limits[type]) || 0)));
  }
  return selected.sort((a, b) => b.composite - a.composite || b.jdMatch - a.jdMatch || a.order - b.order);
}

export function renderLegacyProfile(profile) {
  const lines = ['# 个人信息', ''];
  const identity = profile?.config?.identity || profile?.config?.contact || {};
  if (Object.keys(identity).length) {
    lines.push('## 基本信息', '');
    for (const [key, value] of Object.entries(identity)) lines.push(`- ${key}: ${text(value)}`);
    lines.push('');
  }
  if (profile?.config?.summary) lines.push('## 个人简介', '', text(profile.config.summary), '');
  const headings = [['skill', '核心能力'], ['experience', '工作经历'], ['project', '项目经历'], ['education', '教育背景'], ['preference', '求职偏好']];
  for (const [type, heading] of headings) {
    const groups = (profile?.containers || []).filter(container => container.type === type);
    if (!groups.length) continue;
    lines.push(`## ${heading}`, '');
    for (const group of groups) {
      lines.push(`### ${group.title}`);
      if (group.organization || group.period) lines.push([group.organization, group.period].filter(Boolean).join(' | '));
      for (const item of [...group.items].sort((a, b) => a.order - b.order)) {
        if (!item.content) continue;
        lines.push(`- ${item.title}: ${item.content}`);
      }
      lines.push('');
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

export async function syncLegacyProfile(profile, legacyPath) {
  if (!profile?.hasItems) return { path: legacyPath, written: false };
  const existing = existsSync(legacyPath) ? await readFile(legacyPath, 'utf8') : '';
  const placeholder = !existing.trim() || /请将本文件替换|请填写|replace this file|待填写|placeholder/i.test(existing);
  if (!placeholder) return { path: legacyPath, written: false, preserved: true };
  await mkdir(dirname(legacyPath), { recursive: true });
  await writeFile(legacyPath, renderLegacyProfile(profile), 'utf8');
  return { path: legacyPath, written: true };
}
