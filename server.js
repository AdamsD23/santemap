/**
 * SantéMap : API REST (Express + MySQL) et application web (dossier public/)
 */

require('dotenv').config();
const express = require('express');
const path = require('path');

const config = require('./config');
const { initDB, initTables, closePool } = require('./db/mysql');
const { seedAdmin, importerOsm, seedDemo } = require('./db/seed');
const { authentifier, exigerRole } = require('./middleware/auth');
const { limiteur } = require('./lib/util');

const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.fr",
    "connect-src 'self' https://nominatim.openstreetmap.org",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
].join('; ');

function createApp() {
    const app = express();
    // Derrière l'hébergeur, l'IP réelle du visiteur est dans X-Forwarded-For
    app.set('trust proxy', 1);
    app.disable('x-powered-by');

    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        res.setHeader('Permissions-Policy', 'geolocation=(self), microphone=(self), camera=(self)');
        res.setHeader('Content-Security-Policy', CSP);
        next();
    });

    // Les photos sont envoyées en base64 : la limite couvre une photo de 1,5 Mo
    app.use(express.json({ limit: '3mb' }));

    app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist'), { maxAge: '7d' }));
    app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], dotfiles: 'deny' }));

    app.get('/api/health', (req, res) => res.json({ status: 'ok', demo: config.SEED_DEMO }));

    app.use('/api/auth/connexion', limiteur({ fenetreMs: 15 * 60 * 1000, max: 10, message: 'Trop de tentatives de connexion, réessayez dans 15 minutes' }));
    app.use('/api/auth/inscription', limiteur({ fenetreMs: 60 * 60 * 1000, max: 10 }));
    app.use('/api', limiteur({ fenetreMs: 15 * 60 * 1000, max: 1500 }));

    app.use('/api/auth', require('./routes/auth'));
    app.use('/api', require('./routes/public'));
    app.use('/api/moi', authentifier, require('./routes/moi'));
    app.use('/api/admin', authentifier, exigerRole('admin'), require('./routes/admin'));
    app.use('/api/pro', authentifier, exigerRole('etablissement'), require('./routes/pro'));

    app.use('/api', (req, res) => res.status(404).json({ error: 'Route API introuvable', code: 'INTROUVABLE' }));
    app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', 'index.html')));

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Photo trop lourde (1,5 Mo maximum)', code: 'TROP_LOURD' });
        if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Requête invalide', code: 'JSON_INVALIDE' });
        if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message, code: err.code || 'ERREUR' });
        console.error(err);
        res.status(500).json({ error: 'Erreur interne, réessayez dans un instant', code: 'ERREUR_SERVEUR' });
    });

    return app;
}

async function start() {
    try {
        await initDB();
        await initTables();
        await seedAdmin();
        if (config.IMPORT_OSM) await importerOsm();
        if (config.SEED_DEMO) await seedDemo();

        const server = createApp().listen(config.PORT, () => {
            console.log(`SantéMap démarré : http://localhost:${config.PORT}`);
        });
        const arreter = async () => {
            server.close();
            await closePool();
            process.exit(0);
        };
        process.on('SIGINT', arreter);
        process.on('SIGTERM', arreter);
    } catch (err) {
        console.error('Impossible de démarrer :', err.message);
        process.exit(1);
    }
}

module.exports = { createApp };

if (require.main === module) start();
