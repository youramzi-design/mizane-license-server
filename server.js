/**
 * MiZane — Serveur de licences SaaS V1.0
 * Node.js + Express
 *
 * Stockage :
 *   - Si DATABASE_URL défini → PostgreSQL  (Railway / prod)
 *   - Sinon                  → JSON local  (dev)
 *
 * Routes publiques : POST /api/verifier-cle  /api/activer  /api/valider
 * Routes admin     : /admin/**  (header X-Admin-Key)
 */

const express = require('express');
const jwt     = require('jsonwebtoken');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app        = express();
const PORT       = process.env.PORT       || 3500;
const JWT_SECRET = process.env.JWT_SECRET || 'mizane-jwt-secret-2025-change-en-prod';
const ADMIN_KEY  = process.env.ADMIN_KEY  || 'mizane-admin-2025';
const TOKEN_TTL  = '8d';
const USE_PG     = !!process.env.DATABASE_URL;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ════════════════════════════════════════════════════════════
// COUCHE DE DONNÉES  (PostgreSQL OU JSON)
// ════════════════════════════════════════════════════════════

let pool;
const DB_FILE = path.join(__dirname, 'licenses.json');

function jsonLire() {
  if (!fs.existsSync(DB_FILE))
    return { licences: [], activations: [], nextId: 1, nextActId: 1 };
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { licences: [], activations: [], nextId: 1, nextActId: 1 }; }
}
function jsonSauve(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

async function initDB() {
  if (!USE_PG) { console.log('  Stockage  : JSON local'); return; }

  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS licences (
      id            SERIAL PRIMARY KEY,
      cle           TEXT UNIQUE NOT NULL,
      client_nom    TEXT NOT NULL,
      client_email  TEXT,
      client_tel    TEXT,
      plan          TEXT DEFAULT 'mensuel',
      date_debut    TIMESTAMPTZ DEFAULT NOW(),
      date_fin      TIMESTAMPTZ NOT NULL,
      max_appareils INT DEFAULT 1,
      actif         BOOLEAN DEFAULT TRUE,
      notes         TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS activations (
      id           SERIAL PRIMARY KEY,
      licence_id   INT REFERENCES licences(id) ON DELETE CASCADE,
      machine_id   TEXT NOT NULL,
      machine_nom  TEXT,
      app_version  TEXT,
      activated_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen    TIMESTAMPTZ DEFAULT NOW(),
      actif        BOOLEAN DEFAULT TRUE
    )
  `);
  console.log('  Stockage  : PostgreSQL (Railway)');
}

// ── Helpers ──────────────────────────────────────────────────
function genererCle() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seg   = () => Array.from({ length: 4 },
    () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `MZN-${seg()}-${seg()}-${seg()}`;
}
function joursRestants(d) {
  return Math.ceil((new Date(d) - Date.now()) / 86400000);
}

// ── Middleware admin ─────────────────────────────────────────
function adminAuth(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY)
    return res.status(401).json({ erreur: 'Clé admin invalide' });
  next();
}

// ════════════════════════════════════════════════════════════
// API PUBLIQUE
// ════════════════════════════════════════════════════════════

// POST /api/verifier-cle
app.post('/api/verifier-cle', async (req, res) => {
  const { cle } = req.body;
  if (!cle) return res.status(400).json({ ok: false, erreur: 'Clé manquante' });
  const cleN = cle.trim().toUpperCase();

  try {
    let licence, nbActifs;

    if (USE_PG) {
      const { rows } = await pool.query(
        'SELECT * FROM licences WHERE cle = $1 AND actif = TRUE', [cleN]);
      licence = rows[0];
      if (!licence) return res.status(404).json({ ok: false, erreur: 'Clé de licence invalide' });
      const { rows: c } = await pool.query(
        'SELECT COUNT(*) as nb FROM activations WHERE licence_id = $1 AND actif = TRUE', [licence.id]);
      nbActifs = parseInt(c[0].nb);
    } else {
      const db = jsonLire();
      licence  = db.licences.find(l => l.cle === cleN && l.actif);
      if (!licence) return res.status(404).json({ ok: false, erreur: 'Clé de licence invalide' });
      nbActifs = db.activations.filter(a => a.licence_id === licence.id && a.actif).length;
    }

    if (joursRestants(licence.date_fin) <= 0)
      return res.status(403).json({ ok: false, erreur: 'Licence expirée', expiree: true });
    if (nbActifs >= licence.max_appareils)
      return res.status(403).json({
        ok: false,
        erreur: `Nombre maximum d'appareils atteint (${nbActifs}/${licence.max_appareils})`,
      });

    res.json({
      ok: true,
      client:          licence.client_nom,
      plan:            licence.plan,
      jours_restants:  joursRestants(licence.date_fin),
      appareils_dispo: licence.max_appareils - nbActifs,
    });
  } catch (err) { console.error(err); res.status(500).json({ ok: false, erreur: 'Erreur serveur' }); }
});

// POST /api/activer
app.post('/api/activer', async (req, res) => {
  const { cle, machine_id, machine_nom, app_version } = req.body;
  if (!cle || !machine_id)
    return res.status(400).json({ ok: false, erreur: 'Données manquantes' });
  const cleN = cle.trim().toUpperCase();

  try {
    if (USE_PG) {
      const { rows } = await pool.query(
        'SELECT * FROM licences WHERE cle = $1 AND actif = TRUE', [cleN]);
      const licence = rows[0];
      if (!licence) return res.status(404).json({ ok: false, erreur: 'Clé de licence invalide ou révoquée' });
      if (joursRestants(licence.date_fin) <= 0)
        return res.status(403).json({ ok: false, erreur: 'Licence expirée', expiree: true });

      const { rows: ea } = await pool.query(
        'SELECT * FROM activations WHERE licence_id = $1 AND machine_id = $2', [licence.id, machine_id]);
      const existing = ea[0];

      if (existing && !existing.actif)
        return res.status(403).json({ ok: false, erreur: 'Cet appareil a été révoqué' });

      if (!existing) {
        const { rows: cnt } = await pool.query(
          'SELECT COUNT(*) as nb FROM activations WHERE licence_id = $1 AND actif = TRUE', [licence.id]);
        if (parseInt(cnt[0].nb) >= licence.max_appareils)
          return res.status(403).json({
            ok: false,
            erreur: `Nombre maximum d'appareils atteint (${licence.max_appareils}/${licence.max_appareils})`,
          });
        await pool.query(
          'INSERT INTO activations (licence_id, machine_id, machine_nom, app_version) VALUES ($1,$2,$3,$4)',
          [licence.id, machine_id, machine_nom ?? null, app_version ?? null]);
      } else {
        await pool.query(
          'UPDATE activations SET last_seen = NOW(), app_version = $1 WHERE id = $2',
          [app_version ?? existing.app_version, existing.id]);
      }

      const token = jwt.sign(
        { cle: licence.cle, machine_id, client: licence.client_nom, plan: licence.plan },
        JWT_SECRET, { expiresIn: TOKEN_TTL });
      return res.json({
        ok: true, token,
        client: licence.client_nom, plan: licence.plan,
        date_fin: licence.date_fin, jours_restants: joursRestants(licence.date_fin),
      });
    }

    // JSON
    const db      = jsonLire();
    const licence = db.licences.find(l => l.cle === cleN && l.actif);
    if (!licence) return res.status(404).json({ ok: false, erreur: 'Clé de licence invalide ou révoquée' });
    if (joursRestants(licence.date_fin) <= 0)
      return res.status(403).json({ ok: false, erreur: 'Licence expirée', expiree: true });

    let activation = db.activations.find(a => a.licence_id === licence.id && a.machine_id === machine_id);
    if (activation && !activation.actif)
      return res.status(403).json({ ok: false, erreur: 'Cet appareil a été révoqué' });

    if (!activation) {
      const nbActifs = db.activations.filter(a => a.licence_id === licence.id && a.actif).length;
      if (nbActifs >= licence.max_appareils)
        return res.status(403).json({
          ok: false,
          erreur: `Nombre maximum d'appareils atteint (${licence.max_appareils}/${licence.max_appareils})`,
        });
      activation = {
        id: db.nextActId++, licence_id: licence.id,
        machine_id, machine_nom: machine_nom ?? null, app_version: app_version ?? null,
        activated_at: new Date().toISOString(), last_seen: new Date().toISOString(), actif: true,
      };
      db.activations.push(activation);
    } else {
      activation.last_seen   = new Date().toISOString();
      activation.app_version = app_version ?? activation.app_version;
    }
    jsonSauve(db);

    const token = jwt.sign(
      { cle: licence.cle, machine_id, client: licence.client_nom, plan: licence.plan },
      JWT_SECRET, { expiresIn: TOKEN_TTL });
    res.json({
      ok: true, token,
      client: licence.client_nom, plan: licence.plan,
      date_fin: licence.date_fin, jours_restants: joursRestants(licence.date_fin),
    });
  } catch (err) { console.error(err); res.status(500).json({ ok: false, erreur: 'Erreur serveur' }); }
});

// POST /api/valider
app.post('/api/valider', async (req, res) => {
  const { token, machine_id } = req.body;
  if (!token || !machine_id)
    return res.status(400).json({ ok: false, erreur: 'Données manquantes' });

  let payload;
  try { payload = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true }); }
  catch { return res.status(401).json({ ok: false, erreur: 'Token invalide' }); }

  if (payload.machine_id !== machine_id)
    return res.status(403).json({ ok: false, erreur: 'Token machine invalide' });

  try {
    let licence, activation;

    if (USE_PG) {
      const { rows } = await pool.query(
        'SELECT * FROM licences WHERE cle = $1 AND actif = TRUE', [payload.cle]);
      licence = rows[0];
      if (!licence) return res.status(404).json({ ok: false, erreur: 'Licence révoquée', bloque: true });
      if (joursRestants(licence.date_fin) <= 0)
        return res.status(403).json({ ok: false, erreur: 'Licence expirée', expiree: true });

      const { rows: ar } = await pool.query(
        'SELECT * FROM activations WHERE licence_id = $1 AND machine_id = $2 AND actif = TRUE',
        [licence.id, machine_id]);
      activation = ar[0];
      if (!activation) return res.status(403).json({ ok: false, erreur: 'Appareil non enregistré' });
      await pool.query('UPDATE activations SET last_seen = NOW() WHERE id = $1', [activation.id]);
    } else {
      const db = jsonLire();
      licence   = db.licences.find(l => l.cle === payload.cle && l.actif);
      if (!licence) return res.status(404).json({ ok: false, erreur: 'Licence révoquée', bloque: true });
      if (joursRestants(licence.date_fin) <= 0)
        return res.status(403).json({ ok: false, erreur: 'Licence expirée', expiree: true });

      activation = db.activations.find(
        a => a.licence_id === licence.id && a.machine_id === machine_id && a.actif);
      if (!activation) return res.status(403).json({ ok: false, erreur: 'Appareil non enregistré' });
      activation.last_seen = new Date().toISOString();
      jsonSauve(db);
    }

    const newToken = jwt.sign(
      { cle: licence.cle, machine_id, client: licence.client_nom, plan: licence.plan },
      JWT_SECRET, { expiresIn: TOKEN_TTL });
    res.json({
      ok: true, token: newToken,
      client: licence.client_nom, plan: licence.plan,
      date_fin: licence.date_fin, jours_restants: joursRestants(licence.date_fin),
    });
  } catch (err) { console.error(err); res.status(500).json({ ok: false, erreur: 'Erreur serveur' }); }
});

// ════════════════════════════════════════════════════════════
// API ADMIN
// ════════════════════════════════════════════════════════════

app.get('/admin/stats', adminAuth, async (req, res) => {
  try {
    if (USE_PG) {
      const today = new Date().toISOString();
      const [t, a, e, ap] = await Promise.all([
        pool.query('SELECT COUNT(*) as nb FROM licences'),
        pool.query('SELECT COUNT(*) as nb FROM licences WHERE actif=TRUE AND date_fin > $1', [today]),
        pool.query('SELECT COUNT(*) as nb FROM licences WHERE date_fin <= $1', [today]),
        pool.query('SELECT COUNT(*) as nb FROM activations WHERE actif=TRUE'),
      ]);
      return res.json({
        total: parseInt(t.rows[0].nb), actives: parseInt(a.rows[0].nb),
        expirees: parseInt(e.rows[0].nb), appareils: parseInt(ap.rows[0].nb),
      });
    }
    const db = jsonLire(); const today = new Date();
    res.json({
      total:     db.licences.length,
      actives:   db.licences.filter(l => l.actif && new Date(l.date_fin) > today).length,
      expirees:  db.licences.filter(l => new Date(l.date_fin) <= today).length,
      appareils: db.activations.filter(a => a.actif).length,
    });
  } catch (err) { console.error(err); res.status(500).json({ erreur: 'Erreur serveur' }); }
});

app.get('/admin/licences', adminAuth, async (req, res) => {
  try {
    if (USE_PG) {
      const { rows } = await pool.query('SELECT * FROM licences ORDER BY id DESC');
      const result = await Promise.all(rows.map(async l => {
        const { rows: c } = await pool.query(
          'SELECT COUNT(*) as nb FROM activations WHERE licence_id=$1 AND actif=TRUE', [l.id]);
        return { ...l, jours_restants: joursRestants(l.date_fin), nb_activations: parseInt(c[0].nb) };
      }));
      return res.json(result);
    }
    const db = jsonLire();
    res.json(db.licences.map(l => ({
      ...l,
      jours_restants: joursRestants(l.date_fin),
      nb_activations: db.activations.filter(a => a.licence_id === l.id && a.actif).length,
    })));
  } catch (err) { console.error(err); res.status(500).json({ erreur: 'Erreur serveur' }); }
});

app.get('/admin/licences/:id', adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (USE_PG) {
      const { rows } = await pool.query('SELECT * FROM licences WHERE id=$1', [id]);
      if (!rows[0]) return res.status(404).json({ erreur: 'Introuvable' });
      const { rows: acts } = await pool.query(
        'SELECT * FROM activations WHERE licence_id=$1 ORDER BY id', [id]);
      return res.json({ ...rows[0], jours_restants: joursRestants(rows[0].date_fin), activations: acts });
    }
    const db = jsonLire();
    const l  = db.licences.find(l => l.id === id);
    if (!l) return res.status(404).json({ erreur: 'Introuvable' });
    const acts = db.activations.filter(a => a.licence_id === id);
    res.json({ ...l, jours_restants: joursRestants(l.date_fin), activations: acts });
  } catch (err) { console.error(err); res.status(500).json({ erreur: 'Erreur serveur' }); }
});

app.put('/admin/licences/:id/modifier', adminAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const { client_nom, client_email, client_tel, notes } = req.body;
  if (!client_nom) return res.status(400).json({ erreur: 'Nom client obligatoire' });
  try {
    if (USE_PG) {
      await pool.query(
        'UPDATE licences SET client_nom=$1, client_email=$2, client_tel=$3, notes=$4 WHERE id=$5',
        [client_nom, client_email ?? null, client_tel ?? null, notes ?? null, id]
      );
      return res.json({ ok: true });
    }
    const db = jsonLire();
    const l  = db.licences.find(l => l.id === id);
    if (!l) return res.status(404).json({ erreur: 'Introuvable' });
    l.client_nom   = client_nom;
    l.client_email = client_email ?? null;
    l.client_tel   = client_tel   ?? null;
    l.notes        = notes        ?? null;
    jsonSauve(db);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ erreur: 'Erreur serveur' }); }
});

app.post('/admin/licences', adminAuth, async (req, res) => {
  const { client_nom, client_email, client_tel, plan, mois, max_appareils, notes } = req.body;
  if (!client_nom) return res.status(400).json({ erreur: 'Nom client obligatoire' });

  const dateFin = new Date();
  if (plan === 'illimite')    dateFin.setFullYear(dateFin.getFullYear() + 99);
  else if (plan === 'annuel') dateFin.setFullYear(dateFin.getFullYear() + (mois ? Math.ceil(mois / 12) : 1));
  else                        dateFin.setMonth(dateFin.getMonth() + (mois ?? 1));

  const cle = genererCle();
  try {
    if (USE_PG) {
      const { rows } = await pool.query(
        `INSERT INTO licences (cle,client_nom,client_email,client_tel,plan,date_fin,max_appareils,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,cle,date_fin`,
        [cle, client_nom, client_email ?? null, client_tel ?? null,
         plan ?? 'mensuel', dateFin.toISOString(), max_appareils ?? 1, notes ?? null]);
      return res.json({ ok: true, ...rows[0] });
    }
    const db = jsonLire();
    const l  = {
      id: db.nextId++, cle, client_nom,
      client_email: client_email ?? null, client_tel: client_tel ?? null,
      plan: plan ?? 'mensuel',
      date_debut: new Date().toISOString(), date_fin: dateFin.toISOString(),
      max_appareils: max_appareils ?? 1, actif: true, notes: notes ?? null,
      created_at: new Date().toISOString(),
    };
    db.licences.push(l);
    jsonSauve(db);
    res.json({ ok: true, id: l.id, cle: l.cle, date_fin: l.date_fin });
  } catch (err) { console.error(err); res.status(500).json({ erreur: 'Erreur serveur' }); }
});

app.put('/admin/licences/:id/prolonger', adminAuth, async (req, res) => {
  const { mois } = req.body;
  const id = parseInt(req.params.id);
  try {
    if (USE_PG) {
      const { rows } = await pool.query('SELECT * FROM licences WHERE id=$1', [id]);
      if (!rows[0]) return res.status(404).json({ erreur: 'Introuvable' });
      const base = new Date(Math.max(new Date(rows[0].date_fin), Date.now()));
      base.setMonth(base.getMonth() + (mois ?? 1));
      await pool.query('UPDATE licences SET date_fin=$1 WHERE id=$2', [base.toISOString(), id]);
      return res.json({ ok: true, date_fin: base.toISOString(), jours_restants: joursRestants(base) });
    }
    const db = jsonLire();
    const l  = db.licences.find(l => l.id === id);
    if (!l) return res.status(404).json({ erreur: 'Introuvable' });
    const base = new Date(Math.max(new Date(l.date_fin), Date.now()));
    base.setMonth(base.getMonth() + (mois ?? 1));
    l.date_fin = base.toISOString();
    jsonSauve(db);
    res.json({ ok: true, date_fin: l.date_fin, jours_restants: joursRestants(l.date_fin) });
  } catch (err) { console.error(err); res.status(500).json({ erreur: 'Erreur serveur' }); }
});

app.put('/admin/licences/:id/appareils', adminAuth, async (req, res) => {
  const { max_appareils } = req.body;
  if (!max_appareils || max_appareils < 1)
    return res.status(400).json({ erreur: 'Nombre invalide (minimum 1)' });
  const id = parseInt(req.params.id);
  try {
    if (USE_PG) {
      const { rows: lRows } = await pool.query('SELECT 1 FROM licences WHERE id=$1', [id]);
      if (!lRows[0]) return res.status(404).json({ erreur: 'Introuvable' });
      const { rows: cnt } = await pool.query(
        'SELECT COUNT(*) as nb FROM activations WHERE licence_id=$1 AND actif=TRUE', [id]);
      const nb = parseInt(cnt[0].nb);
      if (max_appareils < nb)
        return res.status(400).json({ erreur: `Impossible — ${nb} appareil(s) déjà actif(s). Révoquez-en d'abord.` });
      await pool.query('UPDATE licences SET max_appareils=$1 WHERE id=$2', [parseInt(max_appareils), id]);
      return res.json({ ok: true, max_appareils: parseInt(max_appareils) });
    }
    const db = jsonLire();
    const l  = db.licences.find(l => l.id === id);
    if (!l) return res.status(404).json({ erreur: 'Introuvable' });
    const nb = db.activations.filter(a => a.licence_id === id && a.actif).length;
    if (max_appareils < nb)
      return res.status(400).json({ erreur: `Impossible — ${nb} appareil(s) déjà actif(s). Révoquez-en d'abord.` });
    l.max_appareils = parseInt(max_appareils);
    jsonSauve(db);
    res.json({ ok: true, max_appareils: l.max_appareils });
  } catch (err) { console.error(err); res.status(500).json({ erreur: 'Erreur serveur' }); }
});

app.put('/admin/licences/:id/date', adminAuth, async (req, res) => {
  const { date_fin } = req.body;
  if (!date_fin) return res.status(400).json({ erreur: 'date_fin obligatoire' });
  const id = parseInt(req.params.id);
  const d  = new Date(date_fin).toISOString();
  try {
    if (USE_PG) {
      await pool.query('UPDATE licences SET date_fin=$1 WHERE id=$2', [d, id]);
      return res.json({ ok: true, date_fin: d, jours_restants: joursRestants(d) });
    }
    const db = jsonLire();
    const l  = db.licences.find(l => l.id === id);
    if (!l) return res.status(404).json({ erreur: 'Introuvable' });
    l.date_fin = d;
    jsonSauve(db);
    res.json({ ok: true, date_fin: d, jours_restants: joursRestants(d) });
  } catch (err) { console.error(err); res.status(500).json({ erreur: 'Erreur serveur' }); }
});

app.put('/admin/licences/:id/revoquer', adminAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    if (USE_PG) {
      await pool.query('UPDATE licences SET actif=FALSE WHERE id=$1', [id]);
      return res.json({ ok: true });
    }
    const db = jsonLire();
    const l  = db.licences.find(l => l.id === id);
    if (!l) return res.status(404).json({ erreur: 'Introuvable' });
    l.actif = false;
    jsonSauve(db);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ erreur: 'Erreur serveur' }); }
});

app.put('/admin/licences/:id/reactiver', adminAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    if (USE_PG) {
      await pool.query('UPDATE licences SET actif=TRUE WHERE id=$1', [id]);
      await pool.query('UPDATE activations SET actif=TRUE WHERE licence_id=$1', [id]);
      return res.json({ ok: true });
    }
    const db = jsonLire();
    const l  = db.licences.find(l => l.id === id);
    if (!l) return res.status(404).json({ erreur: 'Introuvable' });
    l.actif = true;
    db.activations.filter(a => a.licence_id === id).forEach(a => { a.actif = true; });
    jsonSauve(db);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ erreur: 'Erreur serveur' }); }
});

app.delete('/admin/licences/:id', adminAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    if (USE_PG) {
      await pool.query('DELETE FROM licences WHERE id=$1', [id]);
      return res.json({ ok: true });
    }
    const db = jsonLire();
    const idx = db.licences.findIndex(l => l.id === id);
    if (idx === -1) return res.status(404).json({ erreur: 'Introuvable' });
    db.licences.splice(idx, 1);
    db.activations = db.activations.filter(a => a.licence_id !== id);
    jsonSauve(db);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ erreur: 'Erreur serveur' }); }
});

app.delete('/admin/activations/:id', adminAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    if (USE_PG) {
      await pool.query('UPDATE activations SET actif=FALSE WHERE id=$1', [id]);
      return res.json({ ok: true });
    }
    const db = jsonLire();
    const a  = db.activations.find(a => a.id === id);
    if (!a) return res.status(404).json({ erreur: 'Introuvable' });
    a.actif = false;
    jsonSauve(db);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ erreur: 'Erreur serveur' }); }
});

app.delete('/admin/activations/:id/supprimer', adminAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    if (USE_PG) {
      await pool.query('DELETE FROM activations WHERE id=$1', [id]);
      return res.json({ ok: true });
    }
    const db = jsonLire();
    db.activations = db.activations.filter(a => a.id !== id);
    jsonSauve(db);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ erreur: 'Erreur serveur' }); }
});

app.put('/admin/activations/:id/reactiver', adminAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    if (USE_PG) {
      await pool.query('UPDATE activations SET actif=TRUE, last_seen=NOW() WHERE id=$1', [id]);
      return res.json({ ok: true });
    }
    const db = jsonLire();
    const a  = db.activations.find(a => a.id === id);
    if (!a) return res.status(404).json({ erreur: 'Introuvable' });
    a.actif    = true;
    a.last_seen = new Date().toISOString();
    jsonSauve(db);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ erreur: 'Erreur serveur' }); }
});

// ── Démarrage ────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log('\n╔══════════════════════════════════════╗');
    console.log('║   MiZane License Server  v1.0        ║');
    console.log('╚══════════════════════════════════════╝');
    console.log(`  Port      : http://localhost:${PORT}`);
    console.log(`  Admin Key : ${ADMIN_KEY}\n`);
  });
}).catch(err => {
  console.error('Erreur connexion base de données:', err);
  process.exit(1);
});
