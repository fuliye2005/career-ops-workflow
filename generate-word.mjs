#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseImageDataUrl } from './utils/profile-photo.mjs';
import {
  AlignmentType,
  BorderStyle,
  Document,
  ImageRun,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from 'docx';

const IMAGE_TYPES = new Map([
  ['.png', 'png'],
  ['.jpg', 'jpg'],
  ['.jpeg', 'jpg'],
  ['.gif', 'gif'],
  ['.bmp', 'bmp'],
]);
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const NO_BORDERS = {
  top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
};

class Node {
  constructor(tag = 'root', attrs = {}) {
    this.tag = tag;
    this.attrs = attrs;
    this.children = [];
  }

  classes() {
    return new Set(String(this.attrs.class || '').split(/\s+/).filter(Boolean));
  }

  text() {
    return decodeEntities(this.children.map(child => typeof child === 'string' ? child : child.text()).join(''))
      .replace(/\s+/g, ' ')
      .trim();
  }

  directText() {
    return decodeEntities(this.children.filter(child => typeof child === 'string').join(''))
      .replace(/\s+/g, ' ')
      .trim();
  }

  findFirst(className = null, tag = null) {
    for (const child of this.children) {
      if (!(child instanceof Node)) continue;
      if ((!className || child.classes().has(className)) && (!tag || child.tag === tag)) return child;
      const found = child.findFirst(className, tag);
      if (found) return found;
    }
    return null;
  }

  findAll(className = null, tag = null) {
    const found = [];
    for (const child of this.children) {
      if (!(child instanceof Node)) continue;
      if ((!className || child.classes().has(className)) && (!tag || child.tag === tag)) found.push(child);
      found.push(...child.findAll(className, tag));
    }
    return found;
  }
}

function decodeEntities(value) {
  const named = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };
  return String(value).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, key) => {
    if (key.startsWith('#x')) return String.fromCodePoint(Number.parseInt(key.slice(2), 16));
    if (key.startsWith('#')) return String.fromCodePoint(Number.parseInt(key.slice(1), 10));
    return named[key.toLowerCase()] || match;
  });
}

function parseAttributes(raw) {
  const attrs = {};
  const pattern = /([:\w-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
  let match;
  while ((match = pattern.exec(raw))) {
    const key = match[1].toLowerCase();
    if (key === 'class' || key === 'src' || key === 'alt') {
      attrs[key] = String(match[2] || '').replace(/^['"]|['"]$/g, '');
    }
  }
  return attrs;
}

function parseHtml(source) {
  const root = new Node();
  const stack = [root];
  let skipDepth = 0;
  const tokens = String(source).match(/<!--[\s\S]*?-->|<!doctype[^>]*>|<\/?[^>]+>|[^<]+/gi) || [];
  for (const token of tokens) {
    if (/^<!--/.test(token) || /^<!doctype/i.test(token)) continue;
    if (/^<\//.test(token)) {
      const tag = token.match(/^<\/\s*([\w-]+)/)?.[1]?.toLowerCase();
      if (tag === 'style' || tag === 'script' || tag === 'svg') {
        if (skipDepth) skipDepth -= 1;
        continue;
      }
      if (skipDepth) continue;
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].tag === tag) {
          stack.length = index;
          break;
        }
      }
      continue;
    }
    if (/^</.test(token)) {
      const match = token.match(/^<\s*([\w-]+)([\s\S]*?)>$/);
      if (!match) continue;
      const tag = match[1].toLowerCase();
      if (tag === 'style' || tag === 'script' || tag === 'svg') {
        skipDepth += 1;
        continue;
      }
      if (skipDepth) continue;
      const node = new Node(tag, parseAttributes(match[2]));
      stack[stack.length - 1].children.push(node);
      if (!VOID_TAGS.has(tag) && !/\/\s*>$/.test(token)) stack.push(node);
      continue;
    }
    if (!skipDepth) stack[stack.length - 1].children.push(token);
  }
  return root;
}

function run(text, options = {}) {
  return new TextRun({
    text: String(text || ''),
    font: 'Microsoft YaHei',
    size: options.size || 18,
    bold: Boolean(options.bold),
    color: options.color || '1A1A2E',
    italics: Boolean(options.italics),
  });
}

function paragraph(children = [], options = {}) {
  return new Paragraph({
    children,
    alignment: options.alignment,
    keepNext: options.keepNext,
    spacing: options.spacing || { after: 70, line: 245 },
    indent: options.indent,
    border: options.border,
  });
}

function cell(children, options = {}) {
  return new TableCell({
    children,
    width: options.width ? { size: options.width, type: WidthType.DXA } : undefined,
    verticalAlign: options.verticalAlign || VerticalAlign.TOP,
    margins: { top: 0, bottom: 0, left: options.leftMargin || 0, right: options.rightMargin || 0 },
    borders: NO_BORDERS,
    shading: options.shading ? { fill: options.shading, type: ShadingType.CLEAR } : undefined,
  });
}

function twoColumnTable(leftChildren, rightChildren, leftWidth = 6500, rightWidth = 1100) {
  return new Table({
    rows: [new TableRow({ children: [cell(leftChildren, { width: leftWidth, rightMargin: 90 }), cell(rightChildren, { width: rightWidth, leftMargin: 60 })] })],
    width: { size: leftWidth + rightWidth, type: WidthType.DXA },
    columnWidths: [leftWidth, rightWidth],
    borders: NO_BORDERS,
  });
}

function sectionTitle(title) {
  return paragraph([run(title, { size: 20, bold: true, color: '16727A' })], {
    keepNext: true,
    spacing: { before: 90, after: 75, line: 245 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: 'E2E2E2', space: 1 } },
  });
}

function bodyParagraph(text, size = 18, after = 70) {
  return paragraph([run(text, { size })], { spacing: { after, line: 265 } });
}

function listParagraph(text) {
  return new Paragraph({
    children: [run(text, { size: 17 })],
    bullet: { level: 0 },
    spacing: { after: 30, line: 250 },
    indent: { left: 300, hanging: 160 },
  });
}

function findSection(page, title) {
  return page.findAll('section').find(section => section.findFirst('section-title')?.text() === title) || null;
}

function renderHeader(page, photoSource) {
  const header = page.findFirst('header');
  const name = header?.findFirst(null, 'h1')?.text() || '个人简历';
  const contacts = header?.findFirst('contact-row')?.findAll(null, 'a').map(item => item.text()).filter(Boolean) || [];
  const left = [
    paragraph([run(name, { size: 45, bold: true })], { spacing: { after: 70, line: 240 } }),
    paragraph([], { spacing: { after: 75, line: 40 }, border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: '16727A', space: 1 } } }),
    paragraph([run(contacts.join('  |  '), { size: 18, color: '555555' })], { spacing: { after: 80, line: 230 } }),
  ];
  if (!photoSource) {
    return left;
  }

  const right = [paragraph([new ImageRun({ data: photoSource.data, type: photoSource.type, transformation: { width: 104, height: 138 } })], { alignment: AlignmentType.RIGHT, spacing: { after: 0, line: 200 } })];
  return [twoColumnTable(left, right, 9000, 1450)];
}

function photoSourceFromPath(filePath) {
  if (!filePath) return null;
  const type = IMAGE_TYPES.get(extname(filePath).toLowerCase());
  return type ? { data: readFileSync(filePath), type, path: filePath } : null;
}

function renderWork(section) {
  const result = [sectionTitle('工作经历')];
  for (const job of section.findAll('job')) {
    const company = job.findFirst('job-company')?.text() || '';
    const period = job.findFirst('job-period')?.text() || '';
    result.push(twoColumnTable([paragraph([run(company, { size: 19, bold: true })], { spacing: { after: 0, line: 230 } })], [paragraph([run(period, { size: 17, color: '555555' })], { alignment: AlignmentType.RIGHT, spacing: { after: 0, line: 230 } })]));
    const role = job.findFirst('job-role');
    const location = job.findFirst('job-location');
    if (role) result.push(paragraph([run(role.text(), { size: 18, color: '16727A' })], { spacing: { after: 0, line: 230 } }));
    if (location) result.push(paragraph([run(location.text(), { size: 17, color: '777777' })], { spacing: { after: 40, line: 230 } }));
    const list = job.findFirst(null, 'ul');
    for (const item of list?.findAll(null, 'li') || []) result.push(listParagraph(item.text()));
  }
  return result;
}

function renderProjects(section) {
  const result = [sectionTitle('项目经历')];
  for (const project of section.findAll('project')) {
    const title = project.findFirst('project-title');
    const badge = title?.findFirst('project-badge');
    const titleRuns = [run(title?.directText() || title?.text() || '', { size: 18, bold: true })];
    if (badge) titleRuns.push(run(`  ${badge.text()}`, { size: 16, color: '16727A' }));
    result.push(paragraph(titleRuns, { spacing: { after: 30, line: 230 } }));
    const description = project.findFirst('project-desc');
    if (description?.text()) result.push(bodyParagraph(description.text(), 17, 65));
    const bullets = project.findFirst('project-bullets');
    for (const item of bullets?.findAll(null, 'li') || []) result.push(listParagraph(item.text()));
  }
  return result;
}

function renderEducation(section) {
  const result = [sectionTitle('教育背景')];
  for (const item of section.findAll('edu-item')) {
    const title = item.findFirst('edu-title');
    const org = title?.findFirst('edu-org');
    const titleText = `${title?.directText() || ''}${org ? `  ${org.text()}` : ''}`;
    result.push(twoColumnTable([paragraph([run(titleText, { size: 18, bold: true })], { spacing: { after: 0, line: 230 } })], [paragraph([run(item.findFirst('edu-year')?.text() || '', { size: 17, color: '555555' })], { alignment: AlignmentType.RIGHT, spacing: { after: 0, line: 230 } })]));
    const desc = item.findFirst('edu-desc');
    if (desc) result.push(bodyParagraph(desc.text(), 17, 40));
  }
  return result;
}

function renderSkills(section) {
  const result = [sectionTitle('技能')];
  for (const item of section.findAll('skill-item')) {
    const category = item.findFirst('skill-category');
    const full = item.text();
    const categoryText = category?.text() || '';
    result.push(paragraph([
      ...(category ? [run(categoryText, { size: 17, bold: true, color: '16727A' })] : []),
      run(category ? full.slice(categoryText.length).trim() : full, { size: 17 }),
    ], { spacing: { after: 35, line: 250 } }));
  }
  return result;
}

function findHtmlPhoto(tree, htmlPath) {
  const image = tree.findFirst('cv-photo');
  const source = image?.attrs?.src;
  if (!source) return null;
  if (/^data:/i.test(source)) {
    const parsed = parseImageDataUrl(source);
    if (!parsed) return null;
    const type = parsed.mime === 'image/gif' ? 'gif' : parsed.mime === 'image/png' ? 'png' : parsed.mime === 'image/jpeg' ? 'jpg' : null;
    return type ? { data: parsed.bytes, type } : null;
  }
  const candidate = resolve(dirname(htmlPath), source);
  const type = IMAGE_TYPES.get(extname(candidate).toLowerCase());
  return type && existsSync(candidate) ? photoSourceFromPath(candidate) : null;
}
export async function findFirstPhoto(photoDir) {
  if (!photoDir || !existsSync(photoDir)) return null;
  const entries = await readdir(photoDir, { withFileTypes: true });
  const photo = entries
    .filter(entry => entry.isFile() && IMAGE_TYPES.has(extname(entry.name).toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name))[0];
  return photo ? resolve(photoDir, photo.name) : null;
}

export async function generateDocxFromHtml({ htmlPath, outputPath, photoDir = null }) {
  const source = await readFile(htmlPath, 'utf8');
  const tree = parseHtml(source);
  const page = tree.findFirst('page') || tree.findFirst(null, 'body') || tree;
  const photoSource = findHtmlPhoto(tree, htmlPath) || photoSourceFromPath(await findFirstPhoto(photoDir));
  const children = renderHeader(page, photoSource);

  const summary = page.findFirst('summary-text');
  if (summary) children.push(sectionTitle('个人简介'), bodyParagraph(summary.text(), 18, 45));
  const competencies = page.findFirst('competencies-grid');
  if (competencies) {
    children.push(sectionTitle('核心能力'));
    children.push(bodyParagraph(competencies.findAll('competency-tag').map(item => item.text()).join('  '), 17, 45));
  }
  const work = findSection(page, '工作经历');
  if (work) children.push(...renderWork(work));
  const projects = findSection(page, '项目经历');
  if (projects) children.push(...renderProjects(projects));
  const education = findSection(page, '教育背景');
  if (education) children.push(...renderEducation(education));
  const skills = findSection(page, '技能');
  if (skills) children.push(...renderSkills(skills));

  const document = new Document({
    creator: 'Career-Ops workflow',
    title: '岗位定制简历',
    description: 'Generated from the confirmed Career-Ops HTML resume.',
    sections: [{
      properties: {
        page: { size: { width: 11906, height: 16838 }, margin: { top: 660, right: 660, bottom: 660, left: 660 } },
      },
      children,
    }],
  });
  const buffer = await Packer.toBuffer(document);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, buffer);
  return { outputPath, photoPath: photoSource?.path || null };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) continue;
    args[value.slice(2)] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.html || !args.output) {
    console.error('Usage: node generate-word.mjs --html <final.html> --output <resume.docx> [--photo-dir <dir>]');
    process.exitCode = 1;
  } else {
    generateDocxFromHtml({ htmlPath: resolve(args.html), outputPath: resolve(args.output), photoDir: args['photo-dir'] ? resolve(args['photo-dir']) : null })
      .then(result => console.log(JSON.stringify({ ok: true, ...result }, null, 2)))
      .catch(error => {
        console.error(`word: ${error.message}`);
        process.exitCode = 1;
      });
  }
}
