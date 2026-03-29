const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const VAULT_PATH = process.env.VAULT_PATH || '/vault';
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

// List all markdown files
app.get('/api/files', (req, res) => {
  try {
    const files = execSync(`find ${VAULT_PATH} -name "*.md" -type f`).toString().split('\n').filter(f => f);
    const relativePaths = files.map(f => path.relative(VAULT_PATH, f));
    res.json({ files: relativePaths });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Read a file
app.get(/^\/api\/file\/(.+)$/, (req, res) => {
  try {
    const filePath = path.join(VAULT_PATH, req.params[0]);

    // Security: prevent directory traversal
    if (!filePath.startsWith(VAULT_PATH)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    res.json({ content, path: req.params[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Write/create a file
app.post(/^\/api\/file\/(.+)$/, (req, res) => {
  try {
    const filePath = path.join(VAULT_PATH, req.params[0]);

    // Security: prevent directory traversal
    if (!filePath.startsWith(VAULT_PATH)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Create directory if it doesn't exist
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, req.body.content, 'utf-8');

    res.json({ success: true, path: req.params[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Search in vault
app.get('/api/search', (req, res) => {
  try {
    const query = req.query.q;
    if (!query) {
      return res.status(400).json({ error: 'Query parameter required' });
    }

    const results = execSync(`grep -r "${query}" ${VAULT_PATH} --include="*.md"`)
      .toString()
      .split('\n')
      .filter(line => line)
      .map(line => {
        const [filePath, ...content] = line.split(':');
        return { file: path.relative(VAULT_PATH, filePath), match: content.join(':') };
      });

    res.json({ query, results });
  } catch (error) {
    // grep returns error if no matches found
    res.json({ query, results: [] });
  }
});

// Trigger sync
app.post('/api/sync', (req, res) => {
  try {
    execSync('ob sync --vault-name ' + (process.env.VAULT_NAME || 'Vault'));
    res.json({ success: true, message: 'Vault synced' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get sync status
app.get('/api/sync/status', (req, res) => {
  try {
    const status = execSync('ob sync --vault-name ' + (process.env.VAULT_NAME || 'Vault') + ' --status').toString();
    res.json({ status });
  } catch (error) {
    res.json({ status: 'error', error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Obsidian API server running on port ${PORT}`);
  console.log(`Vault path: ${VAULT_PATH}`);
});
