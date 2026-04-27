# API Obsidian — Documentation complète

> **Base URL :** `https://obsidian-api.srv1119889.hstgr.cloud`
> **Auth :** `Authorization: Bearer $OBSIDIAN_MCP_TOKEN` (toutes les routes sauf `/health`)
> **Content-Type :** `application/json` pour les requêtes avec body

---

### GET /api/directory[/{path}]

**Description :** Liste le contenu d'un répertoire du vault (fichiers et sous-dossiers). Sans `{path}`, liste la racine du vault. Les dossiers sont retournés en premier, puis les fichiers, le tout trié alphabétiquement.

**Path params :**

| Paramètre | Type   | Requis | Description                              |
|-----------|--------|--------|------------------------------------------|
| `path`    | string | Non    | Chemin relatif depuis la racine du vault |

**Query params :** aucun

**Exemple d'appel :**

```bash
# Racine du vault
curl -H "Authorization: Bearer $OBSIDIAN_MCP_TOKEN" \
  "https://obsidian-api.srv1119889.hstgr.cloud/api/directory"

# Sous-dossier
curl -H "Authorization: Bearer $OBSIDIAN_MCP_TOKEN" \
  "https://obsidian-api.srv1119889.hstgr.cloud/api/directory/20_Projects"
```

**Réponse (200) :**

```json
{
  "path": "20_Projects",
  "count": 3,
  "entries": [
    { "name": "mon-projet", "path": "20_Projects/mon-projet", "type": "directory" },
    { "name": "note.md",    "path": "20_Projects/note.md",    "type": "file" }
  ]
}
```

**Erreurs possibles :** 400 (path n'est pas un dossier), 403 (path traversal), 404 (dossier inexistant), 500

---

### GET /api/projects

**Description :** Liste tous les sous-dossiers directs de `20_Projects/`. Retourne une liste vide si le dossier n'existe pas.

**Query params :** aucun

**Exemple d'appel :**

```bash
curl -H "Authorization: Bearer $OBSIDIAN_MCP_TOKEN" \
  "https://obsidian-api.srv1119889.hstgr.cloud/api/projects"
```

**Réponse (200) :**

```json
{
  "count": 2,
  "projects": [
    { "name": "projet-alpha", "path": "20_Projects/projet-alpha" },
    { "name": "projet-beta",  "path": "20_Projects/projet-beta" }
  ]
}
```

**Erreurs possibles :** 500

---

### GET /api/file/{path}/links

**Description :** Analyse les wikilinks d'un fichier. Retourne uniquement les **liens cassés** (cibles inexistantes dans le vault). Les liens valides ne sont pas listés pour garder la réponse compacte.

**Path params :**

| Paramètre | Type   | Requis | Description                        |
|-----------|--------|--------|------------------------------------|
| `path`    | string | Oui    | Chemin relatif du fichier `.md`    |

**Query params :**

| Paramètre | Type    | Requis | Description                                                              |
|-----------|---------|--------|--------------------------------------------------------------------------|
| `suggest` | boolean | Non    | Si `true`, inclut jusqu'à 3 suggestions fuzzy par lien cassé (défaut: `false`) |

**Exemple d'appel :**

```bash
curl -H "Authorization: Bearer $OBSIDIAN_MCP_TOKEN" \
  "https://obsidian-api.srv1119889.hstgr.cloud/api/file/00_Inbox/ma-note.md/links?suggest=true"
```

**Réponse (200) — sans liens cassés :**

```json
{
  "path": "00_Inbox/ma-note.md",
  "count": 5,
  "broken_count": 0
}
```

**Réponse (200) — avec liens cassés :**

```json
{
  "path": "00_Inbox/ma-note.md",
  "count": 5,
  "broken_count": 1,
  "broken_links": [
    {
      "raw": "[[Note Inexistante]]",
      "target": "Note Inexistante",
      "suggestions": ["Note Existante", "Note Ancienne"]
    }
  ]
}
```

**Erreurs possibles :** 403 (path traversal), 404 (fichier inexistant), 500

---

### POST /api/file/{path}/append

**Description :** Ajoute du contenu à la fin d'un fichier existant. Si le fichier n'existe pas, il est créé. Les dossiers intermédiaires sont créés automatiquement. Un saut de ligne est inséré entre le contenu existant et le nouveau contenu.

**Path params :**

| Paramètre | Type   | Requis | Description                              |
|-----------|--------|--------|------------------------------------------|
| `path`    | string | Oui    | Chemin relatif du fichier `.md` cible    |

**Query params :** aucun

**Body JSON :**

| Champ     | Type   | Requis | Description               |
|-----------|--------|--------|---------------------------|
| `content` | string | Oui    | Contenu à ajouter à la fin |

**Exemple d'appel :**

```bash
curl -X POST \
  -H "Authorization: Bearer $OBSIDIAN_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "content": "## Nouvelle section\n\nContenu ajouté." }' \
  "https://obsidian-api.srv1119889.hstgr.cloud/api/file/00_Inbox/ma-note.md/append"
```

**Réponse (200) :**

```json
{ "success": true, "path": "00_Inbox/ma-note.md" }
```

**Erreurs possibles :** 403 (path traversal), 500

---

### PATCH /api/file/{path}/body

**Description :** Remplace le body d'un fichier en préservant son frontmatter YAML tel quel. Le fichier doit exister. Le frontmatter n'est pas touché, seul le contenu sous le bloc `---` est remplacé.

**Path params :**

| Paramètre | Type   | Requis | Description                              |
|-----------|--------|--------|------------------------------------------|
| `path`    | string | Oui    | Chemin relatif du fichier `.md` cible    |

**Query params :** aucun

**Body JSON :**

| Champ  | Type   | Requis | Description                           |
|--------|--------|--------|---------------------------------------|
| `body` | string | Oui    | Nouveau contenu body (sans frontmatter) |

**Exemple d'appel :**

```bash
curl -X PATCH \
  -H "Authorization: Bearer $OBSIDIAN_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "body": "# Titre\n\nNouveau contenu complet du body." }' \
  "https://obsidian-api.srv1119889.hstgr.cloud/api/file/00_Inbox/ma-note.md/body"
```

**Réponse (200) :**

```json
{ "success": true, "path": "00_Inbox/ma-note.md" }
```

**Erreurs possibles :** 403 (path traversal), 404 (fichier inexistant), 500

---

### POST /api/file/{path}/move

**Description :** Déplace un fichier vers un nouvel emplacement. Les dossiers intermédiaires de destination sont créés automatiquement. Le fichier source doit exister.

**Path params :**

| Paramètre | Type   | Requis | Description                        |
|-----------|--------|--------|------------------------------------|
| `path`    | string | Oui    | Chemin relatif du fichier source   |

**Query params :** aucun

**Body JSON :**

| Champ         | Type   | Requis | Description                                  |
|---------------|--------|--------|----------------------------------------------|
| `destination` | string | Oui    | Chemin relatif complet de destination (avec nom de fichier) |

**Exemple d'appel :**

```bash
curl -X POST \
  -H "Authorization: Bearer $OBSIDIAN_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "destination": "30_Knowledge/permanent-notes/ma-note.md" }' \
  "https://obsidian-api.srv1119889.hstgr.cloud/api/file/00_Inbox/ma-note.md/move"
```

**Réponse (200) :**

```json
{
  "success": true,
  "from": "00_Inbox/ma-note.md",
  "to": "30_Knowledge/permanent-notes/ma-note.md"
}
```

**Erreurs possibles :** 400 (`destination` manquant), 403 (path traversal source ou destination), 404 (fichier source inexistant), 500

---

### POST /api/files/batch

**Description :** Lit jusqu'à 100 fichiers en une seule requête. Pour chaque fichier, retourne le frontmatter parsé, le body et le contenu brut. Les fichiers introuvables ou en erreur sont inclus dans la réponse avec un champ `error` au lieu du contenu.

**Query params :** aucun

**Body JSON :**

| Champ   | Type     | Requis | Description                                   |
|---------|----------|--------|-----------------------------------------------|
| `paths` | string[] | Oui    | Liste de chemins relatifs (max 100 entrées)   |

**Exemple d'appel :**

```bash
curl -X POST \
  -H "Authorization: Bearer $OBSIDIAN_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "paths": ["00_Inbox/note-a.md", "00_Inbox/note-b.md"] }' \
  "https://obsidian-api.srv1119889.hstgr.cloud/api/files/batch"
```

**Réponse (200) :**

```json
{
  "count": 2,
  "files": [
    {
      "path": "00_Inbox/note-a.md",
      "frontmatter": { "status": "inbox", "created": "2026-04-01" },
      "body": "# Note A\n\nContenu...",
      "content": "---\nstatus: inbox\ncreated: 2026-04-01\n---\n# Note A\n\nContenu..."
    },
    {
      "path": "00_Inbox/note-b.md",
      "error": "File not found"
    }
  ]
}
```

**Erreurs possibles :** 400 (`paths` vide ou > 100 entrées) — les erreurs par fichier sont dans le tableau `files`

---

### PATCH /api/files/batch

**Description :** Applique les mêmes modifications de frontmatter à plusieurs fichiers en une seule requête (max 100). Les champs du frontmatter existant sont fusionnés (merge) avec les nouveaux champs — les champs non mentionnés sont préservés. Les fichiers en erreur sont inclus dans la réponse sans interrompre le traitement des autres.

**Query params :** aucun

**Body JSON :**

| Champ         | Type     | Requis | Description                                         |
|---------------|----------|--------|-----------------------------------------------------|
| `paths`       | string[] | Oui    | Liste de chemins relatifs (max 100 entrées)         |
| `frontmatter` | object   | Oui    | Champs à mettre à jour / ajouter dans le frontmatter |

**Exemple d'appel :**

```bash
curl -X PATCH \
  -H "Authorization: Bearer $OBSIDIAN_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "paths": ["00_Inbox/note-a.md", "00_Inbox/note-b.md"],
    "frontmatter": { "status": "reviewed", "reviewed_at": "2026-04-27" }
  }' \
  "https://obsidian-api.srv1119889.hstgr.cloud/api/files/batch"
```

**Réponse (200) :**

```json
{
  "count": 2,
  "failed_count": 0,
  "results": [
    { "path": "00_Inbox/note-a.md", "success": true },
    { "path": "00_Inbox/note-b.md", "success": true }
  ]
}
```

**Erreurs possibles :** 400 (`paths` vide, > 100, ou `frontmatter` n'est pas un objet) — les erreurs par fichier sont dans `results[].error`

---

### POST /api/files/move

**Description :** Déplace plusieurs fichiers vers un même dossier de destination (max 100). Le nom de fichier est conservé. Les dossiers intermédiaires sont créés automatiquement. Les fichiers en erreur n'interrompent pas le traitement des autres.

**Query params :** aucun

**Body JSON :**

| Champ                | Type     | Requis | Description                                                |
|----------------------|----------|--------|------------------------------------------------------------|
| `paths`              | string[] | Oui    | Liste de chemins relatifs des fichiers sources (max 100)   |
| `destination_folder` | string   | Oui    | Chemin relatif du dossier de destination (sans nom de fichier) |

**Exemple d'appel :**

```bash
curl -X POST \
  -H "Authorization: Bearer $OBSIDIAN_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "paths": ["00_Inbox/note-a.md", "00_Inbox/note-b.md"],
    "destination_folder": "30_Knowledge/permanent-notes"
  }' \
  "https://obsidian-api.srv1119889.hstgr.cloud/api/files/move"
```

**Réponse (200) :**

```json
{
  "count": 2,
  "failed_count": 0,
  "results": [
    {
      "path": "00_Inbox/note-a.md",
      "success": true,
      "to": "30_Knowledge/permanent-notes/note-a.md"
    },
    {
      "path": "00_Inbox/note-b.md",
      "success": true,
      "to": "30_Knowledge/permanent-notes/note-b.md"
    }
  ]
}
```

**Erreurs possibles :** 400 (`paths` vide, > 100, ou `destination_folder` manquant), 403 (destination path traversal) — les erreurs par fichier sont dans `results[].error`

---

### POST /api/query

**Description :** Exécute une requête SQL `SELECT` sur l'index SQLite du vault. Seuls les `SELECT` sont autorisés. L'index contient deux tables : `files` (métadonnées et frontmatter de tous les fichiers `.md`) et `tasks` (tâches extraites des notes).

**Query params :** aucun

**Body JSON :**

| Champ | Type   | Requis | Description                                      |
|-------|--------|--------|--------------------------------------------------|
| `sql` | string | Oui    | Requête SQL `SELECT` (toute autre instruction est rejetée) |

**Tables disponibles :**

| Table   | Description                                          |
|---------|------------------------------------------------------|
| `files` | Un enregistrement par fichier `.md` indexé           |
| `tasks` | Tâches extraites (checkboxes `- [ ]` / `- [x]`)     |

**Exemple d'appel :**

```bash
curl -X POST \
  -H "Authorization: Bearer $OBSIDIAN_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "sql": "SELECT path, title, status FROM files WHERE status = '\''inbox'\'' LIMIT 10" }' \
  "https://obsidian-api.srv1119889.hstgr.cloud/api/query"
```

**Réponse (200) :**

```json
{
  "count": 2,
  "results": [
    { "path": "00_Inbox/note-a.md", "title": "Note A", "status": "inbox" },
    { "path": "00_Inbox/note-b.md", "title": "Note B", "status": "inbox" }
  ]
}
```

**Erreurs possibles :** 400 (`sql` manquant, non-`SELECT`, ou erreur SQL)
