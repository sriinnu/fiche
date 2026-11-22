import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Guard against docs drift: markdown links (and their #fragments) that rot when
// files move, get renamed, or lose a heading. Dependency-light: pure fs + regex,
// runs inside the existing `pnpm test` / CI. Covers inline links, image links,
// reference-style links, and simple HTML href/src across the tracked docs.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** README + top docs + docs/**, wiki/**, plugins/fiche-telemetry/**, and eval/**\/README.md markdown files. */
function markdownFiles(): string[] {
  const out = ['README.md', 'CHANGELOG.md', 'FINDINGS.md', 'SECURITY.md', 'CONTRIBUTING.md'];
  const walk = (rel: string, opts: { onlyReadme?: boolean } = {}): void => {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) return;
    for (const name of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = path.join(rel, name.name);
      if (name.isDirectory()) {
        if (name.name === 'node_modules' || name.name.startsWith('.')) continue;
        walk(childRel, opts);
      } else if (name.name.endsWith('.md')) {
        // eval/ holds huge run logs; only its READMEs are prose worth link-checking.
        if (opts.onlyReadme && name.name !== 'README.md') continue;
        // Forward slashes so assertions and anchorsByFile keys match on Windows.
        out.push(childRel.replace(/\\/g, '/'));
      }
    }
  };
  walk('docs');
  walk('wiki');
  walk('plugins/fiche-telemetry');
  walk('eval', { onlyReadme: true });
  return [...new Set(out)].filter((f) => fs.existsSync(path.join(repoRoot, f)));
}

/** True GitHub Flavored Markdown heading anchor slug (matches github-slugger). */
function slugify(heading: string): string {
  return heading
    .trim()
    .replace(/<[^>]+>/g, '') // strip inline HTML tags
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // image alt text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // inline link text
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1') // reference link text
    .replace(/`([^`]*)`/g, '$1') // inline code
    .replace(/\*\*|__|~~/g, '') // bold/strikethrough delimiters
    .replace(/(^|\s)[*_]+|[*_]+(\s|$)/g, '$1$2') // italic delimiters (keep snake_case _)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/ /g, '-');
}

/** Set of heading anchors defined in a markdown file (skips fenced code, deduplicates GFM -1/-2). */
function headingAnchors(md: string): Set<string> {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  let inFence = false;
  for (const line of md.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      const base = slugify(m[1]!);
      const seen = counts.get(base) ?? 0;
      counts.set(base, seen + 1);
      anchors.add(seen === 0 ? base : `${base}-${seen}`);
    }
  }
  return anchors;
}

interface Link {
  readonly target: string; // path portion (may be empty for same-page #frag)
  readonly fragment: string | null;
  readonly raw: string;
}

const EXTERNAL = /^(?:https?:|mailto:|data:|tel:|ftp:|customization:)/i;

/** Strip fenced code blocks (``` or ~~~) so code examples never trigger false links. */
function stripFencedCode(md: string): string {
  const lines: string[] = [];
  let inFence = false;
  for (const line of md.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) lines.push(line);
  }
  return lines.join('\n');
}

/** Extract every local link target from a markdown file: inline `](x)` / images,
 *  reference definitions `[ref]: x`, and HTML `href=`/`src=`/`srcset=`. */
function localLinks(md: string): Link[] {
  const body = stripFencedCode(md);
  const links: Link[] = [];
  const push = (rawTarget: string): void => {
    let t = rawTarget.trim();
    if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1);
    t = t.split(/\s+/)[0]!; // drop an optional "title" or srcset descriptor
    if (!t || EXTERNAL.test(t)) return;
    const hash = t.indexOf('#');
    const target = hash >= 0 ? t.slice(0, hash) : t;
    const fragment = hash >= 0 ? t.slice(hash + 1) : null;
    links.push({ target: target.split('?')[0]!, fragment, raw: rawTarget });
  };
  for (const m of body.matchAll(/\]\(([^)]+)\)/g)) push(m[1]!); // inline + image
  for (const m of body.matchAll(/^\s*\[[^\]]+\]:\s*(\S.*)$/gm)) push(m[1]!); // reference defs
  for (const m of body.matchAll(/(?:href|src)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) {
    push((m[1] ?? m[2])!);
  }
  for (const m of body.matchAll(/srcset\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) {
    const list = (m[1] ?? m[2])!;
    for (const candidate of list.split(',')) {
      if (candidate.trim()) push(candidate);
    }
  }
  return links;
}

/** Extract HTML <img src> and <source srcset> local asset targets from markdown. */
function htmlMediaPaths(md: string): string[] {
  const body = stripFencedCode(md);
  const out: string[] = [];
  for (const m of body.matchAll(/<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi)) {
    const val = (m[1] ?? m[2] ?? '').trim();
    if (val && !EXTERNAL.test(val)) out.push(val.split('?')[0]!.split('#')[0]!);
  }
  for (const m of body.matchAll(/<source\b[^>]*\bsrcset\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi)) {
    const val = (m[1] ?? m[2] ?? '').trim();
    for (const candidate of val.split(',')) {
      const url = candidate.trim().split(/\s+/)[0] ?? '';
      if (url && !EXTERNAL.test(url)) out.push(url.split('?')[0]!.split('#')[0]!);
    }
  }
  return out;
}

describe('docs integrity', () => {
  const files = markdownFiles();
  const anchorsByFile = new Map<string, Set<string>>();
  for (const f of files) anchorsByFile.set(f, headingAnchors(fs.readFileSync(path.join(repoRoot, f), 'utf8')));

  it('scans README, CHANGELOG, FINDINGS, SECURITY, CONTRIBUTING, docs/**, wiki/**, plugins/fiche-telemetry/**, and eval/**/README.md', () => {
    expect(files).toContain('README.md');
    expect(files).toContain('SECURITY.md');
    expect(files).toContain('CONTRIBUTING.md');
    expect(files).toContain('docs/GETTING_STARTED.md');
    expect(files).toContain('docs/ECOSYSTEM_INTEGRATION.md');
    expect(files).toContain('docs/PLUGINS_AND_SKILLS.md');
    expect(files).toContain('docs/RENDER_SIZING.md');
    expect(files).toContain('wiki/Home.md');
    expect(files).toContain('plugins/fiche-telemetry/README.md');
    expect(fs.existsSync(path.join(repoRoot, 'docs/assets/efficiency-vs-latency.png'))).toBe(true);
    expect(files.length).toBeGreaterThan(10);
  });

  it('every relative link/image/href points to a file that exists', () => {
    const dead: string[] = [];
    for (const rel of files) {
      const dir = path.dirname(path.join(repoRoot, rel));
      for (const link of localLinks(fs.readFileSync(path.join(repoRoot, rel), 'utf8'))) {
        if (!link.target) continue; // same-page #fragment, checked below
        if (!fs.existsSync(path.resolve(dir, link.target))) dead.push(`${rel} → ${link.raw}`);
      }
    }
    expect(dead, `dead relative links:\n${dead.join('\n')}`).toEqual([]);
  });

  it('every HTML <img src> and <source srcset> in README, docs/**, and wiki/** resolves on disk', () => {
    const mediaFiles = files.filter(
      (f) => f === 'README.md' || f.startsWith('docs/') || f.startsWith('wiki/'),
    );
    const missing: string[] = [];
    for (const rel of mediaFiles) {
      const dir = path.dirname(path.join(repoRoot, rel));
      const md = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      for (const asset of htmlMediaPaths(md)) {
        if (!fs.existsSync(path.resolve(dir, asset))) missing.push(`${rel} → ${asset}`);
      }
    }
    expect(missing, `missing HTML media assets:\n${missing.join('\n')}`).toEqual([]);
  });

  it('every #fragment resolves to a heading in the target markdown file', () => {
    const dead: string[] = [];
    for (const rel of files) {
      const dir = path.dirname(path.join(repoRoot, rel));
      for (const link of localLinks(fs.readFileSync(path.join(repoRoot, rel), 'utf8'))) {
        if (!link.fragment) continue;
        // Resolve which file the fragment lives in (same file if target empty).
        const targetRel = link.target
          ? path.relative(repoRoot, path.resolve(dir, link.target)).replace(/\\/g, '/')
          : rel;
        if (!targetRel.endsWith('.md')) continue; // only markdown has heading anchors
        const anchors = anchorsByFile.get(targetRel);
        if (anchors === undefined) continue; // target outside the scanned set
        if (!anchors.has(link.fragment.toLowerCase())) dead.push(`${rel} → #${link.fragment}`);
      }
    }
    expect(dead, `broken heading anchors:\n${dead.join('\n')}`).toEqual([]);
  });
});
