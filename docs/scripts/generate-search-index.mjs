#!/usr/bin/env node

/**
 * Generate static search index and 3-tier progressive disclosure indexes
 * (llms.txt, catalog.json, categories/<slug>.{json,md}, hips/<slug>.md)
 * from HIP markdown files during prebuild.
 */

import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';

const HIPS_DIR = path.join(process.cwd(), '../HIPs');
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const OUTPUT = path.join(PUBLIC_DIR, 'search-index.json');
const CATEGORIES_DIR = path.join(PUBLIC_DIR, 'categories');
const RAW_HIPS_DIR = path.join(PUBLIC_DIR, 'hips');

const CATEGORY_ORDER = [
  ['core', 'Core AI & Models', 'Core architecture, governance, Zen models, and foundational specifications.'],
  ['infrastructure', 'Cloud & Infrastructure', 'Compute, networking, storage, scheduling, and cloud platform standards.'],
  ['interface', 'Interfaces & Protocols', 'ZAP, MCP, SDKs, APIs, and realtime wire protocols.'],
  ['security', 'Security, IAM & Cryptography', 'Identity, KMS, zero-trust boundaries, and post-quantum cryptography.'],
  ['application', 'Platform & Applications', 'Developer tools, agent surfaces, operator apps, and ecosystem products.'],
];

function classifyCategory(rawCat, hipNumber) {
  const c = String(rawCat || '').trim().toLowerCase();
  const n = Number(hipNumber);
  if (c === 'core' || c === 'meta' || c === 'general' || c === 'governance') return 'core';
  if (c === 'security' || c === 'cryptography') return 'security';
  if (c === 'interface' || c === 'protocol') return 'interface';
  if (c === 'application' || c === 'operator' || c === 'platform') return 'application';
  if (c === 'infrastructure' || c === 'bridge') return 'infrastructure';
  if (Number.isFinite(n) && n >= 400) return 'application';
  return 'infrastructure';
}

function writeCleanDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function main() {
  if (!fs.existsSync(PUBLIC_DIR)) {
    fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  }
  writeCleanDir(CATEGORIES_DIR);
  writeCleanDir(RAW_HIPS_DIR);

  const files = fs.readdirSync(HIPS_DIR)
    .filter(f => f.endsWith('.md') || f.endsWith('.mdx'))
    .filter(f => f.startsWith('hip-'));

  const index = [];
  const byCategory = new Map(CATEGORY_ORDER.map(([slug]) => [slug, []]));

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(HIPS_DIR, file), 'utf8');
      const { data, content: body } = matter(content);

      const hipMatch = file.match(/hip-(\d+)/);
      const hipNumber = data.hip ?? (hipMatch ? parseInt(hipMatch[1], 10) : null);
      const slug = file.replace(/\.mdx?$/, '');
      const title = String(data.title || slug).trim();
      const description = String(data.description || '').trim();
      const status = String(data.status || '').trim();
      const type = String(data.type || '').trim();
      const rawCategory = String(data.category || '').trim();
      const tags = Array.isArray(data.tags) ? data.tags.map(String) : [];

      index.push({
        id: slug,
        url: `/docs/${slug}`,
        title,
        description,
        content: body.substring(0, 500),
        structuredData: {
          hip: hipNumber,
          status,
          type,
          category: rawCategory,
          tags,
        },
      });

      // Tier 2: publish raw HIP markdown for on-demand agent fetches
      fs.writeFileSync(path.join(RAW_HIPS_DIR, `${slug}.md`), content);

      const catSlug = classifyCategory(rawCategory, hipNumber);
      const summary = description || `HIP-${hipNumber ?? slug}: ${title}${status ? ` (${status})` : ''}.`;
      byCategory.get(catSlug).push({
        id: slug,
        hip: hipNumber,
        title,
        status,
        category: catSlug,
        summary: summary.length > 220 ? `${summary.slice(0, 217)}...` : summary,
        tags,
        url: `/hips/${slug}.md`,
        docs: `/docs/${slug}`,
      });
    } catch (err) {
      console.error(`Error processing ${file}:`, err.message);
    }
  }

  index.sort((a, b) => (a.structuredData.hip ?? 9999) - (b.structuredData.hip ?? 9999));
  fs.writeFileSync(OUTPUT, JSON.stringify(index, null, 2));

  // Tier 1: per-category JSON + Markdown indexes
  const categories = [];
  for (const [slug, label, catDesc] of CATEGORY_ORDER) {
    const items = (byCategory.get(slug) || []).sort((a, b) => (a.hip ?? 9999) - (b.hip ?? 9999));
    if (!items.length) continue;

    const catJson = {
      slug,
      label,
      summary: catDesc,
      count: items.length,
      catalog: '/catalog.json',
      md: `/categories/${slug}.md`,
      hips: items,
    };
    fs.writeFileSync(
      path.join(CATEGORIES_DIR, `${slug}.json`),
      `${JSON.stringify(catJson)}\n`
    );

    const mdLines = [
      `# ${label} (${items.length} HIPs)\n\n`,
      `> ${catDesc}\n`,
      `> Tier 0 index: [llms.txt](https://hips.hanzo.ai/llms.txt) · [catalog.json](https://hips.hanzo.ai/catalog.json) · [JSON](https://hips.hanzo.ai/categories/${slug}.json)\n\n`,
      'Fetch a single HIP on demand: `curl -fsSL https://hips.hanzo.ai/hips/<slug>.md`\n\n',
      ...items.map(
        it => `- [${it.id}](https://hips.hanzo.ai/hips/${it.id}.md) (${it.status || 'Draft'}) — ${it.title}\n`
      ),
    ];
    fs.writeFileSync(path.join(CATEGORIES_DIR, `${slug}.md`), mdLines.join(''));

    categories.push({
      slug,
      label,
      summary: catDesc,
      count: items.length,
      json: `/categories/${slug}.json`,
      md: `/categories/${slug}.md`,
      sample: items.slice(0, 5).map(it => it.id),
    });
  }

  // Tier 0: compact catalog.json and llms.txt
  const catalog = {
    version: '1.0.0',
    total: index.length,
    philosophy: 'Hanzo Improvement Proposals (HIPs) define open architectural specifications for Hanzo AI, Cloud, ZAP, MCP, IAM, KMS, and Zen models.',
    discovery: {
      tier0: {
        llms: 'https://hips.hanzo.ai/llms.txt',
        catalog: 'https://hips.hanzo.ai/catalog.json',
        skills: 'https://hanzoskills.com/llms.txt',
      },
      tier1: {
        category_json: 'https://hips.hanzo.ai/categories/{slug}.json',
        category_md: 'https://hips.hanzo.ai/categories/{slug}.md',
        search_index: 'https://hips.hanzo.ai/search-index.json',
      },
      tier2: {
        hip_md: 'https://hips.hanzo.ai/hips/{slug}.md',
        docs_html: 'https://hips.hanzo.ai/docs/{slug}',
      },
    },
    categories,
  };
  fs.writeFileSync(
    path.join(PUBLIC_DIR, 'catalog.json'),
    `${JSON.stringify(catalog, null, 2)}\n`
  );

  const llms = [
    '# Hanzo Improvement Proposals (HIPs)\n\n',
    `> ${index.length} architectural specifications across ${categories.length} categories for Hanzo AI infrastructure, protocols, security, and platform applications.\n`,
    '> Open-source, plain markdown over HTTPS, zero auth.\n\n',
    '## Progressive Discovery (3 Tiers — Load Only What You Need)\n\n',
    '1. **Tier 0 (this file)**: Pick a category below or read `GET https://hips.hanzo.ai/catalog.json`.\n',
    '2. **Tier 1 (category index)**: Fetch ONLY the matching category `GET https://hips.hanzo.ai/categories/<slug>.md` (or `.json`).\n',
    '3. **Tier 2 (single HIP)**: Fetch ONLY the specification you need via `GET https://hips.hanzo.ai/hips/<slug>.md` (HTML at `/docs/<slug>`).\n\n',
    '## Ecosystem\n\n',
    '- [Hanzo Skills (Progressive Index)](https://hanzoskills.com/llms.txt): actionable agent skills & guides.\n',
    '- [API Reference](https://docs.hanzo.ai/llms.txt): api.hanzo.ai operations.\n',
    '- [Hanzo AI](https://hanzo.ai/llms.txt): company & platform overview.\n\n',
    '## Categories (Tier 1 Indexes)\n\n',
    ...categories.map(
      c => `- [${c.label}](https://hips.hanzo.ai/categories/${c.slug}.md) (${c.count} HIPs · [JSON](https://hips.hanzo.ai/categories/${c.slug}.json)): ${c.summary} Samples: ${c.sample.slice(0, 4).join(', ')}.\n`
    ),
  ];
  fs.writeFileSync(path.join(PUBLIC_DIR, 'llms.txt'), llms.join(''));

  console.log(
    `[search-index] Generated ${index.length} entries → public/search-index.json, ` +
    `llms.txt (${Buffer.byteLength(llms.join(''))} B), catalog.json, ` +
    `${categories.length} categories, ${index.length} raw HIPs`
  );
}

main();
