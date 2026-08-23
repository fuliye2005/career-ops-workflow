#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCORE_GATE = 3.0;
const MAX_EDITABLE_HTML_BYTES = 16 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.pdf', '.docx', '.txt', '.md', '.markdown']);

function pathsFor(root = ROOT) {
  const data = join(root, 'data', 'workflow');
  const output = join(root, 'output', 'workflow');
  const input = join(root, 'workflow-input');
  const personalInfoDir = join(input, 'personal-info');
  const inbox = join(input, 'jd');
  const photos = join(input, 'photos');
  const legacyInbox = join(root, 'data', 'job-inbox');
  const legacyProjectInbox = join(root, 'jds');
  return {
    root,
    input,
    personalInfoDir,
    personalInfoFile: join(personalInfoDir, 'personal-info.md'),
    inbox,
    photos,
    jobsFile: join(inbox, 'jobs.txt'),
    legacyInbox,
    legacyProjectInbox,
    legacyJobsFile: join(legacyInbox, 'jobs.txt'),
    legacyProjectJobsFile: join(legacyProjectInbox, 'jobs.txt'),
    data,
    jobsIndex: join(data, 'jobs.json'),
    records: join(data, 'records'),
    runs: join(data, 'runs'),
    output,
    summary: join(output, 'index.html'),
  };
}

async function writeAtomic(filePath, content) {
  await mkdir(dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, content, 'utf8');
  await rename(temp, filePath);
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function slugify(value, fallback = 'job') {
  const normalized = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function safeId(value, fallback = 'job') {
  const cleaned = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : slugify(value, fallback);
}

function safeFileName(value, fallback = '岗位') {
  const cleaned = String(value || '')
    .trim()
    .replace(/[<>:"\/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-{2,}/g, '-')
    .replace(/[. ]+$/g, '');
  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) return `${fallback}-${cleaned}`;
  return cleaned;
}

function resumeFileName(record, stage, version = 1) {
  const role = safeFileName(record?.role || record?.title || record?.company || record?.id, '岗位');
  const versionSuffix = version > 1 ? `.v${version}` : '';
  return `${role}-${stage}${versionSuffix}`;
}

function resolveResumeArtifact(record, artifactKey, root, id, stage, extension, legacyName) {
  const recorded = record?.artifacts?.[artifactKey];
  if (recorded) return resolveWorkspacePath(root, recorded, join('output', 'workflow', id, legacyName));
  const outputDir = join(pathsFor(root).output, id);
  const namedPath = join(outputDir, `${resumeFileName(record, stage)}.${extension}`);
  const legacyPath = join(outputDir, legacyName);
  return existsSync(namedPath) || !existsSync(legacyPath) ? namedPath : legacyPath;
}

function hashId(value) {
  return `job-${createHash('sha1').update(String(value)).digest('hex').slice(0, 10)}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function isWithinRoot(candidate, root = ROOT) {
  const absoluteCandidate = resolve(candidate);
  const absoluteRoot = resolve(root);
  return absoluteCandidate === absoluteRoot || absoluteCandidate.startsWith(`${absoluteRoot}${sep}`);
}

function resolveWorkspacePath(root, targetPath, fallbackPath = null) {
  const candidate = resolve(root, targetPath || fallbackPath || '');
  if (!isWithinRoot(candidate, root)) throw new Error(`Path escapes workflow workspace: ${targetPath}`);
  return candidate;
}

function relativeHref(fromFile, targetPath, root = ROOT) {
  if (!targetPath) return null;
  if (/^https?:\/\//i.test(targetPath)) return targetPath;
  const absolute = resolve(root, targetPath);
  if (!isWithinRoot(absolute, root) || !existsSync(absolute)) return null;
  const targetRelative = relative(dirname(fromFile), absolute).split(sep).join('/');
  return targetRelative || './';
}

function attachmentType(fileName) {
  const extension = extname(fileName).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)) return 'image';
  if (extension === '.pdf') return 'pdf';
  if (extension === '.docx') return 'docx';
  return 'text';
}

function parseJobsFile(text) {
  const jobs = [];
  const seenUrls = new Set();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const cells = line.split('|').map(cell => cell.trim()).filter(Boolean);
    if (!cells.length) continue;
    const firstIsUrl = /^https?:\/\//i.test(cells[0]);
    const url = firstIsUrl ? cells[0] : cells[1];
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const urlKey = url.toLowerCase();
    if (seenUrls.has(urlKey)) continue;
    seenUrls.add(urlKey);
    const id = firstIsUrl ? hashId(url) : safeId(cells[0], hashId(url));
    jobs.push({ id, url, inputLine: line, autoId: firstIsUrl });
  }
  return jobs;
}

function hasRealJobsFile(filePath) {
  if (!existsSync(filePath)) return false;
  try {
    return parseJobsFile(readFileSync(filePath, 'utf8')).length > 0;
  } catch {
    return false;
  }
}

function selectJobInput(paths) {
  if (hasRealJobsFile(paths.jobsFile)) {
    return { jobsFile: paths.jobsFile, inbox: paths.inbox };
  }
  if (hasRealJobsFile(paths.legacyProjectJobsFile)) {
    return { jobsFile: paths.legacyProjectJobsFile, inbox: paths.legacyProjectInbox };
  }
  if (hasRealJobsFile(paths.legacyJobsFile)) {
    return { jobsFile: paths.legacyJobsFile, inbox: paths.legacyInbox };
  }
  return { jobsFile: paths.jobsFile, inbox: paths.inbox };
}

async function inspectProfile(root = ROOT) {
  const paths = pathsFor(root);
  const personalInfo = paths.personalInfoFile;
  const legacyCv = join(root, 'cv.md');
  const personalText = existsSync(personalInfo) ? await readFile(personalInfo, 'utf8') : '';
  const placeholder = /请将本文件替换|请填写|replace this file|your (personal|resume) information|待填写|placeholder/i.test(personalText);
  const candidateFile = existsSync(legacyCv) && (!personalText.trim() || placeholder) ? legacyCv : personalInfo;
  const files = {
    cv: candidateFile,
    personalInfo,
    config: join(root, 'config', 'profile.yml'),
    mode: join(root, 'modes', '_profile.md'),
  };
  const missing = [];
  if (!existsSync(candidateFile)) missing.push('cv');
  for (const key of ['config', 'mode']) {
    if (!existsSync(files[key])) missing.push(key);
  }
  const cvText = existsSync(candidateFile) ? await readFile(candidateFile, 'utf8') : '';
  const isPlaceholder = /请将本文件替换|请填写|replace this file|your (personal|resume) information|待填写|placeholder/i.test(cvText);
  const hasProfileSections = /##\s+(Professional Summary|Core Skills|Work Experience|Projects|个人简介|核心能力|工作经历|项目经历)/i.test(cvText);
  const incomplete = !cvText.trim() || isPlaceholder || !hasProfileSections;
  return {
    ready: missing.length === 0 && !incomplete,
    missing,
    incomplete,
    source: relative(root, candidateFile).split(sep).join('/'),
    files: Object.fromEntries(Object.entries(files).map(([name, filePath]) => [name, relative(root, filePath).split(sep).join('/')])),
  };
}
function groupAttachment(fileName, knownIds) {
  const base = fileName.replace(/\.[^.]+$/, '');
  const match = [...knownIds]
    .sort((a, b) => b.length - a.length)
    .find(id => base === id || base.startsWith(`${id}-`) || base.startsWith(`${id}_`));
  return match || safeId(base, hashId(fileName));
}

async function ensureWorkspace(root = ROOT) {
  const paths = pathsFor(root);
  await Promise.all([
    mkdir(paths.personalInfoDir, { recursive: true }),
    mkdir(paths.inbox, { recursive: true }),
    mkdir(paths.photos, { recursive: true }),
    mkdir(paths.records, { recursive: true }),
    mkdir(paths.runs, { recursive: true }),
    mkdir(paths.output, { recursive: true }),
  ]);
  if (!existsSync(paths.personalInfoFile)) {
    const templatePath = join(paths.personalInfoDir, 'personal-info-template.md');
    if (existsSync(templatePath)) await writeFile(paths.personalInfoFile, await readFile(templatePath, 'utf8'), 'utf8');
    else await writeFile(paths.personalInfoFile, '# 个人信息\n\n请填写求职者自己的 Markdown 个人信息。\n', 'utf8');
  }
  if (!existsSync(paths.jobsFile)) {
    await writeFile(paths.jobsFile, '# One job URL per line. The workflow creates the internal job ID automatically.\n# https://example.com/jobs/123\n', 'utf8');
  }
  return paths;
}
async function ingest(root = ROOT) {
  const paths = await ensureWorkspace(root);
  const input = selectJobInput(paths);
  const jobsText = await readFile(input.jobsFile, 'utf8');
  const configured = parseJobsFile(jobsText);
  const knownIds = new Set(configured.map(job => job.id));
  const entries = await readdir(input.inbox, { withFileTypes: true });
  const attachmentsById = new Map();
  const singleConfiguredId = configured.length === 1 ? configured[0].id : null;
  for (const entry of entries) {
    if (!entry.isFile() || ['jobs.txt', 'readme.md'].includes(entry.name.toLowerCase())) continue;
    if (!SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    const id = singleConfiguredId || groupAttachment(entry.name, knownIds);
    if (!knownIds.has(id)) knownIds.add(id);
    const bucket = attachmentsById.get(id) || [];
    bucket.push({
      name: entry.name,
      path: relative(root, join(input.inbox, entry.name)).split(sep).join('/'),
      type: attachmentType(entry.name),
    });
    attachmentsById.set(id, bucket);
  }

  const configuredById = new Map(configured.map(job => [job.id, job]));
  for (const [id, attachments] of attachmentsById) {
    if (!configuredById.has(id)) configuredById.set(id, { id, url: null, inputLine: null });
    configuredById.get(id).attachments = attachments;
  }

  const existing = await readJson(paths.jobsIndex, { jobs: [] });
  const existingById = new Map((existing.jobs || []).map(job => [job.id, job]));
  const now = new Date().toISOString();
  const jobs = [...configuredById.values()].map(job => ({
    ...existingById.get(job.id),
    ...job,
    attachments: job.attachments || existingById.get(job.id)?.attachments || [],
    status: existingById.get(job.id)?.status || 'inbox',
    createdAt: existingById.get(job.id)?.createdAt || now,
    updatedAt: now,
  }));
  jobs.sort((a, b) => a.id.localeCompare(b.id));
  const index = { version: 1, updatedAt: now, jobs };
  await writeAtomic(paths.jobsIndex, JSON.stringify(index, null, 2) + '\n');
  return index;
}

async function loadRecords(root = ROOT) {
  const paths = pathsFor(root);
  await mkdir(paths.records, { recursive: true });
  const entries = await readdir(paths.records, { withFileTypes: true });
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const record = await readJson(join(paths.records, entry.name));
    if (record?.id) records.push(record);
  }
  return records;
}

async function resolveRecordId(value, root = ROOT, artifact = null) {
  const requested = String(value || '').trim();
  if (requested) return /^https?:\/\//i.test(requested) ? hashId(requested) : safeId(requested);
  const records = await loadRecords(root);
  const ranked = records
    .filter(record => passesResumeGate(record.score))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const selected = (artifact ? ranked.find(record => record.artifacts?.[artifact]) : ranked[0])
    || ranked[0]
    || records.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
  if (!selected?.id) throw new Error('No workflow record found. Run career-ops workflow first.');
  return safeId(selected.id);
}

function recommendationFor(score) {
  const numeric = Number(score);
  if (!Number.isFinite(numeric)) return '等待评估';
  if (numeric >= 4.5) return '优先申请';
  if (numeric >= 4.0) return '建议申请';
  if (numeric >= 3.5) return '谨慎考虑';
  return '不建议申请';
}

function hasResumeArtifacts(artifacts = {}) {
  return ['generatedHtml', 'editableHtml', 'finalHtml', 'pdf', 'word'].some(key => Boolean(artifacts[key]));
}

function passesResumeGate(score) {
  const numeric = Number(score);
  return Number.isFinite(numeric) && numeric > DEFAULT_SCORE_GATE;
}

function assertResumeGate(record) {
  const score = Number(record?.score);
  if (!passesResumeGate(score)) {
    throw new Error(`Resume generation requires a score greater than ${DEFAULT_SCORE_GATE.toFixed(1)}/5`);
  }
}

async function writeMetadata(record, root = ROOT) {
  const score = Number(record?.score);
  if (!passesResumeGate(score)) return null;
  const paths = pathsFor(root);
  const id = safeId(record.id);
  const outputDir = join(paths.output, id);
  const metadataPath = join(outputDir, 'metadata.json');
  const metadata = {
    version: 1,
    jobId: id,
    company: record.company || null,
    role: record.role || record.title || null,
    score,
    scoreGate: DEFAULT_SCORE_GATE,
    recommendation: record.recommendation || recommendationFor(record.score),
    report: record.reportPath || null,
    advice: record.advicePath || null,
    template: record.template || 'templates/cv-template.zh-minimal.html',
    artifacts: record.artifacts || {},
    resumeStatus: record.resumeStatus || null,
    updatedAt: record.updatedAt || new Date().toISOString(),
  };
  await writeAtomic(metadataPath, JSON.stringify(metadata, null, 2) + '\n');
  return relative(root, metadataPath).split(sep).join('/');
}

async function writeAdviceArtifact(record, root = ROOT) {
  const advice = record.resumeAdvice || {};
  const hasAdvice = Boolean(record.adviceSummary || advice.summary || advice.experience?.length || advice.projects?.length || advice.keywords?.length || advice.avoid?.length);
  if (!hasAdvice) return record.advicePath || null;
  const id = safeId(record.id);
  const advicePath = join(pathsFor(root).output, id, 'resume-advice.md');
  const sections = [
    `# ${record.company || '岗位'} - ${record.role || record.title || id} 简历修改建议`,
    '',
    `- 评分：${Number.isFinite(Number(record.score)) ? `${Number(record.score).toFixed(1)}/5` : '待评估'}`,
    `- 建议：${record.recommendation || recommendationFor(record.score)}`,
    '',
    '## 摘要',
    advice.summary || record.adviceSummary || '暂无摘要建议。',
  ];
  const addList = (title, values) => {
    if (!Array.isArray(values) || !values.length) return;
    sections.push('', `## ${title}`, ...values.map(value => `- ${value}`));
  };
  addList('工作经历', advice.experience);
  addList('项目选择', advice.projects);
  addList('关键词', advice.keywords);
  addList('禁止添加或夸大', advice.avoid);
  await writeAtomic(advicePath, `${sections.join('\n')}\n`);
  return relative(root, advicePath).split(sep).join('/');
}

async function saveRecord(record, root = ROOT) {
  if (!record?.id) throw new Error('Workflow record requires an id');
  const paths = await ensureWorkspace(root);
  const id = safeId(record.id);
  const recordFile = join(paths.records, `${id}.json`);
  const existing = await readJson(recordFile, {});
  const merged = {
    ...existing,
    ...record,
    id,
    version: record.version || existing.version || 1,
    artifacts: { ...(existing.artifacts || {}), ...(record.artifacts || {}) },
    updatedAt: record.updatedAt || new Date().toISOString(),
  };
  if (hasResumeArtifacts(merged.artifacts) && !passesResumeGate(merged.score)) {
    throw new Error(`Resume artifacts require a score greater than ${DEFAULT_SCORE_GATE.toFixed(1)}/5`);
  }
  if (!merged.recommendation && Number.isFinite(Number(merged.score))) {
    merged.recommendation = recommendationFor(merged.score);
  }
  const advicePath = await writeAdviceArtifact(merged, root);
  if (advicePath) merged.advicePath = advicePath;
  await writeAtomic(recordFile, JSON.stringify(merged, null, 2) + '\n');
  const metadata = await writeMetadata(merged, root);
  await renderSummary(root);
  return { record: relative(root, recordFile).split(sep).join('/'), metadata, value: merged };
}

async function promoteProfileDraft(root = ROOT) {
  const configDraft = join(root, 'config', 'profile.draft.yml');
  const modeDraft = join(root, 'modes', '_profile.draft.md');
  const configPath = join(root, 'config', 'profile.yml');
  const modePath = join(root, 'modes', '_profile.md');
  if (!existsSync(configDraft) || !existsSync(modeDraft)) {
    throw new Error('Profile drafts are missing; run the workflow profile gate first');
  }
  if (existsSync(configPath) || existsSync(modePath)) {
    throw new Error('Formal profile files already exist; review and edit them explicitly instead of overwriting');
  }
  const configText = await readFile(configDraft, 'utf8');
  const modeText = await readFile(modeDraft, 'utf8');
  if (/待确认|TBD|TO-?DO/i.test(`${configText}\n${modeText}`)) {
    throw new Error('Profile drafts still contain fields marked 待确认/TBD; complete the preview before confirming');
  }
  await writeAtomic(configPath, configText);
  await writeAtomic(modePath, modeText);
  return { config: relative(root, configPath).split(sep).join('/'), mode: relative(root, modePath).split(sep).join('/') };
}

function recordLinks(record, summaryFile, root) {
  const links = [];
  const add = (label, target, kind = 'link') => {
    const href = relativeHref(summaryFile, target, root);
    links.push({ label, href, kind, disabled: !href });
  };
  add('岗位 JD', record.url || record.jdPath);
  if (record.jdPath && record.jdPath !== record.url) add('本地资料', record.jdPath);
  for (const attachment of record.attachments || []) {
    if (attachment?.path) add(attachment.name || 'JD 附件', attachment.path);
  }
  add('评估报告', record.reportPath);
  add('修改建议', record.advicePath || record.reportPath);
  add('自动简历', record.artifacts?.generatedHtml);
  add('可编辑', record.artifacts?.editableHtml);
  add('最终简历', record.artifacts?.finalHtml);
  add('PDF', record.artifacts?.pdf);
  add('Word', record.artifacts?.word);
  return links;
}

function linkHtml(link) {
  if (link.disabled) return `<span class="link disabled">${escapeHtml(link.label)}</span>`;
  const external = /^https?:\/\//i.test(link.href);
  return `<a class="link" href="${escapeAttr(link.href)}"${external ? ' target="_blank" rel="noreferrer"' : ''}>${escapeHtml(link.label)}</a>`;
}

function renderSummaryHtml(records, jobs, root = ROOT) {
  const summaryFile = pathsFor(root).summary;
  const merged = new Map();
  for (const job of jobs || []) merged.set(job.id, { ...job });
  for (const record of records || []) merged.set(record.id, { ...merged.get(record.id), ...record });
  const rows = [...merged.values()].sort((a, b) => {
    const scoreA = Number.isFinite(Number(a.score)) ? Number(a.score) : -1;
    const scoreB = Number.isFinite(Number(b.score)) ? Number(b.score) : -1;
    return scoreB - scoreA || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  });
  const rowHtml = rows.map(record => {
    const score = Number.isFinite(Number(record.score)) ? `${Number(record.score).toFixed(1)}/5` : '待评估';
    const recommendation = record.recommendation || recommendationFor(record.score);
    const status = record.resumeStatus || (passesResumeGate(record.score) ? '待生成简历' : '未生成简历');
    const skills = [...(record.skillsMatched || []), ...(record.skillGaps || []).map(skill => `缺口: ${skill}`)];
    const links = recordLinks(record, summaryFile, root).map(linkHtml).join(' ');
    const advice = record.resumeAdvice || {};
    const adviceText = advice.summary || record.adviceSummary || '等待岗位评估后生成修改建议。';
    const adviceDetails = [
      ...(advice.experience || []).map(item => `经历: ${item}`),
      ...(advice.projects || []).map(item => `项目: ${item}`),
      ...(advice.keywords || []).map(item => `关键词: ${item}`),
      ...(advice.avoid || []).map(item => `避免: ${item}`),
    ]; 
    const searchText = [record.company, record.role, record.url, recommendation, status, ...skills, adviceText].join(' ').toLowerCase();
    const scoreClass = Number(record.score) >= 4.5 ? 'high' : Number(record.score) >= 4 ? 'good' : Number(record.score) >= 3.5 ? 'mid' : 'low';
    return `<article class="job-row ${scoreClass}" data-search="${escapeAttr(searchText)}" data-score="${escapeAttr(record.score ?? '')}" data-status="${escapeAttr(status)}">
      <div class="job-main">
        <div class="job-heading"><h2>${escapeHtml(record.company || '未识别公司')} <span>/</span> ${escapeHtml(record.role || record.title || record.id)}</h2><span class="score">${escapeHtml(score)}</span></div>
        <div class="meta"><span class="recommendation">${escapeHtml(recommendation)}</span><span>${escapeHtml(status)}</span><span>${escapeHtml(record.updatedAt ? new Date(record.updatedAt).toLocaleString('zh-CN') : '未处理')}</span></div>
        <p class="advice"><strong>修改建议：</strong>${escapeHtml(adviceText)}</p>
        ${adviceDetails.length ? `<details class="advice-details"><summary>查看具体修改建议</summary><ul>${adviceDetails.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></details>` : ''}
        <div class="chips">${skills.slice(0, 8).map(skill => `<span>${escapeHtml(skill)}</span>`).join('') || '<span>等待技能分析</span>'}</div>
        <div class="links">${links}</div>
      </div>
    </article>`;
  }).join('\n');
  const total = rows.length;
  const evaluated = rows.filter(row => Number.isFinite(Number(row.score))).length;
  const ready = rows.filter(row => row.artifacts?.finalHtml || row.artifacts?.editableHtml || row.artifacts?.generatedHtml).length;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Career-Ops 求职总览</title>
<style>
:root{font-family:"Segoe UI","Microsoft YaHei",Arial,sans-serif;color:#20252b;background:#f5f7f9;line-height:1.5}
*{box-sizing:border-box}body{margin:0}.shell{max-width:1440px;margin:0 auto;padding:28px 24px 56px}.topbar{display:flex;justify-content:space-between;gap:20px;align-items:flex-end;border-bottom:1px solid #d9e0e6;padding-bottom:22px}.eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#64717e}.title{margin:4px 0 0;font-size:30px;line-height:1.15}.summary{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0}.stat{background:#fff;border:1px solid #dfe5ea;border-radius:6px;padding:12px 16px;min-width:120px}.stat strong{display:block;font-size:22px}.stat span{font-size:12px;color:#687581}.controls{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0}.controls input,.controls select{height:38px;border:1px solid #cbd4dc;border-radius:4px;background:#fff;padding:0 11px;font:inherit}.controls input{min-width:280px;flex:1}.job-list{display:grid;gap:10px}.job-row{background:#fff;border:1px solid #dfe5ea;border-left:4px solid #aab5bf;border-radius:5px}.job-row.high{border-left-color:#198754}.job-row.good{border-left-color:#2780c2}.job-row.mid{border-left-color:#d08b18}.job-row.low{border-left-color:#b34a4a}.job-main{padding:17px 18px}.job-heading{display:flex;gap:12px;justify-content:space-between;align-items:flex-start}.job-heading h2{font-size:18px;margin:0;font-weight:650}.job-heading h2 span{color:#a7b0b8;font-weight:400}.score{font-weight:700;white-space:nowrap}.meta{display:flex;gap:14px;flex-wrap:wrap;color:#6d7882;font-size:12px;margin-top:7px}.recommendation{color:#176b45;font-weight:700}.advice{margin:13px 0 10px;color:#3f4b55}.chips{display:flex;flex-wrap:wrap;gap:6px}.chips span{font-size:12px;border:1px solid #d5dde4;background:#f6f8fa;border-radius:3px;padding:3px 7px}.links{display:flex;gap:7px;flex-wrap:wrap;margin-top:15px}.link{font-size:12px;color:#155d91;text-decoration:none;border:1px solid #bfd1df;border-radius:3px;padding:5px 8px;background:#fbfdff}.link:hover{text-decoration:underline}.link.disabled{color:#9ba6af;background:#f4f6f7;border-color:#e1e5e8}.advice-details{margin:8px 0;color:#4b5964;font-size:13px}.advice-details summary{cursor:pointer;color:#155d91}.advice-details ul{margin:7px 0 0 20px;padding:0}.empty{padding:32px;background:#fff;border:1px dashed #cbd4dc;color:#687581;text-align:center}
@media(max-width:680px){.shell{padding:20px 14px 40px}.topbar{display:block}.title{font-size:25px}.job-heading{display:block}.score{display:block;margin-top:8px}.controls input{min-width:100%}.stat{flex:1;min-width:0}.job-heading h2{font-size:16px}}
</style>
</head>
<body><main class="shell">
<header class="topbar"><div><div class="eyebrow">CAREER-OPS / WORKFLOW</div><h1 class="title">求职岗位总览</h1></div><div class="eyebrow">持续累计 · ${escapeHtml(new Date().toLocaleString('zh-CN'))}</div></header>
<section class="summary"><div class="stat"><strong>${total}</strong><span>岗位总数</span></div><div class="stat"><strong>${evaluated}</strong><span>已评估</span></div><div class="stat"><strong>${ready}</strong><span>已有简历</span></div></section>
<section class="controls"><input id="search" type="search" placeholder="搜索公司、岗位、技能或建议"><select id="status"><option value="">全部状态</option><option>优先申请</option><option>建议申请</option><option>谨慎考虑</option><option>不建议申请</option><option>待评估</option><option>已确认</option></select><select id="score"><option value="">全部评分</option><option value="4.5">4.5+</option><option value="4">4.0+</option><option value="3.5">3.5+</option></select></section>
<section id="jobs" class="job-list">${rowHtml || '<div class="empty">还没有岗位。把 URL 写进 jds/jobs.txt，或把 JD 文件放入 jds/。</div>'}</section>
</main><script>
const rows=[...document.querySelectorAll('.job-row')];
function apply(){const q=document.querySelector('#search').value.trim().toLowerCase(),s=document.querySelector('#status').value,min=Number(document.querySelector('#score').value||0);for(const row of rows){const ok=(!q||row.dataset.search.includes(q))&&(!s||row.dataset.search.includes(s.toLowerCase()))&&(!min||Number(row.dataset.score)>=min);row.hidden=!ok}}
for(const id of ['search','status','score'])document.getElementById(id).addEventListener('input',apply);
</script></body></html>`;
}

async function renderSummary(root = ROOT) {
  const paths = await ensureWorkspace(root);
  const jobsIndex = await readJson(paths.jobsIndex, { jobs: [] });
  const records = await loadRecords(root);
  const html = renderSummaryHtml(records, jobsIndex.jobs || [], root);
  await writeAtomic(paths.summary, html);
  return { path: paths.summary, count: new Set([...(jobsIndex.jobs || []).map(job => job.id), ...records.map(record => record.id)]).size };
}

function editableInjection(html, jobId) {
const injection = `<style id="workflow-editor-style">.workflow-toolbar{position:sticky;top:0;z-index:9999;display:flex;gap:8px;align-items:center;padding:10px 14px;background:#202a33;color:#fff;font:14px Segoe UI,Arial,sans-serif;box-shadow:0 2px 8px #0002}.workflow-toolbar button{border:1px solid #9fb1bf;border-radius:4px;background:#fff;color:#202a33;padding:6px 10px;font:inherit;cursor:pointer}.workflow-toolbar button:disabled{opacity:.65;cursor:wait}.workflow-toolbar span{font-size:12px;color:#d5e0e8}.workflow-edit-target{outline:2px dashed #2780c2;outline-offset:3px}</style><div id="workflow-toolbar" class="workflow-toolbar" contenteditable="false"><strong>Career-Ops 简历编辑</strong><button type="button" id="workflow-save">保存最终版</button><span id="workflow-message">修改文字后点击保存</span></div><script data-workflow-editor="true">(function(){const jobId=${JSON.stringify(jobId)};const target=document.querySelector('.page');const button=document.querySelector('#workflow-save');const message=document.querySelector('#workflow-message');const saveUrl=location.protocol==='file:'?'http://127.0.0.1:4173/__workflow/save':'/__workflow/save';if(!target||!button||!message)return;target.classList.add('workflow-edit-target');target.setAttribute('contenteditable','true');target.addEventListener('input',()=>{message.textContent='有未保存修改'});button.addEventListener('click',async()=>{button.disabled=true;message.textContent='正在保存并生成 Word…';try{const clone=document.documentElement.cloneNode(true);clone.querySelector('#workflow-toolbar')?.remove();clone.querySelector('#workflow-editor-style')?.remove();clone.querySelectorAll('script[data-workflow-editor]').forEach(el=>el.remove());clone.querySelectorAll('[contenteditable]').forEach(el=>el.removeAttribute('contenteditable'));clone.querySelectorAll('.workflow-edit-target').forEach(el=>el.classList.remove('workflow-edit-target'));const res=await fetch(saveUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jobId,html:'<!doctype html>\\n'+clone.outerHTML})});let data={};try{data=await res.json()}catch{}if(!res.ok||!data.ok)throw new Error(data.error||'服务器返回错误');message.textContent=data.warning||!data.word?'已保存最终版，Word 生成失败':'已保存最终版，Word 已生成';}catch(error){message.textContent='保存失败：'+(error?.message||'请先运行 npm run workflow:serve');}finally{button.disabled=false;}});})();</script>`;
  const adjustedInjection = injection
    .replace('正在保存并生成 Word…', '正在保存并生成 Word/PDF…')
    .replace('已保存最终版，Word 已生成', '已保存最终版，Word/PDF 已生成');
  return html.includes('</body>') ? html.replace('</body>', `${adjustedInjection}</body>`) : `${html}${adjustedInjection}`;
}

async function prepareEditable(jobId, root = ROOT) {
  const paths = pathsFor(root);
  const id = await resolveRecordId(jobId, root, 'generatedHtml');
  const recordFile = join(paths.records, `${id}.json`);
  const record = await readJson(recordFile);
  if (!record) throw new Error(`Workflow record not found: ${jobId}`);
  assertResumeGate(record);
  const generated = resolveResumeArtifact(record, 'generatedHtml', root, id, '生成版', 'html', 'cv.generated.html');
  if (!existsSync(generated)) throw new Error(`Generated HTML not found: ${generated}`);
  const editable = resolveResumeArtifact(record, 'editableHtml', root, id, '可编辑', 'html', 'cv.editable.html');
  if (!existsSync(editable)) {
    const source = await readFile(generated, 'utf8');
    await writeAtomic(editable, editableInjection(source, id));
  }
  record.artifacts = { ...(record.artifacts || {}), generatedHtml: relative(root, generated).split(sep).join('/'), editableHtml: relative(root, editable).split(sep).join('/') };
  record.resumeStatus = record.artifacts.finalHtml ? '已确认' : '可编辑';
  record.updatedAt = new Date().toISOString();
  await writeAtomic(recordFile, JSON.stringify(record, null, 2) + '\n');
  await writeMetadata(record, root);
  await renderSummary(root);
  return { jobId: id, editable: relative(root, editable).split(sep).join('/') };
}

async function saveFinalHtml(jobId, html, root = ROOT) {
  if (typeof html !== 'string' || !html.includes('<html')) throw new Error('Invalid HTML payload');
  const htmlBytes = Buffer.byteLength(html, 'utf8');
  if (htmlBytes > MAX_EDITABLE_HTML_BYTES) {
    throw new Error(`HTML payload is too large (max ${Math.round(MAX_EDITABLE_HTML_BYTES / 1024 / 1024)} MB)`);
  }
  const paths = pathsFor(root);
  const id = safeId(jobId);
  const recordFile = join(paths.records, `${id}.json`);
  const record = await readJson(recordFile);
  if (!record) throw new Error(`Workflow record not found: ${jobId}`);
  assertResumeGate(record);
  const outputDir = join(paths.output, id);
  await mkdir(outputDir, { recursive: true });
  const baseFinalPath = join(outputDir, `${resumeFileName(record, '最终版')}.html`);
  let finalPath = baseFinalPath;
  let version = 1;
  while (existsSync(finalPath)) {
    version++;
    finalPath = join(outputDir, `${resumeFileName(record, '最终版', version)}.html`);
  }
  const cleanedHtml = cleanEditableHtml(html);
  await writeAtomic(finalPath, cleanedHtml);
  const finalRelative = relative(root, finalPath).split(sep).join('/');
  const previousFinal = record.artifacts?.finalHtml;
  const artifacts = { ...(record.artifacts || {}), finalHtml: finalRelative };
  if (version > 1) {
    artifacts.finalHtmlHistory = [
      ...(previousFinal ? [previousFinal] : []),
      ...(artifacts.finalHtmlHistory || []),
      finalRelative,
    ];
  }
  record.artifacts = artifacts;
  record.resumeStatus = '已确认';
  record.updatedAt = new Date().toISOString();
  await writeAtomic(recordFile, JSON.stringify(record, null, 2) + '\n');
  await writeMetadata(record, root);
  await renderSummary(root);
  return { path: relative(root, finalPath).split(sep).join('/') };
}

function cleanEditableHtml(html) {
  return html
    .replace(/<style\b[^>]*id=["']workflow-editor-style["'][^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<div\b[^>]*id=["']workflow-toolbar["'][^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<script\b[^>]*data-workflow-editor=["']true["'][^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/\scontenteditable=["'](?:true|false)["']/gi, '')
    .replace(/\sdata-workflow-editor=["'][^"']*["']/gi, '')
    .replace(/\sclass=["']([^"']*)["']/gi, (match, classes) => {
      const cleaned = classes.split(/\s+/).filter(name => name && name !== 'workflow-edit-target').join(' ');
      return cleaned ? ` class="${cleaned}"` : '';
    });
}

async function renderWord(jobId, root = ROOT) {
  const paths = pathsFor(root);
  const id = await resolveRecordId(jobId, root, 'finalHtml');
  const recordFile = join(paths.records, `${id}.json`);
  const record = await readJson(recordFile);
  if (!record) throw new Error(`Workflow record not found: ${jobId}`);
  assertResumeGate(record);
  const finalPath = resolveResumeArtifact(record, 'finalHtml', root, id, '最终版', 'html', 'cv.final.html');
  if (!existsSync(finalPath)) throw new Error(`Final HTML is not confirmed: ${finalPath}`);
  const wordPath = join(paths.output, id, `${resumeFileName(record, '最终版')}.docx`);
  const result = spawnSync(process.execPath, [
    join(ROOT, 'generate-word.mjs'),
    '--html', finalPath,
    '--output', wordPath,
    '--photo-dir', paths.photos,
  ], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Word generation failed with ${result.status}`);
  record.artifacts = { ...(record.artifacts || {}), word: relative(root, wordPath).split(sep).join('/') };
  record.resumeStatus = '已生成 Word';
  record.updatedAt = new Date().toISOString();
  await writeAtomic(recordFile, JSON.stringify(record, null, 2) + '\n');
  await writeMetadata(record, root);
  await renderSummary(root);
  return { path: relative(root, wordPath).split(sep).join('/'), output: result.stdout };
}
async function renderPdf(jobId, root = ROOT) {
  const paths = pathsFor(root);
  const id = await resolveRecordId(jobId, root, 'finalHtml');
  const recordFile = join(paths.records, `${id}.json`);
  const record = await readJson(recordFile);
  if (!record) throw new Error(`Workflow record not found: ${jobId}`);
  assertResumeGate(record);
  const finalPath = resolveResumeArtifact(record, 'finalHtml', root, id, '最终版', 'html', 'cv.final.html');
  if (!existsSync(finalPath)) throw new Error(`Final HTML is not confirmed: ${finalPath}`);
  const factCheck = spawnSync(process.execPath, ['verify-cv-facts.mjs', finalPath], { cwd: root, encoding: 'utf8' });
  if (factCheck.status !== 0) throw new Error(factCheck.stderr || factCheck.stdout || 'CV fact check failed');
  const pdfPath = join(paths.output, id, `${resumeFileName(record, '最终版')}.pdf`);
  const args = ['generate-pdf.mjs', finalPath, pdfPath, '--format=a4'];
  if (record.reportNumber) args.push(`--report=${record.reportNumber}`);
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `PDF generation failed with ${result.status}`);
  record.artifacts = { ...(record.artifacts || {}), pdf: relative(root, pdfPath).split(sep).join('/') };
  record.resumeStatus = '已生成 PDF';
  record.updatedAt = new Date().toISOString();
  await writeAtomic(recordFile, JSON.stringify(record, null, 2) + '\n');
  await writeMetadata(record, root);
  await renderSummary(root);
  return { path: relative(root, pdfPath).split(sep).join('/'), output: result.stdout };
}

async function main() {
  const [command = 'help', arg] = process.argv.slice(2);
  try {
    if (command === 'init' || command === 'start' || command === 'workflow') {
      const paths = await ensureWorkspace();
      const index = await ingest();
      const summary = await renderSummary();
      const profile = await inspectProfile();
      console.log(JSON.stringify({ ok: true, inbox: paths.inbox, jobs: index.jobs.length, summary: summary.path, profile }, null, 2));
      return;
    }
    if (command === 'ingest') {
      console.log(JSON.stringify(await ingest(), null, 2));
      return;
    }
    if (command === 'summary') {
      console.log(JSON.stringify(await renderSummary(), null, 2));
      return;
    }
    if (command === 'profile') {
      console.log(JSON.stringify(await inspectProfile(), null, 2));
      return;
    }
    if (command === 'profile-confirm') {
      console.log(JSON.stringify(await promoteProfileDraft(), null, 2));
      return;
    }
    if (command === 'record') {
      if (!arg) throw new Error('Usage: node workflow.mjs record <record.json>');
      const payload = await readJson(resolve(arg));
      if (!payload) throw new Error(`Workflow record not found: ${arg}`);
      console.log(JSON.stringify(await saveRecord(payload), null, 2));
      return;
    }
    if (command === 'prepare-editable') {
      console.log(JSON.stringify(await prepareEditable(arg), null, 2));
      return;
    }
    if (command === 'pdf') {
      console.log(JSON.stringify(await renderPdf(arg), null, 2));
      return;
    }
    if (command === 'word') {
      console.log(JSON.stringify(await renderWord(arg), null, 2));
      return;
    }
    console.log('Usage: node workflow.mjs <start|init|ingest|profile|profile-confirm|record|summary|prepare-editable|pdf|word> [argument]');
  } catch (error) {
    console.error(`workflow: ${error.message}`);
    process.exitCode = 1;
  }
}

export {
  DEFAULT_SCORE_GATE,
  MAX_EDITABLE_HTML_BYTES,
  ROOT,
  assertResumeGate,
  cleanEditableHtml,
  editableInjection,
  ensureWorkspace,
  inspectProfile,
  ingest,
  loadRecords,
  pathsFor,
  prepareEditable,
  promoteProfileDraft,
  readJson,
  renderPdf,
  renderWord,
  renderSummary,
  renderSummaryHtml,
  resolveWorkspacePath,
  resumeFileName,
  passesResumeGate,
  writeAdviceArtifact,
  safeId,
  saveRecord,
  saveFinalHtml,
};

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
