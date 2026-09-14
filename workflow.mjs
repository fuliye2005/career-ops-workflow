#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { dump as yamlDump, load as yamlLoad } from 'js-yaml';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCORE_GATE = 3.0;
const MAX_EDITABLE_HTML_BYTES = 16 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.pdf', '.docx', '.txt', '.md', '.markdown']);
const MIME_TYPE_BY_EXTENSION = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

function pathsFor(root = ROOT) {
  const data = join(root, 'data', 'workflow');
  const output = join(root, 'output', 'workflow');
  const input = join(root, 'workflow-input');
  const personalInfoDir = join(input, 'personal-info');
  const inbox = join(input, 'jd');
  const photos = join(input, 'photos');
  const profileDir = join(input, 'profile');
  const legacyInbox = join(root, 'data', 'job-inbox');
  const legacyProjectInbox = join(root, 'jds');
  return {
    root,
    input,
    personalInfoDir,
    personalInfoFile: join(personalInfoDir, 'personal-info.md'),
    inbox,
    photos,
    profileDir,
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
    profilePage: join(output, 'profile.html'),
    settingsFile: join(data, 'settings.json'),
    settingsPage: join(output, 'settings.html'),
  };
}

async function loadWorkflowSettings(root = ROOT) {
  const file = pathsFor(root).settingsFile;
  const settings = await readJson(file, {});
  return {
    pdfExportDir: typeof settings?.pdfExportDir === 'string' ? settings.pdfExportDir.trim() : '',
    wordExportDir: typeof settings?.wordExportDir === 'string' ? settings.wordExportDir.trim() : '',
  };
}

function validateExportDir(value, label) {
  const dir = String(value || '').trim();
  if (!dir) return '';
  if (!isAbsolute(dir)) throw new Error(`${label}必须填写绝对路径`);
  return dir;
}

async function saveWorkflowSettings(payload, root = ROOT) {
  const settings = {
    pdfExportDir: validateExportDir(payload?.pdfExportDir, 'PDF 导出路径'),
    wordExportDir: validateExportDir(payload?.wordExportDir, 'Word 导出路径'),
  };
  for (const dir of [settings.pdfExportDir, settings.wordExportDir]) {
    if (dir) await mkdir(dir, { recursive: true });
  }
  await writeAtomic(pathsFor(root).settingsFile, JSON.stringify(settings, null, 2) + '\n');
  await renderSummary(root);
  return settings;
}

async function writeAtomic(filePath, content) {
  await mkdir(dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, content, typeof content === 'string' ? 'utf8' : undefined);
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

async function collectProfileFiles(root, directory, extensions) {
  const base = join(root, directory);
  if (!existsSync(base)) return [];
  const files = [];
  const entries = await readdir(base, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !extensions.includes(extname(entry.name).toLowerCase())) continue;
    const filePath = join(base, entry.name);
    files.push({ path: relative(root, filePath).split(sep).join('/'), content: await readFile(filePath, 'utf8') });
  }
  return files;
}

async function exportProfile(root = ROOT) {
  const paths = await ensureWorkspace(root);
  const modules = [];
  for (const directory of ['skills', 'experience', 'projects', 'education']) {
    modules.push(...await collectProfileFiles(root, join('workflow-input', 'profile', directory), ['.yml', '.yaml']));
  }
  const photos = [];
  if (existsSync(paths.photos)) {
    const entries = await readdir(paths.photos, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extname(entry.name).toLowerCase())) continue;
      const filePath = join(paths.photos, entry.name);
      photos.push({
        path: relative(root, filePath).split(sep).join('/'),
        mimeType: MIME_TYPE_BY_EXTENSION[extname(entry.name).toLowerCase()] || 'application/octet-stream',
        dataBase64: (await readFile(filePath)).toString('base64'),
      });
    }
  }
  const profileConfigPath = join(paths.profileDir, 'profile.yml');
  const personalInfoMarkdown = existsSync(paths.personalInfoFile) ? await readFile(paths.personalInfoFile, 'utf8') : '';
  const profileConfig = existsSync(profileConfigPath) ? (yamlLoad(await readFile(profileConfigPath, 'utf8')) || {}) : {};
  return {
    schema: 'career-ops-profile',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    profileConfig,
    personalInfoMarkdown,
    modules,
    photos,
  };
}

function profileImportPath(root, relativePath, category) {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  const allowedPrefix = category === 'profile' ? 'workflow-input/profile/' : category === 'personal' ? 'workflow-input/personal-info/' : 'workflow-input/photos/';
  if (!normalized.startsWith(allowedPrefix) || normalized.includes('..') || normalized.includes('\0')) {
    throw new Error(`导入文件路径无效：${normalized}`);
  }
  const extension = extname(normalized).toLowerCase();
  const allowedExtensions = category === 'profile' ? ['.yml', '.yaml'] : category === 'personal' ? ['.md'] : ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
  if (!allowedExtensions.includes(extension)) throw new Error(`导入文件类型不支持：${normalized}`);
  const target = resolve(root, normalized);
  if (!isWithinRoot(target, category === 'profile' ? join(root, 'workflow-input', 'profile') : category === 'personal' ? join(root, 'workflow-input', 'personal-info') : join(root, 'workflow-input', 'photos'))) {
    throw new Error(`导入文件超出允许目录：${normalized}`);
  }
  return target;
}

async function importProfile(payload, root = ROOT) {
  const paths = await ensureWorkspace(root);
  if (!payload || payload.schema !== 'career-ops-profile' || Number(payload.schemaVersion) !== 1) {
    throw new Error('不是可识别的 Career-Ops 个人资料 JSON 文件');
  }
  if (!payload.profileConfig || typeof payload.profileConfig !== 'object' || Array.isArray(payload.profileConfig)) {
    throw new Error('个人资料 JSON 缺少有效的 profileConfig');
  }
  await writeAtomic(join(paths.profileDir, 'profile.yml'), yamlDump(payload.profileConfig, { noRefs: true, lineWidth: 120 }));
  if (typeof payload.personalInfoMarkdown === 'string') {
    await writeAtomic(paths.personalInfoFile, payload.personalInfoMarkdown);
  }
  for (const file of Array.isArray(payload.modules) ? payload.modules : []) {
    const target = profileImportPath(root, file?.path, 'profile');
    if (typeof file?.content !== 'string') throw new Error(`个人资料模块内容无效：${file?.path || ''}`);
    await writeAtomic(target, file.content);
  }
  for (const photo of Array.isArray(payload.photos) ? payload.photos : []) {
    const target = profileImportPath(root, photo?.path, 'photo');
    if (typeof photo?.dataBase64 !== 'string' || !photo.dataBase64) throw new Error(`照片内容无效：${photo?.path || ''}`);
    let bytes;
    try {
      bytes = Buffer.from(photo.dataBase64, 'base64');
    } catch {
      throw new Error(`照片编码无效：${photo?.path || ''}`);
    }
    await writeAtomic(target, bytes);
  }
  await renderSummary(root);
  return { updated: true, modules: Array.isArray(payload.modules) ? payload.modules.length : 0, photos: Array.isArray(payload.photos) ? payload.photos.length : 0 };
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

function resumeFileName(record) {
  const filePart = (value) => {
    const text = String(value || '').trim();
    if (!text || /^(截图未显示|图片未显示|未识别|未知|暂无|未提供)$/i.test(text)) return '';
    return safeFileName(text, '');
  };
  const company = filePart(record?.company);
  const role = filePart(record?.role || record?.title);
  const parts = [company, role].filter(Boolean);
  if (parts.length) return parts.join('-');
  const reportCode = String(record?.reportNumber || '').match(/\d+/)?.[0];
  return reportCode ? `job-${reportCode}` : 'job-resume';
}

function resolveResumeArtifact(record, artifactKey, root, id, stage, extension, legacyName) {
  const outputDir = join(pathsFor(root).output, id);
  const namedPath = join(outputDir, `${resumeFileName(record)}.${extension}`);
  if (existsSync(namedPath)) return namedPath;
  const recorded = record?.artifacts?.[artifactKey];
  if (recorded) return resolveWorkspacePath(root, recorded, join('output', 'workflow', id, legacyName));
  const legacyPath = join(outputDir, legacyName);
  return existsSync(legacyPath) ? legacyPath : namedPath;
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

async function deleteWorkflowJob(jobId, root = ROOT) {
  const paths = pathsFor(root);
  const id = await resolveRecordId(jobId, root);
  const recordFile = join(paths.records, id + '.json');
  const record = await readJson(recordFile);
  const jobsIndex = await readJson(paths.jobsIndex, { jobs: [] });
  const job = (jobsIndex.jobs || []).find(item => item.id === id);
  if (!record && !job) throw new Error('Workflow job not found: ' + jobId);

  const jobUrl = record?.url || job?.url || null;
  const attachmentPaths = new Set();
  for (const item of [...(record?.attachments || []), ...(job?.attachments || [])]) {
    if (item?.path) attachmentPaths.add(item.path);
  }
  for (const item of [record?.jdPath, job?.jdPath]) {
    if (item) attachmentPaths.add(item);
  }

  const inboxes = [...new Set([paths.inbox, paths.legacyInbox, paths.legacyProjectInbox])]
    .filter(inbox => isWithinRoot(inbox, root) && existsSync(inbox));
  const removed = { record: false, output: false, report: false, attachments: 0, jobUrl: false };
  for (const jobsFile of [...new Set([paths.jobsFile, paths.legacyJobsFile, paths.legacyProjectJobsFile])]) {
    if (!jobUrl || !existsSync(jobsFile) || !isWithinRoot(jobsFile, root)) continue;
    const source = await readFile(jobsFile, 'utf8');
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const hadTrailingNewline = /(?:\r?\n)$/.test(source);
    const lines = source.split(/\r?\n/);
    const kept = lines.filter(rawLine => {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) return true;
      const cells = line.split('|').map(cell => cell.trim()).filter(Boolean);
      const candidateUrl = /^https?:\/\//i.test(cells[0]) ? cells[0] : cells[1];
      return candidateUrl !== jobUrl;
    });
    const next = kept.join(newline);
    const normalizedSource = hadTrailingNewline && next && !next.endsWith(newline) ? next + newline : next;
    if (normalizedSource !== source) {
      await writeAtomic(jobsFile, normalizedSource);
      removed.jobUrl = true;
    }
  }

  for (const inbox of inboxes) {
    const entries = await readdir(inbox, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || ['jobs.txt', 'readme.md'].includes(entry.name.toLowerCase())) continue;
      if (!SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      if (groupAttachment(entry.name, new Set([id])) === id) attachmentPaths.add(relative(root, join(inbox, entry.name)).split(sep).join('/'));
    }
  }

  for (const targetPath of attachmentPaths) {
    const target = resolveWorkspacePath(root, targetPath);
    const allowed = inboxes.some(inbox => target === resolve(inbox) || target.startsWith(resolve(inbox) + sep));
    if (!allowed || !existsSync(target)) continue;
    await rm(target, { force: true });
    removed.attachments += 1;
  }

  if (record?.reportPath) {
    const reportPath = resolveWorkspacePath(root, record.reportPath);
    if (isWithinRoot(reportPath, root) && existsSync(reportPath)) {
      await rm(reportPath, { force: true });
      removed.report = true;
    }
  }

  const outputDir = resolve(paths.output, id);
  const outputRoot = resolve(paths.output);
  if (!outputDir.startsWith(outputRoot + sep)) throw new Error('Refusing to delete an output path outside the workflow output directory');
  if (existsSync(outputDir)) {
    await rm(outputDir, { recursive: true, force: true });
    removed.output = true;
  }
  if (existsSync(recordFile)) {
    await rm(recordFile, { force: true });
    removed.record = true;
  }

  const nextJobs = (jobsIndex.jobs || []).filter(item => item.id !== id);
  await writeAtomic(paths.jobsIndex, JSON.stringify({ ...jobsIndex, jobs: nextJobs, updatedAt: new Date().toISOString() }, null, 2) + '\n');
  await renderSummary(root);
  return { id, removed };
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
  add('评估报告', record.reportPath);
  add('修改建议', record.advicePath || record.reportPath);
  add('编辑 HTML', record.artifacts?.editableHtml);
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
    const timeA = Date.parse(a.updatedAt || a.createdAt || '') || 0;
    const timeB = Date.parse(b.updatedAt || b.createdAt || '') || 0;
    const scoreA = Number.isFinite(Number(a.score)) ? Number(a.score) : -1;
    const scoreB = Number.isFinite(Number(b.score)) ? Number(b.score) : -1;
    return timeB - timeA || scoreB - scoreA;
  });
  const rowHtml = rows.map(record => {
    const score = Number.isFinite(Number(record.score)) ? `${Number(record.score).toFixed(1)}/5` : '待评估';
    const recommendation = record.recommendation || recommendationFor(record.score);
    const status = record.resumeStatus || (passesResumeGate(record.score) ? '待生成简历' : '未生成简历');
    const skills = [...(record.skillsMatched || []), ...(record.skillGaps || []).map(skill => `缺口: ${skill}`)];
    const links = recordLinks(record, summaryFile, root).map(linkHtml).join(' ');
    const pdfReady = Boolean(record.artifacts?.pdf);
    const deleteButton = '<button type="button" class="link danger delete-job" data-job-id="' + escapeAttr(record.id) + '" data-job-label="' + escapeAttr(record.role || record.title || record.id) + '">删除岗位</button>';
    const timeText = record.updatedAt || record.createdAt || '';
    const timeValue = Number.isFinite(Date.parse(timeText)) ? Date.parse(timeText) : 0;
    const advice = record.resumeAdvice || {};
    const adviceText = advice.summary || record.adviceSummary || '等待岗位评估后生成修改建议。';
    const adviceDetails = [
      ...(advice.experience || []).map(item => `经历: ${item}`),
      ...(advice.projects || []).map(item => `项目: ${item}`),
      ...(advice.keywords || []).map(item => `关键词: ${item}`),
      ...(advice.avoid || []).map(item => `表达边界: ${item}`),
    ]; 
    const searchText = [record.company, record.role, record.url, recommendation, status, ...skills, adviceText].join(' ').toLowerCase();
    const scoreClass = Number(record.score) >= 4.5 ? 'high' : Number(record.score) >= 4 ? 'good' : Number(record.score) >= 3.5 ? 'mid' : 'low';
    return `<article class="job-row ${scoreClass}" data-search="${escapeAttr(searchText)}" data-score="${escapeAttr(record.score ?? '')}" data-status="${escapeAttr(status)}" data-recommendation="${escapeAttr(recommendation)}" data-pdf="${pdfReady ? 'ready' : 'pending'}" data-time="${timeValue}">
      <div class="job-main">
        <div class="job-heading"><h2>${escapeHtml(record.company || '未识别公司')} <span>/</span> ${escapeHtml(record.role || record.title || record.id)}</h2><span class="score">${escapeHtml(score)}</span></div>
        <div class="meta"><span class="recommendation">${escapeHtml(recommendation)}</span><span>${escapeHtml(status)}</span><span class="pdf-state">PDF ${pdfReady ? '已生成' : '未确定'}</span><span>${escapeHtml(record.updatedAt ? new Date(record.updatedAt).toLocaleString('zh-CN') : '未处理')}</span></div>
        <p class="advice"><strong>修改建议：</strong>${escapeHtml(adviceText)}</p>
        ${adviceDetails.length ? `<details class="advice-details"><summary>查看具体修改建议</summary><ul>${adviceDetails.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></details>` : ''}
        <div class="chips">${skills.slice(0, 8).map(skill => `<span>${escapeHtml(skill)}</span>`).join('') || '<span>等待技能分析</span>'}</div>
        <div class="links">${links}${deleteButton}</div>
      </div>
    </article>`;
  }).join('\n');
  const total = rows.length;
  const evaluated = rows.filter(row => Number.isFinite(Number(row.score))).length;
  const ready = rows.filter(row => row.artifacts?.finalHtml || row.artifacts?.editableHtml || row.artifacts?.generatedHtml).length;
  const pdfPending = rows.filter(row => !row.artifacts?.pdf).length;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Career-Ops 求职总览</title>
<style>
:root{font-family:"Segoe UI","Microsoft YaHei",Arial,sans-serif;color:#20252b;background:#f5f7f9;line-height:1.5}
*{box-sizing:border-box}body{margin:0}.shell{max-width:1440px;margin:0 auto;padding:28px 24px 56px}.topbar{display:flex;justify-content:space-between;gap:20px;align-items:flex-end;border-bottom:1px solid #d9e0e6;padding-bottom:22px}.eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#64717e}.title{margin:4px 0 0;font-size:30px;line-height:1.15}.summary{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0}.stat{background:#fff;border:1px solid #dfe5ea;border-radius:6px;padding:12px 16px;min-width:120px}.stat strong{display:block;font-size:22px}.stat span{font-size:12px;color:#687581}.controls{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0}.controls input,.controls select{height:38px;border:1px solid #cbd4dc;border-radius:4px;background:#fff;padding:0 11px;font:inherit}.controls input{min-width:280px;flex:1}.job-list{display:grid;gap:10px}.job-row{background:#fff;border:1px solid #dfe5ea;border-left:4px solid #aab5bf;border-radius:5px}.job-row.high{border-left-color:#198754}.job-row.good{border-left-color:#2780c2}.job-row.mid{border-left-color:#d08b18}.job-row.low{border-left-color:#b34a4a}.job-main{padding:17px 18px}.job-heading{display:flex;gap:12px;justify-content:space-between;align-items:flex-start}.job-heading h2{font-size:18px;margin:0;font-weight:650}.job-heading h2 span{color:#a7b0b8;font-weight:400}.score{font-weight:700;white-space:nowrap}.meta{display:flex;gap:14px;flex-wrap:wrap;color:#6d7882;font-size:12px;margin-top:7px}.recommendation{color:#176b45;font-weight:700}.advice{margin:13px 0 10px;color:#3f4b55}.chips{display:flex;flex-wrap:wrap;gap:6px}.chips span{font-size:12px;border:1px solid #d5dde4;background:#f6f8fa;border-radius:3px;padding:3px 7px}.links{display:flex;gap:7px;flex-wrap:wrap;margin-top:15px}.link{font-size:12px;color:#155d91;text-decoration:none;border:1px solid #bfd1df;border-radius:3px;padding:5px 8px;background:#fbfdff}.link:hover{text-decoration:underline}.link.danger{color:#a33a3a;border-color:#e5bcbc;background:#fff8f8}.link.danger:hover{background:#fff0f0}.link.danger:disabled{opacity:.6;cursor:wait}.link.disabled{color:#9ba6af;background:#f4f6f7;border-color:#e1e5e8}.advice-details{margin:8px 0;color:#4b5964;font-size:13px}.advice-details summary{cursor:pointer;color:#155d91}.advice-details ul{margin:7px 0 0 20px;padding:0}.empty{padding:32px;background:#fff;border:1px dashed #cbd4dc;color:#687581;text-align:center}
@media(max-width:680px){.shell{padding:20px 14px 40px}.topbar{display:block}.title{font-size:25px}.job-heading{display:block}.score{display:block;margin-top:8px}.controls input{min-width:100%}.stat{flex:1;min-width:0}.job-heading h2{font-size:16px}}
</style>
</head>
<body><main class="shell">
<header class="topbar"><div><div class="eyebrow">CAREER-OPS / WORKFLOW</div><h1 class="title">求职岗位总览</h1><nav style="display:flex;gap:8px;margin-top:12px"><a class="link" href="index.html">岗位总览</a><a class="link" href="profile.html">个人资料</a><a class="link" href="settings.html">导出设置</a></nav></div><div class="eyebrow">持续累计 · ${escapeHtml(new Date().toLocaleString('zh-CN'))}</div></header>
<section class="summary"><div class="stat"><strong>${total}</strong><span>岗位总数</span></div><div class="stat"><strong>${evaluated}</strong><span>已评估</span></div><div class="stat"><strong>${ready}</strong><span>已有简历</span></div><div class="stat"><strong>${pdfPending}</strong><span>PDF 未确定</span></div></section>
<section class="controls"><input id="search" type="search" placeholder="搜索公司、岗位、技能或建议"><select id="status"><option value="">全部状态</option><option>优先申请</option><option>建议申请</option><option>谨慎考虑</option><option>不建议申请</option><option>待评估</option><option>已确认</option></select><select id="score"><option value="">全部评分</option><option value="4.5">4.5+</option><option value="4">4.0+</option><option value="3.5">3.5+</option></select><select id="pdf"><option value="">全部 PDF 状态</option><option value="pending">PDF 未确定</option><option value="ready">PDF 已生成</option></select><select id="sort"><option value="time-desc">最近更新（默认）</option><option value="score-desc">评分排序</option><option value="time-asc">最早更新</option></select></section>
<section id="jobs" class="job-list">${rowHtml || '<div class="empty">还没有岗位。把 URL 写进 jds/jobs.txt，或把 JD 文件放入 jds/。</div>'}</section>
</main><script>
const rows=[...document.querySelectorAll('.job-row')];
const jobList=document.querySelector('#jobs');
const deleteUrl=location.protocol==='file:'?'http://127.0.0.1:4173/__workflow/delete':'/__workflow/delete';
function sortRows(){const mode=document.querySelector('#sort').value;rows.sort((a,b)=>{if(mode==='time-asc')return Number(a.dataset.time)-Number(b.dataset.time);if(mode==='time-desc')return Number(b.dataset.time)-Number(a.dataset.time);const scoreA=Number.isFinite(Number(a.dataset.score))?Number(a.dataset.score):-1,scoreB=Number.isFinite(Number(b.dataset.score))?Number(b.dataset.score):-1;return scoreB-scoreA||Number(b.dataset.time)-Number(a.dataset.time)});for(const row of rows)jobList.appendChild(row)}
function apply(){const q=document.querySelector('#search').value.trim().toLowerCase(),s=document.querySelector('#status').value,min=Number(document.querySelector('#score').value||0),pdf=document.querySelector('#pdf').value;for(const row of rows){const statusOk=!s||row.dataset.status===s||row.dataset.recommendation===s;const ok=(!q||row.dataset.search.includes(q))&&statusOk&&(!min||Number(row.dataset.score)>=min)&&(!pdf||row.dataset.pdf===pdf);row.hidden=!ok}sortRows()}
for(const id of ['search','status','score','pdf','sort']){const element=document.getElementById(id);element.addEventListener(element.tagName==='SELECT'?'change':'input',apply)}
for(const button of document.querySelectorAll('.delete-job')){button.addEventListener('click',async()=>{const label=button.dataset.jobLabel||button.dataset.jobId;if(!window.confirm('确定删除岗位“'+label+'”吗？该岗位的 JD、评估记录、简历产物和报告会一并删除，个人信息和照片保持不变。'))return;const original=button.textContent;button.disabled=true;button.textContent='删除中…';try{const response=await fetch(deleteUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jobId:button.dataset.jobId})});let data={};try{data=await response.json()}catch{}if(!response.ok||!data.ok)throw new Error(data.error||'服务器返回错误');location.reload()}catch(error){button.disabled=false;button.textContent=original;window.alert('删除失败：'+(error?.message||'请先运行 npm run workflow:serve'))}})}
apply();
</script></body></html>`;
}

async function loadProfilePreview(root = ROOT) {
  const paths = pathsFor(root);
  const profileConfigPath = join(paths.profileDir, 'profile.yml');
  let config = {};
  if (existsSync(profileConfigPath)) {
    try { config = yamlLoad(await readFile(profileConfigPath, 'utf8')) || {}; } catch { config = {}; }
  }
  const groups = [];
  const directories = [
    ['skills', '技能'],
    ['experience', '工作经历'],
    ['projects', '项目经历'],
    ['education', '教育背景'],
  ];
  for (const [directory, label] of directories) {
    const dir = join(paths.profileDir, directory);
    if (!existsSync(dir)) continue;
    const entries = await readdir(dir, { withFileTypes: true });
    const containers = [];
    for (const entry of entries) {
      if (!entry.isFile() || !['.yml', '.yaml'].includes(extname(entry.name).toLowerCase())) continue;
      const filePath = join(dir, entry.name);
      try {
        const raw = yamlLoad(await readFile(filePath, 'utf8')) || {};
        const items = Array.isArray(raw.items) ? raw.items : (raw.content ? [raw] : []);
        containers.push({
          sourceFile: relative(root, filePath).split(sep).join('/'),
          title: raw.title || raw.name || entry.name.replace(/\.(yml|yaml)$/i, ''),
          organization: raw.organization || raw.company || '',
          period: raw.period || raw.date || '',
          items: items.map((item, index) => ({
            id: item.id || `${entry.name}-${index}`,
            title: item.title || item.name || raw.title || '未命名条目',
            content: item.content || item.text || item.description || item.summary || '',
            familiarity: Number(item.familiarity ?? item.priority) || 3,
            includeInCv: item.include_in_cv !== false && item.includeInCv !== false,
            sourceFile: relative(root, filePath).split(sep).join('/'),
          })).filter(item => item.content),
        });
      } catch {
        containers.push({ title: entry.name, organization: '', period: '', items: [] });
      }
    }
    if (containers.some(container => container.items.length)) groups.push({ label, containers });
  }
  return { config, groups };
}

function renderProfileHtml(profile, root = ROOT) {
  const identity = profile.config?.identity || {};
  const summary = profile.config?.summary || '';
  const contact = Object.entries(identity).filter(([, value]) => value).map(([key, value]) => `<span class="contact-item"><strong>${escapeHtml(key)}</strong>${escapeHtml(value)}</span>`).join('');
  const input = (name, value, type = 'text') => `<input class="profile-input" name="${escapeAttr(name)}" type="${type}" value="${escapeAttr(value)}">`;
  const groupHtml = profile.groups.map(group => `<section class="profile-section"><h2>${escapeHtml(group.label)}</h2>${group.containers.map(container => `<div class="profile-card"><div class="profile-card-heading"><h3>${escapeHtml(container.title)}</h3><span>${escapeHtml([container.organization, container.period].filter(Boolean).join(' · '))}</span></div>${container.items.map(item => `<article class="profile-item" data-profile-item="true" data-source-file="${escapeAttr(item.sourceFile)}" data-item-id="${escapeAttr(item.id)}"><div class="profile-item-heading"><strong>${escapeHtml(item.title)}</strong>${group.label === '教育背景' ? '' : `<span class="familiarity">熟悉度 ${escapeHtml(item.familiarity)}/5</span>`}</div><label>标题${input('title', item.title)}</label><label>内容<textarea name="content">${escapeHtml(item.content)}</textarea></label>${group.label === '教育背景' ? '' : `<div class="profile-item-options"><label>熟悉度<select name="familiarity"><option value="1"${item.familiarity === 1 ? ' selected' : ''}>1 · 了解</option><option value="2"${item.familiarity === 2 ? ' selected' : ''}>2 · 基础使用</option><option value="3"${item.familiarity === 3 ? ' selected' : ''}>3 · 实际接触</option><option value="4"${item.familiarity === 4 ? ' selected' : ''}>4 · 参与较深</option><option value="5"${item.familiarity === 5 ? ' selected' : ''}>5 · 完整掌握</option></select></label><label class="checkbox"><input name="includeInCv" type="checkbox"${item.includeInCv ? ' checked' : ''}>允许进入简历</label></div>`}</article>`).join('')}</div>`).join('')}</section>`).join('');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Career-Ops 个人资料</title>
<style>:root{font-family:"Segoe UI","Microsoft YaHei",Arial,sans-serif;color:#20252b;background:#f5f7f9;line-height:1.5}*{box-sizing:border-box}body{margin:0}.shell{max-width:1080px;margin:0 auto;padding:28px 24px 56px}.topbar{display:flex;justify-content:space-between;gap:20px;align-items:flex-end;border-bottom:1px solid #d9e0e6;padding-bottom:22px}.eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#64717e}.title{margin:4px 0 0;font-size:30px;line-height:1.15}.link,.save-button{font-size:12px;color:#155d91;text-decoration:none;border:1px solid #bfd1df;border-radius:4px;padding:6px 9px;background:#fbfdff;cursor:pointer}.link:hover{ text-decoration:underline}.save-button{background:#155d91;color:#fff;border-color:#155d91}.save-button:disabled{opacity:.6;cursor:wait}.profile-intro,.profile-section{margin-top:20px}.profile-intro,.profile-card{background:#fff;border:1px solid #dfe5ea;border-radius:6px;padding:18px}.profile-intro h2,.profile-section h2{margin:0 0 10px;font-size:20px}.profile-intro p{margin:8px 0;color:#3f4b55}.contacts{display:flex;flex-wrap:wrap;gap:10px 18px;color:#52606b;font-size:13px}.contact-item strong{margin-right:5px;color:#20252b}.profile-section h2{border-left:4px solid #2780c2;padding-left:10px}.profile-card{margin:10px 0}.profile-card-heading,.profile-item-heading{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.profile-card-heading h3{margin:0;font-size:17px}.profile-card-heading span{color:#74808a;font-size:12px}.profile-item{border-top:1px solid #edf0f2;margin-top:12px;padding-top:12px}.profile-item-heading strong{font-size:14px}.familiarity{color:#176b45;font-size:12px;white-space:nowrap}.profile-item label{display:block;margin-top:8px;color:#52606b;font-size:12px}.profile-input,.profile-item textarea,.profile-item select{display:block;width:100%;margin-top:4px;border:1px solid #cbd4dc;border-radius:4px;padding:8px;font:inherit;background:#fff}.profile-item textarea{min-height:72px;resize:vertical}.profile-item-options{display:flex;gap:18px;align-items:center}.profile-item-options label{flex:0 0 auto}.profile-item-options select{width:auto;min-width:160px}.checkbox{display:flex!important;align-items:center;gap:6px}.checkbox input{width:auto}.savebar{position:sticky;bottom:14px;margin-top:22px;padding:12px;background:#202a33;border-radius:6px;color:#fff;display:flex;align-items:center;gap:12px}.savebar span{font-size:12px;color:#d5e0e8}.empty{padding:32px;background:#fff;border:1px dashed #cbd4dc;color:#687581;text-align:center}@media(max-width:680px){.shell{padding:20px 14px 40px}.topbar{display:block}.title{font-size:25px}.profile-card-heading,.profile-item-heading{display:block}.familiarity{display:block;margin-top:4px}.profile-item-options{display:block}}</style></head>
<body><main class="shell"><header class="topbar"><div><div class="eyebrow">CAREER-OPS / PROFILE</div><h1 class="title">个人资料</h1><nav style="display:flex;gap:8px;margin-top:12px"><a class="link" href="index.html">岗位总览</a><a class="link" href="profile.html">个人资料</a><a class="link" href="settings.html">导出设置</a></nav></div><div class="eyebrow">本地资料 · 可编辑</div></header>
<section class="profile-intro"><h2>资料迁移</h2><p>导出 JSON 会包含模块化个人资料、个人信息 Markdown 和照片，便于在另一台设备的同一个 Workflow 中恢复使用。文件保存在你选择的下载位置，不会自动上传。</p><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button class="link" id="export-profile" type="button">导出个人资料 JSON</button><button class="link" id="import-profile" type="button">导入个人资料 JSON</button><input id="profile-file" type="file" accept="application/json,.json" hidden><span id="transfer-message" style="font-size:12px;color:#52606b"></span></div></section>
<form id="profile-form"><section class="profile-intro"><h2>基本信息</h2><div class="contacts"><label>姓名${input('identity.name', identity.name || '')}</label><label>邮箱${input('identity.email', identity.email || '', 'email')}</label><label>电话${input('identity.phone', identity.phone || '')}</label><label>地点${input('identity.location', identity.location || '')}</label></div><label>个人简介<textarea class="profile-input" name="summary">${escapeHtml(summary)}</textarea></label></section>
${groupHtml || '<div class="empty">暂未发现模块化个人资料。请先在 workflow-input/profile/ 中填写资料。</div>'}
<div class="savebar"><button class="save-button" type="submit">保存个人资料</button><span id="save-message">修改后点击保存，内容会写回本地 profile 目录。</span></div></form>
</main><script>(function(){const form=document.querySelector('#profile-form');const message=document.querySelector('#save-message');const transferMessage=document.querySelector('#transfer-message');const exportButton=document.querySelector('#export-profile');const importButton=document.querySelector('#import-profile');const fileInput=document.querySelector('#profile-file');if(exportButton){exportButton.addEventListener('click',async()=>{exportButton.disabled=true;transferMessage.textContent='正在准备 JSON…';try{const response=await fetch('/__workflow/profile/export',{method:'POST'});const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'导出失败');const blob=new Blob([JSON.stringify(data.profile,null,2)+'\\n'],{type:'application/json;charset=utf-8'});const url=URL.createObjectURL(blob);const link=document.createElement('a');const date=new Date().toISOString().slice(0,10);link.href=url;link.download='career-ops-profile-'+date+'.json';link.click();URL.revokeObjectURL(url);transferMessage.textContent='已导出 JSON，包含 '+(data.profile.modules?.length||0)+' 个资料模块和 '+(data.profile.photos?.length||0)+' 张照片';}catch(error){transferMessage.textContent='导出失败：'+(error.message||error)}finally{exportButton.disabled=false}});}if(importButton&&fileInput){importButton.addEventListener('click',()=>fileInput.click());fileInput.addEventListener('change',async()=>{const file=fileInput.files?.[0];if(!file)return;importButton.disabled=true;transferMessage.textContent='正在导入并保存…';try{const payload=JSON.parse(await file.text());const response=await fetch('/__workflow/profile/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'导入失败');transferMessage.textContent='导入成功，页面即将刷新';setTimeout(()=>location.reload(),500);}catch(error){transferMessage.textContent='导入失败：'+(error.message||error)}finally{importButton.disabled=false;fileInput.value='';}});}if(!form)return;form.addEventListener('submit',async(event)=>{event.preventDefault();const identity={};for(const field of form.querySelectorAll('[name^="identity."]'))identity[field.name.slice(9)]=field.value;const changes=[...form.querySelectorAll('[data-profile-item="true"]')].map(item=>({sourceFile:item.dataset.sourceFile,itemId:item.dataset.itemId,title:item.querySelector('[name="title"]').value,content:item.querySelector('[name="content"]').value,familiarity:item.querySelector('[name="familiarity"]')?.value,includeInCv:item.querySelector('[name="includeInCv"]')?.checked??true}));const button=form.querySelector('button[type="submit"]');button.disabled=true;message.textContent='正在保存…';try{const response=await fetch('/__workflow/profile/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({identity,summary:form.querySelector('[name="summary"]').value,changes})});const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'保存失败');message.textContent='已保存，页面将在几秒后刷新';setTimeout(()=>location.reload(),400)}catch(error){message.textContent='保存失败：'+(error.message||error)}finally{button.disabled=false}});})();</script></body></html>`;
}

async function renderProfilePage(root = ROOT) {
  const paths = await ensureWorkspace(root);
  const profile = await loadProfilePreview(root);
  await writeAtomic(paths.profilePage, renderProfileHtml(profile, root));
  return { path: paths.profilePage };
}

function renderSettingsHtml(settings) {
  const input = (name, value) => `<input class="path-input" name="${name}" value="${escapeAttr(value || '')}" placeholder="例如：C:\\Users\\你的用户名\\Desktop\\工作\\简历">`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Career-Ops 导出设置</title>
<style>:root{font-family:"Segoe UI","Microsoft YaHei",Arial,sans-serif;color:#20252b;background:#f5f7f9;line-height:1.5}*{box-sizing:border-box}body{margin:0}.shell{max-width:900px;margin:0 auto;padding:28px 24px 56px}.topbar{display:flex;justify-content:space-between;gap:20px;align-items:flex-end;border-bottom:1px solid #d9e0e6;padding-bottom:22px}.eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#64717e}.title{margin:4px 0 0;font-size:30px;line-height:1.15}.nav{display:flex;gap:8px;margin-top:12px}.link,.save-button{font-size:12px;color:#155d91;text-decoration:none;border:1px solid #bfd1df;border-radius:4px;padding:6px 9px;background:#fbfdff;cursor:pointer}.save-button{background:#155d91;color:#fff;border-color:#155d91}.card{margin-top:20px;background:#fff;border:1px solid #dfe5ea;border-radius:6px;padding:20px}.card h2{margin:0 0 8px;font-size:20px}.card p{color:#52606b;font-size:13px}.field{display:block;margin-top:16px;font-size:13px;color:#37434d}.path-input{display:block;width:100%;margin-top:6px;border:1px solid #cbd4dc;border-radius:4px;padding:10px;font:inherit}.actions{display:flex;align-items:center;gap:12px;margin-top:22px}.message{font-size:12px;color:#52606b}</style></head><body><main class="shell"><header class="topbar"><div><div class="eyebrow">CAREER-OPS / SETTINGS</div><h1 class="title">导出设置</h1><nav class="nav"><a class="link" href="index.html">岗位总览</a><a class="link" href="profile.html">个人资料</a><a class="link" href="settings.html">导出设置</a></nav></div><div class="eyebrow">本地配置</div></header>
<form id="settings-form"><section class="card"><h2>PDF 和 Word 导出路径</h2><p>填写绝对路径后，保存简历时会在工作流内部保留一份，同时复制一份到这里。留空则只保存到工作流输出目录。</p><label class="field">PDF 导出路径${input('pdfExportDir', settings.pdfExportDir)}</label><label class="field">Word 导出路径${input('wordExportDir', settings.wordExportDir)}</label><div class="actions"><button class="save-button" type="submit">保存设置</button><span class="message" id="message">修改后点击保存</span></div></section></form></main><script>(function(){const form=document.querySelector('#settings-form');const message=document.querySelector('#message');form.addEventListener('submit',async(e)=>{e.preventDefault();const body={};for(const field of form.querySelectorAll('input'))body[field.name]=field.value.trim();message.textContent='正在保存…';try{const response=await fetch('/__workflow/settings/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'保存失败');message.textContent='设置已保存';}catch(error){message.textContent='保存失败：'+(error.message||error)}})})();</script></body></html>`;
}

async function renderSettingsPage(root = ROOT) {
  const paths = await ensureWorkspace(root);
  const settings = await loadWorkflowSettings(root);
  await writeAtomic(paths.settingsPage, renderSettingsHtml(settings));
  return { path: paths.settingsPage };
}

async function saveProfile(payload, root = ROOT) {
  const paths = await ensureWorkspace(root);
  const profileConfigPath = join(paths.profileDir, 'profile.yml');
  let config = existsSync(profileConfigPath) ? (yamlLoad(await readFile(profileConfigPath, 'utf8')) || {}) : {};
  config.identity = { ...(config.identity || {}), ...(payload?.identity || {}) };
  if (payload?.summary !== undefined) config.summary = String(payload.summary);
  await writeAtomic(profileConfigPath, yamlDump(config, { noRefs: true, lineWidth: 120 }));

  for (const change of Array.isArray(payload?.changes) ? payload.changes : []) {
    const relativeFile = String(change?.sourceFile || '').replace(/\\/g, '/');
    const filePath = resolve(paths.root, relativeFile);
    if (!isWithinRoot(filePath, paths.profileDir) || !['.yml', '.yaml'].includes(extname(filePath).toLowerCase())) {
      throw new Error(`非法个人资料文件路径：${relativeFile}`);
    }
    if (!existsSync(filePath)) throw new Error(`个人资料文件不存在：${relativeFile}`);
    const raw = yamlLoad(await readFile(filePath, 'utf8')) || {};
    if (!Array.isArray(raw.items)) throw new Error(`个人资料文件不支持条目编辑：${relativeFile}`);
    const item = raw.items.find(candidate => String(candidate?.id || '') === String(change?.itemId || ''));
    if (!item) throw new Error(`未找到个人资料条目：${change?.itemId || ''}`);
    item.title = String(change.title ?? item.title ?? '');
    item.content = String(change.content ?? item.content ?? '');
    if (change.familiarity !== undefined && change.familiarity !== null && change.familiarity !== '') {
      const familiarityScore = Math.min(5, Math.max(1, Math.round(Number(change.familiarity) || 3)));
      item.familiarity = familiarityScore;
    }
    item.include_in_cv = change.includeInCv !== false;
    await writeAtomic(filePath, yamlDump(raw, { noRefs: true, lineWidth: 120 }));
  }
  await renderSummary(root);
  return { path: relative(root, profileConfigPath).split(sep).join('/'), updated: true };
}

async function renderSummary(root = ROOT) {
  const paths = await ensureWorkspace(root);
  const jobsIndex = await readJson(paths.jobsIndex, { jobs: [] });
  const records = await loadRecords(root);
  const html = renderSummaryHtml(records, jobsIndex.jobs || [], root);
  await writeAtomic(paths.summary, html);
  await renderProfilePage(root);
  await renderSettingsPage(root);
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
  const editable = join(paths.output, id, `${resumeFileName(record)}.html`);
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
  const finalPath = join(outputDir, `${resumeFileName(record)}.html`);
  const cleanedHtml = withA4PreviewLayout(cleanEditableHtml(html));
  await writeAtomic(finalPath, cleanedHtml);
  const finalRelative = relative(root, finalPath).split(sep).join('/');
  const artifacts = { ...(record.artifacts || {}), finalHtml: finalRelative };
  delete artifacts.finalHtmlHistory;
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

function withA4PreviewLayout(html) {
  const layoutStyle = `<style id="career-ops-a4-preview">
:root { --career-ops-a4-content-width: calc(210mm - 1.2in); }
@media screen {
  html { background: #eef2f5; }
  body { width: var(--career-ops-a4-content-width); min-width: var(--career-ops-a4-content-width); max-width: var(--career-ops-a4-content-width); margin: 0 auto; background: #fff; }
  .page { width: 100% !important; max-width: none !important; }
}
</style>`;
  return html.replace(/<style\b[^>]*id=["']career-ops-a4-preview["'][^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<\/head>/i, `${layoutStyle}</head>`);
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
  const wordPath = join(paths.output, id, `${resumeFileName(record)}.docx`);
  const result = spawnSync(process.execPath, [
    join(ROOT, 'generate-word.mjs'),
    '--html', finalPath,
    '--output', wordPath,
    '--photo-dir', paths.photos,
  ], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Word generation failed with ${result.status}`);
  record.artifacts = { ...(record.artifacts || {}), word: relative(root, wordPath).split(sep).join('/') };
  const settings = await loadWorkflowSettings(root);
  let exportPath = '';
  if (settings.wordExportDir) {
    exportPath = join(settings.wordExportDir, `${resumeFileName(record)}.docx`);
    await copyFile(wordPath, exportPath);
    record.artifacts.wordExport = exportPath;
  }
  record.resumeStatus = '已生成 Word';
  record.updatedAt = new Date().toISOString();
  await writeAtomic(recordFile, JSON.stringify(record, null, 2) + '\n');
  await writeMetadata(record, root);
  await renderSummary(root);
  return { path: relative(root, wordPath).split(sep).join('/'), exportPath, output: result.stdout };
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
  const factCheck = spawnSync(process.execPath, [
    'verify-cv-facts.mjs',
    finalPath,
    '--source', 'cv.md',
    '--source', 'article-digest.md',
    '--source', 'workflow-input/personal-info/personal-info.md',
  ], { cwd: root, encoding: 'utf8' });
  if (factCheck.status !== 0) throw new Error(factCheck.stderr || factCheck.stdout || 'CV fact check failed');
  const pdfPath = join(paths.output, id, `${resumeFileName(record)}.pdf`);
  const args = ['generate-pdf.mjs', finalPath, pdfPath, '--format=a4', '--max-pages=1', '--strict-pages'];
  if (record.reportNumber) args.push(`--report=${record.reportNumber}`);
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `PDF generation failed with ${result.status}`);
  record.artifacts = { ...(record.artifacts || {}), pdf: relative(root, pdfPath).split(sep).join('/') };
  const settings = await loadWorkflowSettings(root);
  let exportPath = '';
  if (settings.pdfExportDir) {
    exportPath = join(settings.pdfExportDir, `${resumeFileName(record)}.pdf`);
    await copyFile(pdfPath, exportPath);
    record.artifacts.pdfExport = exportPath;
  }
  record.resumeStatus = '已生成 PDF';
  record.updatedAt = new Date().toISOString();
  await writeAtomic(recordFile, JSON.stringify(record, null, 2) + '\n');
  await writeMetadata(record, root);
  await renderSummary(root);
  return { path: relative(root, pdfPath).split(sep).join('/'), exportPath, output: result.stdout };
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
  deleteWorkflowJob,
  MAX_EDITABLE_HTML_BYTES,
  ROOT,
  assertResumeGate,
  cleanEditableHtml,
  editableInjection,
  ensureWorkspace,
  exportProfile,
  inspectProfile,
  ingest,
  importProfile,
  loadRecords,
  pathsFor,
  prepareEditable,
  promoteProfileDraft,
  readJson,
  renderPdf,
  renderWord,
  renderSummary,
  renderSummaryHtml,
  renderSettingsPage,
  resolveWorkspacePath,
  resumeFileName,
  passesResumeGate,
  writeAdviceArtifact,
  safeId,
  saveRecord,
  saveFinalHtml,
  saveProfile,
  saveWorkflowSettings,
};

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
