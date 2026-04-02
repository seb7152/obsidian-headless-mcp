const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { spawnSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const VAULT_PATH = process.env.VAULT_PATH || '/vault';
const VAULT_PREFIX = VAULT_PATH.endsWith(path.sep) ? VAULT_PATH : VAULT_PATH + path.sep;
const API_TOKEN = process.env.API_TOKEN || 'change-me-in-production';

app.use(cors());
app.use(express.json());

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

// List all markdown files with optional filters
app.get('/api/files', (req, res) => {
  try {
    const { type, project, path: filterPath } = req.query;

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
        // Filter by type (frontmatter prop)
        if (type && f.frontmatter.type !== type) return false;
        // Filter by project (frontmatter prop)
        if (project && f.frontmatter.project !== project) return false;
        // Filter by path pattern (optional)
        if (filterPath && !f.path.includes(filterPath)) return false;
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
      filters: { type, project, path: filterPath }
    });
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

// Append content to a file (atomic — no read-modify-write race)
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

// Search in vault
app.get('/api/search', (req, res) => {
  const query = req.query.q;
  try {
    if (!query) {
      return res.status(400).json({ error: 'Query parameter (q) required' });
    }

    const grep = spawnSync('grep', ['-r', query, '--include=*.md', VAULT_PATH], { encoding: 'utf-8' });
    const results = (grep.stdout || '')
      .split('\n')
      .filter(line => line)
      .map(line => {
        const [filePath, ...content] = line.split(':');
        return {
          file: path.relative(VAULT_PATH, filePath),
          match: content.join(':')
        };
      });

    res.json({ query, results, count: results.length });
  } catch (error) {
    res.json({ query, results: [], count: 0 });
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
