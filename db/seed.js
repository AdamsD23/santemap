/**
 * Données de départ : compte administrateur, établissements OpenStreetMap, comptes de démonstration
 */

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { query } = require('./mysql');
const { code } = require('../lib/services');

async function creerUtilisateur({ nom, email, telephone, motDePasse, role = 'utilisateur', etablissementId = null }) {
    const existe = await query('SELECT id FROM users WHERE email = ?', [email]);
    if (existe.length) return existe[0].id;
    const hash = await bcrypt.hash(motDePasse, 10);
    const res = await query(
        'INSERT INTO users (nom, email, telephone, mot_de_passe, role, etablissement_id, code_parrainage) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [nom, email, telephone, hash, role, etablissementId, code(6)]
    );
    return res.insertId;
}

async function seedAdmin() {
    await creerUtilisateur({ nom: 'Équipe SantéMap', email: config.ADMIN_EMAIL, telephone: null, motDePasse: config.ADMIN_PASSWORD, role: 'admin' });
}

/** Charge data/osm-<pays>.json si les établissements de ce pays n'ont pas encore été importés */
async function importerOsm(pays = config.PAYS_DEFAUT) {
    const fichier = path.join(__dirname, '..', 'data', `osm-${pays.toLowerCase()}.json`);
    if (!fs.existsSync(fichier)) return 0;
    const [{ n }] = await query("SELECT COUNT(*) AS n FROM etablissements WHERE source = 'osm' AND pays = ?", [pays]);
    if (n > 0) return 0;

    const { etablissements } = JSON.parse(fs.readFileSync(fichier, 'utf8'));
    const colonnes = ['pays', 'categorie', 'nom', 'lat', 'lng', 'adresse', 'commune', 'telephone', 'site_web', 'horaires', 'ouvert_24h', 'urgences', 'source', 'osm_id'];
    for (let i = 0; i < etablissements.length; i += 500) {
        const lot = etablissements.slice(i, i + 500).map(e => [
            pays, e.categorie, e.nom, e.lat, e.lng, e.adresse, e.commune, e.telephone, e.site_web, e.horaires,
            e.ouvert_24h, e.urgences, 'osm', e.osm_id
        ]);
        await query(`INSERT IGNORE INTO etablissements (${colonnes.join(', ')}) VALUES ?`, [lot]);
    }
    console.log(`${etablissements.length} établissements OpenStreetMap importés (${pays})`);
    return etablissements.length;
}

/**
 * Démonstration : un centre médical d'exemple (rendez-vous en ligne), un compte patient
 * avec deux contributions en attente de validation, et un compte « établissement ».
 */
async function seedDemo() {
    const [{ n }] = await query("SELECT COUNT(*) AS n FROM etablissements WHERE source = 'demo'");
    if (n > 0) return;

    const semaine = ['08:00-12:00', '14:00-17:00'];
    const centre = await query(
        `INSERT INTO etablissements
         (pays, categorie, nom, lat, lng, adresse, commune, telephone, horaires, description, source, verifie, premium,
          services, prix_consultation, rdv_actif, rdv_duree, rdv_horaires, valide_le)
         VALUES ('CI', 'clinique', ?, 5.3546, -3.9725, ?, 'Cocody', NULL, ?, ?, 'demo', TRUE, TRUE, ?, 15000, TRUE, 30, ?, UTC_TIMESTAMP())`,
        [
            'Centre médical de démonstration',
            'Riviera Golf (adresse fictive)',
            'Lun–ven 8h–17h, sam 8h–12h',
            'Établissement fictif, créé pour montrer la fiche détaillée et la prise de rendez-vous en ligne proposées aux établissements partenaires.',
            JSON.stringify(['Médecine générale', 'Pédiatrie', 'Gynécologie', 'Échographie', 'Vaccinations']),
            JSON.stringify({ 1: semaine, 2: semaine, 3: semaine, 4: semaine, 5: semaine, 6: ['08:00-12:00'] })
        ]
    );
    const centreId = centre.insertId;

    const patientId = await creerUtilisateur({ nom: 'Awa Kouadio', email: 'demo@santemap.ci', telephone: '0700000001', motDePasse: 'demo12345' });
    await creerUtilisateur({ nom: 'Centre médical (démo)', email: 'centre@santemap.ci', telephone: '0700000002', motDePasse: 'demo12345', role: 'etablissement', etablissementId: centreId });

    const contributions = [
        ['pharmacie', 'Pharmacie exemple — Yopougon', 5.3460, -4.0790, 'Yopougon'],
        ['laboratoire', 'Laboratoire exemple — Marcory', 5.3030, -3.9880, 'Marcory']
    ];
    for (const [categorie, nom, lat, lng, commune] of contributions) {
        await query(
            `INSERT INTO etablissements (pays, categorie, nom, lat, lng, commune, statut, source, contributeur_id)
             VALUES ('CI', ?, ?, ?, ?, ?, 'en_attente', 'demo', ?)`,
            [categorie, nom, lat, lng, commune, patientId]
        );
    }
    console.log('Données de démonstration créées');
}

module.exports = { seedAdmin, importerOsm, seedDemo, creerUtilisateur };
