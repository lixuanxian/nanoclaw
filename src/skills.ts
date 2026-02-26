/**
 * Skills service for NanoClaw.
 * Lists, creates, deletes, and manages skills from:
 * - container/skills/ (builtin)
 * - store/custom-skills/ (user-created)
 */
import fs from 'fs';
import path from 'path';

import { STORE_DIR } from './config.js';
import { logger } from './logger.js';
import type { SkillInfo } from './types.js';

const BUILTIN_SKILLS_DIR = path.join(process.cwd(), 'container', 'skills');
const CUSTOM_SKILLS_DIR = path.join(STORE_DIR, 'custom-skills');
const SKILLS_CONFIG_KEY = '_skills';
const CONFIG_PATH = path.join(STORE_DIR, 'channel-config.json');

// --- Config persistence (reuses channel-config.json under _skills key) ---

function readAllConfig(): Record<string, unknown> {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch { /* corrupted — start fresh */ }
  return {};
}

function writeAllConfig(configs: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(configs, null, 2) + '\n');
}

function loadSkillsConfig(): Record<string, { enabled: boolean }> {
  const all = readAllConfig();
  const raw = all[SKILLS_CONFIG_KEY];
  if (raw && typeof raw === 'object') return raw as Record<string, { enabled: boolean }>;
  return {};
}

function saveSkillsConfig(config: Record<string, { enabled: boolean }>): void {
  const all = readAllConfig();
  all[SKILLS_CONFIG_KEY] = config;
  writeAllConfig(all);
}

// --- SKILL.md frontmatter parsing ---

interface SkillFrontmatter {
  name: string;
  description: string;
}

function parseFrontmatter(content: string): SkillFrontmatter {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { name: '', description: '' };
  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      // Strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
  }
  return { name: result.name || '', description: result.description || '' };
}

// --- Skill listing ---

export function listAllSkills(): SkillInfo[] {
  const config = loadSkillsConfig();
  const skills: SkillInfo[] = [];

  // Builtin skills from container/skills/
  if (fs.existsSync(BUILTIN_SKILLS_DIR)) {
    for (const dir of fs.readdirSync(BUILTIN_SKILLS_DIR)) {
      const skillMd = path.join(BUILTIN_SKILLS_DIR, dir, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      const content = fs.readFileSync(skillMd, 'utf-8');
      const fm = parseFrontmatter(content);
      skills.push({
        id: dir,
        name: fm.name || dir,
        description: fm.description || '',
        type: 'builtin',
        enabled: config[dir]?.enabled !== false,
      });
    }
  }

  // Custom skills from store/custom-skills/
  if (fs.existsSync(CUSTOM_SKILLS_DIR)) {
    for (const dir of fs.readdirSync(CUSTOM_SKILLS_DIR)) {
      const skillMd = path.join(CUSTOM_SKILLS_DIR, dir, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      const content = fs.readFileSync(skillMd, 'utf-8');
      const fm = parseFrontmatter(content);
      const id = `custom-${dir}`;
      skills.push({
        id,
        name: fm.name || dir,
        description: fm.description || '',
        type: 'custom',
        enabled: config[id]?.enabled !== false,
      });
    }
  }

  return skills;
}

// --- Skill content retrieval ---

export function getSkillContents(ids: string[]): Array<{ name: string; content: string }> {
  const results: Array<{ name: string; content: string }> = [];
  for (const id of ids) {
    let skillMdPath: string;
    if (id.startsWith('custom-')) {
      const dirName = id.replace(/^custom-/, '');
      skillMdPath = path.join(CUSTOM_SKILLS_DIR, dirName, 'SKILL.md');
    } else {
      skillMdPath = path.join(BUILTIN_SKILLS_DIR, id, 'SKILL.md');
    }
    if (!fs.existsSync(skillMdPath)) continue;
    const content = fs.readFileSync(skillMdPath, 'utf-8');
    const fm = parseFrontmatter(content);
    results.push({ name: fm.name || id, content });
  }
  return results;
}

// --- CRUD operations ---

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || `skill-${Date.now()}`;
}

export function createCustomSkill(
  name: string,
  description: string,
  content: string,
): SkillInfo {
  const slug = slugify(name);
  const dir = path.join(CUSTOM_SKILLS_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });

  const skillMd = `---\nname: "${name}"\ndescription: "${description}"\n---\n\n${content}`;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd);

  const id = `custom-${slug}`;
  logger.info({ id, name }, 'Custom skill created');
  return { id, name, description, type: 'custom', enabled: true };
}

export function deleteCustomSkill(id: string): void {
  if (!id.startsWith('custom-')) return;
  const dirName = id.replace(/^custom-/, '');
  const dir = path.join(CUSTOM_SKILLS_DIR, dirName);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    logger.info({ id }, 'Custom skill deleted');
  }
  // Also remove from config
  const config = loadSkillsConfig();
  delete config[id];
  saveSkillsConfig(config);
}

export function toggleSkill(id: string, enabled: boolean): void {
  const config = loadSkillsConfig();
  config[id] = { enabled };
  saveSkillsConfig(config);
  logger.info({ id, enabled }, 'Skill toggled');
}

// --- Remote skill installation ---

const MAX_SKILL_SIZE = 512 * 1024; // 512 KB

/** Block fetches to private/reserved IP ranges and non-HTTP schemes. */
function validateSkillUrl(raw: string): URL {
  const parsed = new URL(raw);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only http/https URLs are allowed');
  }
  const hostname = parsed.hostname.toLowerCase();
  // Block obvious private/reserved hostnames
  if (
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new Error('Fetching from local/private hosts is not allowed');
  }
  // Block private IPv4 ranges and link-local (metadata endpoints)
  const ipv4Match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) || // link-local / cloud metadata
      a === 0
    ) {
      throw new Error('Fetching from private/reserved IP ranges is not allowed');
    }
  }
  return parsed;
}

export async function installRemoteSkill(url: string): Promise<SkillInfo> {
  validateSkillUrl(url);
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Failed to fetch: ${res.status} ${res.statusText}`);
  const content = await res.text();
  if (content.length > MAX_SKILL_SIZE) {
    throw new Error(`Skill content too large (${content.length} bytes, max ${MAX_SKILL_SIZE})`);
  }

  const fm = parseFrontmatter(content);
  const name = fm.name || new URL(url).pathname.split('/').pop()?.replace('.md', '') || 'remote-skill';
  const description = fm.description || `Installed from ${new URL(url).hostname}`;

  // Save as custom skill
  const slug = slugify(name);
  const dir = path.join(CUSTOM_SKILLS_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content);

  const id = `custom-${slug}`;
  logger.info({ id, name, url }, 'Remote skill installed');
  return { id, name, description, type: 'custom', enabled: true };
}

// --- Custom skills directory for container sync ---

export { CUSTOM_SKILLS_DIR };
