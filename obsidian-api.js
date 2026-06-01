const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { spawnSync } = require('child_process');
const { db: vaultDb } = require('./vault-indexer');

const app = express();
const PORT = process.env.PORT || 3000;
const VAULT_PATH = process.env.VAULT_PATH || '/vault';
const VAULT_PREFIX = VAULT_PATH.endsWith(path.sep) ? VAULT_PATH : VAULT_PATH + path.sep;
const API_TOKEN = process.env.API_TOKEN || 'change-me-in-production';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Authentication middleware
app.use((req, res, next) => {
  // Health check doesn't require auth
  if (req.path === '/health') {
    return next();
  }
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || token !== API_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing API token' });
  }
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', vault: VAULT_PATH });
});

// Helper: Parse frontmatter from content
function parseFrontmatter(content) {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  let frontmatter = {};
  let body = content;

  if (frontmatterMatch) {
    try {
      frontmatter = yaml.load(frontmatterMatch[1]) || {};
      body = frontmatterMatch[2];
    } catch (e) {
      // If YAML parsing fails, return raw content
      body = content;
    }
  }

  return { frontmatter, body };
}

// Helper: Format content with frontmatter
function formatContent(frontmatter, body) {
  return `---\n${yaml.dump(frontmatter, { defaultFlowLevel: 2 })}---\n${body}`;
}

// Helper: Normalize date to YYYY-MM-DD format (handles Date objects and strings)
function normalizeDate(dateValue) {
  if (!dateValue) return null;

  // If it's a Date object
  if (dateValue instanceof Date) {
    return dateValue.toISOString().split('T')[0];
  }

  const str = String(dateValue).trim();

  // If it's already ISO format YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    return str.substring(0, 10);
  }

  // Try to parse as date string (e.g., "Wed Mar 25 2026 00:00:00...")
  try {
    const parsed = new Date(str);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString().split('T')[0];
    }
  } catch {}

  return null;
}

// Helper: Parse all [[wikilinks]] from markdown content
function parseWikilinks(content) {
  const regex = /\[\[([^\]\n]+)\]\]/g;
  const links = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    const raw = match[1];
    // Strip alias: [[Note|Alias]] → Note
    const withoutAlias = raw.split('|')[0].trim();
    // Strip heading anchor: [[Note#Section]] → Note
    const target = withoutAlias.split('#')[0].trim();
    if (target) links.push({ raw: match[1], target });
  }
  return links;
}

// Helper: Build an index of all notes in the vault
function buildNoteIndex() {
  const files = spawnSync('find', [VAULT_PATH, '-name', '*.md', '-type', 'f'], { encoding: 'utf-8' })
    .stdout.split('\n').filter(f => f);

  const byName = new Map();   // baseName (lowercase, no ext) → [relativePath]
  const allPaths = new Set(); // relative paths lowercase (with .md)

  for (const filePath of files) {
    const relativePath = path.relative(VAULT_PATH, filePath);
    allPaths.add(relativePath.toLowerCase());
    const baseName = path.basename(relativePath, '.md').toLowerCase();
    if (!byName.has(baseName)) byName.set(baseName, []);
    byName.get(baseName).push(relativePath);
  }

  return { byName, allPaths };
}

// Helper: Resolve a wikilink target using Obsidian's shortest-path strategy
function resolveWikilink(target, { byName, allPaths }) {
  const targetNorm = target.replace(/\.md$/i, '');
  const targetLower = targetNorm.toLowerCase();

  // 1. Exact relative path match (e.g. [[folder/note]] → folder/note.md)
  if (allPaths.has(targetLower + '.md')) {
    const baseName = path.basename(targetLower);
    const exact = (byName.get(baseName) || []).find(p => p.toLowerCase() === targetLower + '.md');
    return { exists: true, resolved: exact || null };
  }

  // 2. Name-only match (Obsidian shortest-path resolution)
  const baseName = path.basename(targetLower);
  if (byName.has(baseName)) {
    const matches = byName.get(baseName);
    return {
      exists: true,
      resolved: matches[0],
      ...(matches.length > 1 && { ambiguous: matches })
    };
  }

  return { exists: false, resolved: null };
}

// Helper: Levenshtein distance between two strings
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// Helper: Find up to maxResults fuzzy-matched note paths for a broken target
function fuzzySuggest(target, { byName }, maxResults = 3) {
  const targetLower = target.replace(/\.md$/i, '').toLowerCase();
  const scored = [];

  for (const [name, paths] of byName) {
    const isSubstring = name.includes(targetLower) || targetLower.includes(name);
    const dist = levenshtein(targetLower, name);
    const similarity = 1 - dist / Math.max(targetLower.length, name.length, 1);
    const score = isSubstring ? similarity + 0.5 : similarity;
    if (score > 0.3 || isSubstring) scored.push({ paths, score });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(({ paths }) => paths[0]);
}

// Helper: count non-overlapping occurrences of a literal substring
function countOccurrences(haystack, needle) {
  if (needle === '') return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

// List all markdown files with optional filters
app.get('/api/files', (req, res) => {
  try {
    const { path: filterPath, since, before, ...frontmatterFilters } = req.query;

    const files = spawnSync('find', [VAULT_PATH, '-name', '*.md', '-type', 'f'], { encoding: 'utf-8' })
      .stdout
      .split('\n')
      .filter(f => f);

    const results = files
      .map(filePath => {
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const relativePath = path.relative(VAULT_PATH, filePath);
          const { frontmatter } = parseFrontmatter(content);

          return {
            path: relativePath,
            frontmatter,
            hasContent: content.length > 0
          };
        } catch {
          return null;
        }
      })
      .filter(f => f)
      .filter(f => {
        // Filter by any frontmatter property (e.g. ?status=reviewed&type=note)
        for (const [key, val] of Object.entries(frontmatterFilters)) {
          if (String(f.frontmatter[key] ?? '') !== String(val)) return false;
        }
        // Filter by path pattern (optional)
        if (filterPath && !f.path.includes(filterPath)) return false;
        // Filter by since/before date (frontmatter.created, fallback to filename date)
        if (since || before) {
          let dateField = f.frontmatter.created;
          // Fallback: try to parse date from filename (YYYY-MM-DD - ...)
          if (!dateField) {
            const dateMatch = f.path.match(/^(\d{4}-\d{2}-\d{2})/);
            if (dateMatch) dateField = dateMatch[1];
          }
          // Normalize to YYYY-MM-DD format (handles Date objects, ISO strings, and text dates)
          const d = normalizeDate(dateField) || 'NO_DATE';
          if (d !== 'NO_DATE' && ((since && d < since) || (before && d > before))) {
            return false;
          }
        }
        return true;
      })
      .sort((a, b) => {
        // Sort by date if available
        if (a.frontmatter.date && b.frontmatter.date) {
          return new Date(b.frontmatter.date) - new Date(a.frontmatter.date);
        }
        return a.path.localeCompare(b.path);
      });

    res.json({
      files: results,
      count: results.length,
      filters: { ...frontmatterFilters, path: filterPath, since, before }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List wikilinks in a file — only returns broken links to keep response compact
// Optional query: ?suggest=true → include up to 3 fuzzy suggestions per broken link
// MUST come before the generic GET /api/file/{path} route
app.get(/^\/api\/file\/(.+)\/links$/, (req, res) => {
  try {
    const filePath = path.join(VAULT_PATH, req.params[0]);

    if (!filePath.startsWith(VAULT_PREFIX)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const suggest = req.query.suggest === 'true';
    const content = fs.readFileSync(filePath, 'utf-8');
    const { body } = parseFrontmatter(content);
    const index = buildNoteIndex();

    const allLinks = parseWikilinks(body);
    const brokenLinks = allLinks.reduce((acc, { raw, target }) => {
      const { exists } = resolveWikilink(target, index);
      if (!exists) {
        const entry = { raw, target };
        if (suggest) entry.suggestions = fuzzySuggest(target, index);
        acc.push(entry);
      }
      return acc;
    }, []);

    const response = {
      path: req.params[0],
      count: allLinks.length,
      broken_count: brokenLinks.length
    };
    if (brokenLinks.length > 0) response.broken_links = brokenLinks;

    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Read a file with parsed frontmatter
app.get(/^\/api\/file\/(.+)$/, (req, res) => {
  try {
    const filePath = path.join(VAULT_PATH, req.params[0]);

    // Security: prevent directory traversal
    if (!filePath.startsWith(VAULT_PREFIX)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);

    res.json({
      path: req.params[0],
      frontmatter,
      body,
      content
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Read multiple files in a single request
// Body: { paths: ["notes/a.md", "notes/b.md"] }
app.post('/api/files/batch', (req, res) => {
  const { paths } = req.body;

  if (!Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ error: '"paths" must be a non-empty array' });
  }
  if (paths.length > 100) {
    return res.status(400).json({ error: '"paths" must contain at most 100 entries' });
  }

  const results = paths.map(relativePath => {
    try {
      const filePath = path.join(VAULT_PATH, relativePath);

      if (!filePath.startsWith(VAULT_PREFIX)) {
        return { path: relativePath, error: 'Access denied' };
      }

      if (!fs.existsSync(filePath)) {
        return { path: relativePath, error: 'File not found' };
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter, body } = parseFrontmatter(content);
      return { path: relativePath, frontmatter, body, content };
    } catch (err) {
      return { path: relativePath, error: err.message };
    }
  });

  res.json({ files: results, count: results.length });
});

// Append content to a file (atomic — no read-modify-write race)
// MUST come before the generic /api/file/{path} POST route
app.post(/^\/api\/file\/(.+)\/append$/, (req, res) => {
  try {
    const filePath = path.join(VAULT_PATH, req.params[0]);

    if (!filePath.startsWith(VAULT_PREFIX)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const contentToAppend = req.body.content || '';
    const dir = path.dirname(filePath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
    const newContent = existing ? existing + '\n' + contentToAppend : contentToAppend;
    fs.writeFileSync(filePath, newContent, 'utf-8');

    res.json({ success: true, path: req.params[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create or write a complete file
app.post(/^\/api\/file\/(.+)$/, (req, res) => {
  try {
    const filePath = path.join(VAULT_PATH, req.params[0]);

    // Security: prevent directory traversal
    if (!filePath.startsWith(VAULT_PREFIX)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Create directory if it doesn't exist
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Write content
    const content = req.body.content || '';
    fs.writeFileSync(filePath, content, 'utf-8');

    res.json({ success: true, path: req.params[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update body only — preserves frontmatter exactly as-is (PATCH)
// MUST come before the generic PATCH /api/file/{path} route
app.patch(/^\/api\/file\/(.+)\/body$/, (req, res) => {
  try {
    const filePath = path.join(VAULT_PATH, req.params[0]);

    if (!filePath.startsWith(VAULT_PREFIX)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const newBody = req.body.body ?? '';
    const content = fs.readFileSync(filePath, 'utf-8');
    const { frontmatter } = parseFrontmatter(content);

    const newContent = Object.keys(frontmatter).length > 0
      ? formatContent(frontmatter, newBody)
      : newBody;

    fs.writeFileSync(filePath, newContent, 'utf-8');
    res.json({ success: true, path: req.params[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Move a single file
// Body: { "destination": "new/path/to/file.md" }
app.post(/^\/api\/file\/(.+)\/move$/, (req, res) => {
  try {
    const srcPath = path.join(VAULT_PATH, req.params[0]);
    if (!srcPath.startsWith(VAULT_PREFIX)) return res.status(403).json({ error: 'Access denied' });
    if (!fs.existsSync(srcPath)) return res.status(404).json({ error: 'File not found' });

    const { destination } = req.body;
    if (!destination) return res.status(400).json({ error: '"destination" is required' });

    const destPath = path.join(VAULT_PATH, destination);
    if (!destPath.startsWith(VAULT_PREFIX)) return res.status(403).json({ error: 'Access denied: destination' });

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.renameSync(srcPath, destPath);

    res.json({ success: true, from: req.params[0], to: destination });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Bulk move files to a destination folder
// Body: { "paths": ["a.md", "b.md"], "destination_folder": "30_Knowledge/permanent-notes" }
app.post('/api/files/move', (req, res) => {
  const { paths, destination_folder } = req.body;

  if (!Array.isArray(paths) || paths.length === 0)
    return res.status(400).json({ error: '"paths" must be a non-empty array' });
  if (paths.length > 100)
    return res.status(400).json({ error: '"paths" must contain at most 100 entries' });
  if (!destination_folder)
    return res.status(400).json({ error: '"destination_folder" is required' });

  const destDir = path.join(VAULT_PATH, destination_folder);
  if (!destDir.startsWith(VAULT_PREFIX)) return res.status(403).json({ error: 'Access denied: destination_folder' });

  fs.mkdirSync(destDir, { recursive: true });

  const results = paths.map(relativePath => {
    try {
      const srcPath = path.join(VAULT_PATH, relativePath);
      if (!srcPath.startsWith(VAULT_PREFIX)) return { path: relativePath, error: 'Access denied' };
      if (!fs.existsSync(srcPath)) return { path: relativePath, error: 'File not found' };

      const fileName = path.basename(relativePath);
      const destPath = path.join(destDir, fileName);
      fs.renameSync(srcPath, destPath);

      return { path: relativePath, success: true, to: path.join(destination_folder, fileName) };
    } catch (err) {
      return { path: relativePath, error: err.message };
    }
  });

  const failed = results.filter(r => r.error);
  res.json({ results, count: results.length, failed_count: failed.length });
});

// Surgical text patch — find `old_text` and replace it, leaving the rest of the file untouched (PATCH)
// Body: { "old_text": "...", "new_text": "...", "replace_all": false }
// MUST come before the generic PATCH /api/file/{path} route
app.patch(/^\/api\/file\/(.+)\/patch$/, (req, res) => {
  try {
    const filePath = path.join(VAULT_PATH, req.params[0]);

    // Security: prevent directory traversal
    if (!filePath.startsWith(VAULT_PREFIX)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { old_text, new_text, replace_all } = req.body || {};

    // old_text must be a non-empty string — an empty needle would be meaningless / inject everywhere
    if (typeof old_text !== 'string' || old_text.length === 0) {
      return res.status(400).json({ error: '"old_text" is required and must be a non-empty string' });
    }
    // new_text is optional (omitting it deletes the matched text), but must be a string when present
    if (new_text !== undefined && new_text !== null && typeof new_text !== 'string') {
      return res.status(400).json({ error: '"new_text" must be a string' });
    }
    const replacement = (new_text === undefined || new_text === null) ? '' : new_text;

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const occurrences = countOccurrences(content, old_text);

    // Don't fail silently — tell the caller the anchor wasn't found
    if (occurrences === 0) {
      return res.status(422).json({
        error: 'Text not found — no changes made',
        path: req.params[0]
      });
    }

    const doAll = replace_all === true;
    let newContent;
    let replacements;
    if (doAll) {
      newContent = content.split(old_text).join(replacement);
      replacements = occurrences;
    } else {
      const idx = content.indexOf(old_text);
      newContent = content.slice(0, idx) + replacement + content.slice(idx + old_text.length);
      replacements = 1;
    }

    // No-op guard: avoid rewriting the file (and bumping mtime) when nothing changed
    const changed = newContent !== content;
    if (changed) {
      fs.writeFileSync(filePath, newContent, 'utf-8');
    }

    res.json({
      success: true,
      path: req.params[0],
      occurrences,
      replacements,
      replace_all: doAll,
      changed
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update frontmatter only (PATCH)
app.patch(/^\/api\/file\/(.+)$/, (req, res) => {
  try {
    const filePath = path.join(VAULT_PATH, req.params[0]);

    // Security: prevent directory traversal
    if (!filePath.startsWith(VAULT_PREFIX)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);

    // Merge with new frontmatter
    const updatedFrontmatter = { ...frontmatter, ...req.body };

    // Write back
    const newContent = formatContent(updatedFrontmatter, body);
    fs.writeFileSync(filePath, newContent, 'utf-8');

    res.json({
      success: true,
      path: req.params[0],
      frontmatter: updatedFrontmatter
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Bulk frontmatter update — apply the same patch to multiple files at once
// Body: { paths: ["notes/a.md", "notes/b.md"], frontmatter: { status: "done" } }
app.patch('/api/files/batch', (req, res) => {
  const { paths, frontmatter: newFields } = req.body;

  if (!Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ error: '"paths" must be a non-empty array' });
  }
  if (paths.length > 100) {
    return res.status(400).json({ error: '"paths" must contain at most 100 entries' });
  }
  if (typeof newFields !== 'object' || newFields === null || Array.isArray(newFields)) {
    return res.status(400).json({ error: '"frontmatter" must be an object' });
  }

  const results = paths.map(relativePath => {
    try {
      const filePath = path.join(VAULT_PATH, relativePath);

      if (!filePath.startsWith(VAULT_PREFIX)) {
        return { path: relativePath, error: 'Access denied' };
      }

      if (!fs.existsSync(filePath)) {
        return { path: relativePath, error: 'File not found' };
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter, body } = parseFrontmatter(content);
      const updatedFrontmatter = { ...frontmatter, ...newFields };
      fs.writeFileSync(filePath, formatContent(updatedFrontmatter, body), 'utf-8');

      return { path: relativePath, success: true };
    } catch (err) {
      return { path: relativePath, error: err.message };
    }
  });

  const failed = results.filter(r => r.error);
  res.json({ results, count: results.length, failed_count: failed.length });
});

// List directory contents
app.get(/^\/api\/directory(?:\/(.+))?$/, (req, res) => {
  try {
    const relPath = req.params[0] || '';
    const dirPath = relPath ? path.join(VAULT_PATH, relPath) : VAULT_PATH;

    if (dirPath !== VAULT_PATH && !dirPath.startsWith(VAULT_PREFIX)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!fs.existsSync(dirPath)) {
      return res.status(404).json({ error: 'Directory not found' });
    }

    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }

    const entries = fs.readdirSync(dirPath)
      .map(name => {
        const fullPath = path.join(dirPath, name);
        try {
          const s = fs.statSync(fullPath);
          return {
            name,
            path: path.relative(VAULT_PATH, fullPath),
            type: s.isDirectory() ? 'directory' : 'file'
          };
        } catch {
          return null;
        }
      })
      .filter(e => e)
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    res.json({ path: relPath || '/', entries, count: entries.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Search in vault — supports keyword (default) and fuzzy modes with optional date filters
// Query params: q (required), fuzzy=true, since=YYYY-MM-DD, before=YYYY-MM-DD
app.get('/api/search', (req, res) => {
  const query = req.query.q;
  const fuzzy = req.query.fuzzy === 'true';
  const since = req.query.since;
  const before = req.query.before;

  if (!query) {
    return res.status(400).json({ error: 'Query parameter (q) required' });
  }

  try {
    let results = [];

    if (fuzzy) {
      // Fuzzy: score files by title similarity + case-insensitive content presence
      const allFiles = spawnSync('find', [VAULT_PATH, '-name', '*.md', '-type', 'f'], { encoding: 'utf-8' })
        .stdout.split('\n').filter(f => f);

      const queryLower = query.toLowerCase();

      for (const filePath of allFiles) {
        try {
          const relativePath = path.relative(VAULT_PATH, filePath);
          const baseName = path.basename(relativePath, '.md');
          const baseNameLower = baseName.toLowerCase();
          const content = fs.readFileSync(filePath, 'utf-8');
          const { frontmatter, body } = parseFrontmatter(content);

          // Title fuzzy score
          const isSubstring = baseNameLower.includes(queryLower) || queryLower.includes(baseNameLower);
          const dist = levenshtein(queryLower, baseNameLower);
          const similarity = 1 - dist / Math.max(queryLower.length, baseNameLower.length, 1);
          let score = isSubstring ? similarity + 0.5 : similarity;

          // Content keyword bonus
          const bodyLower = body.toLowerCase();
          const contentHit = bodyLower.includes(queryLower);
          if (contentHit) score += 0.3;

          if (score <= 0.4 && !contentHit) continue;

          // Date filtering
          let dateField = frontmatter.created;
          if (!dateField) {
            const dateMatch = path.basename(relativePath).match(/^(\d{4}-\d{2}-\d{2})/);
            if (dateMatch) dateField = dateMatch[1];
          }
          const d = normalizeDate(dateField);
          if (d && since && d < since) continue;
          if (d && before && d > before) continue;

          const matches = body.split('\n')
            .filter(line => line.toLowerCase().includes(queryLower))
            .map(line => line.trim())
            .filter(line => line)
            .slice(0, 3);

          results.push({
            file: relativePath,
            title: frontmatter.title || baseName,
            score: Math.round(score * 100) / 100,
            matches,
            date: d || null
          });
        } catch {}
      }

      results.sort((a, b) => b.score - a.score);
    } else {
      // Keyword: case-insensitive grep to find matching files, then apply date filter
      const grep = spawnSync('grep', ['-r', '-i', '-l', query, '--include=*.md', VAULT_PATH], { encoding: 'utf-8' });
      const matchedFiles = (grep.stdout || '').split('\n').filter(f => f);

      for (const filePath of matchedFiles) {
        try {
          const relativePath = path.relative(VAULT_PATH, filePath);
          const content = fs.readFileSync(filePath, 'utf-8');
          const { frontmatter, body } = parseFrontmatter(content);

          // Date filtering
          let dateField = frontmatter.created;
          if (!dateField) {
            const dateMatch = path.basename(relativePath).match(/^(\d{4}-\d{2}-\d{2})/);
            if (dateMatch) dateField = dateMatch[1];
          }
          const d = normalizeDate(dateField);
          if (d && since && d < since) continue;
          if (d && before && d > before) continue;

          const matches = body.split('\n')
            .filter(line => line.toLowerCase().includes(query.toLowerCase()))
            .map(line => line.trim())
            .filter(line => line)
            .slice(0, 3);

          results.push({
            file: relativePath,
            title: frontmatter.title || path.basename(relativePath, '.md'),
            matches,
            date: d || null
          });
        } catch {}
      }
    }

    res.json({ query, results, count: results.length, fuzzy });
  } catch (error) {
    res.json({ query, results: [], count: 0, error: error.message });
  }
});

// List all project folders from 20_Projects/
app.get('/api/projects', (req, res) => {
  try {
    const projectsDir = path.join(VAULT_PATH, '20_Projects');

    if (!fs.existsSync(projectsDir)) {
      return res.json({ projects: [], count: 0 });
    }

    const projects = fs.readdirSync(projectsDir)
      .filter(name => {
        try {
          return fs.statSync(path.join(projectsDir, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .map(name => ({
        name,
        path: path.join('20_Projects', name)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({ projects, count: projects.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get agent context (agent.md only)
app.get('/api/agent/context', (req, res) => {
  try {
    let agent = '';
 
    try {
      agent = fs.readFileSync(path.join(VAULT_PATH, 'agent.md'), 'utf-8');
    } catch {
      agent = 'agent.md not found';
    }
 
    res.json({
      agent,
      vault_path: VAULT_PATH
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Execute a SQL SELECT query against the vault index
app.post('/api/query', (req, res) => {
  const { sql } = req.body;
  if (!sql || typeof sql !== 'string') {
    return res.status(400).json({ error: '"sql" is required' });
  }
  if (!sql.trim().toUpperCase().startsWith('SELECT')) {
    return res.status(400).json({ error: 'Only SELECT statements are allowed' });
  }
  try {
    const results = vaultDb.prepare(sql).all();
    res.json({ results, count: results.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Trigger sync
app.post('/api/sync', (req, res) => {
  try {
    const result = spawnSync('ob', ['sync', '--vault-name', process.env.VAULT_NAME || 'Vault'], { encoding: 'utf-8' });
    if (result.status !== 0) throw new Error(result.stderr || 'sync failed');
    res.json({ success: true, message: 'Vault synced' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get sync status
app.get('/api/sync/status', (req, res) => {
  try {
    const result = spawnSync('ob', ['sync', '--vault-name', process.env.VAULT_NAME || 'Vault', '--status'], { encoding: 'utf-8' });
    res.json({ status: result.stdout || '' });
  } catch (error) {
    res.json({ status: 'error', error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Obsidian API server running on port ${PORT}`);
  console.log(`📁 Vault path: ${VAULT_PATH}`);
  console.log(`🔐 Authentication: Bearer token required (except /health)`);
  console.log(`📚 Documentation: GET /api/agent/context`);
});
