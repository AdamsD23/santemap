/**
 * Administration (équipe SantéMap) : validation des contributions, fiches, gardes, rendez-vous, signalements, comptes
 */

const express = require('express');
const config = require('../config');
const { query, transaction } = require('../db/mysql');
const { CODES } = require('../lib/categories');
const { validerHoraires } = require('../lib/creneaux');
const { notifier, validerContribution } = require('../lib/services');
const { ApiError, route, texte, nombre, lireJson } = require('../lib/util');

const router = express.Router();
const id = req => Number(req.params.id) || 0;

const LIBELLES_RDV = { confirme: 'confirmé', annule: 'annulé', termine: 'terminé' };

/** Change le statut d'un rendez-vous et prévient le patient (utilisé aussi par l'espace établissement) */
async function changerStatutRdv(rdvId, statut, etablissementId = null) {
    if (!LIBELLES_RDV[statut]) throw new ApiError(400, 'Statut invalide');
    const [rdv] = await query(
        `SELECT r.*, e.nom AS etablissement FROM rendez_vous r JOIN etablissements e ON e.id = r.etablissement_id
         WHERE r.id = ? ${etablissementId ? 'AND r.etablissement_id = ?' : ''}`,
        etablissementId ? [rdvId, etablissementId] : [rdvId]
    );
    if (!rdv) throw new ApiError(404, 'Rendez-vous introuvable');
    if (['annule', 'termine'].includes(rdv.statut)) throw new ApiError(400, 'Ce rendez-vous est déjà clôturé');

    await query('UPDATE rendez_vous SET statut = ?, annule_par = ? WHERE id = ?', [statut, statut === 'annule' ? 'etablissement' : null, rdv.id]);
    const quand = `${String(rdv.debut).slice(0, 10).split('-').reverse().join('/')} à ${String(rdv.debut).slice(11, 16)}`;
    if (statut !== 'termine') {
        await notifier({ query }, rdv.user_id, `Rendez-vous ${LIBELLES_RDV[statut]}`,
            `${rdv.etablissement} — ${quand} (réf. ${rdv.reference}).`);
    }
    return { id: rdv.id, statut };
}

router.get('/stats', route(async (req, res) => {
    const [chiffres] = await query(`SELECT
        (SELECT COUNT(*) FROM etablissements WHERE statut = 'valide') AS etablissements,
        (SELECT COUNT(*) FROM etablissements WHERE statut = 'en_attente') AS contributions,
        (SELECT COUNT(*) FROM rendez_vous WHERE statut = 'en_attente') AS rendez_vous,
        (SELECT COUNT(*) FROM signalements WHERE statut = 'nouveau') AS signalements,
        (SELECT COUNT(*) FROM users WHERE role = 'utilisateur') AS utilisateurs,
        (SELECT COUNT(*) FROM etablissements WHERE premium = TRUE) AS partenaires`);
    const parCategorie = await query("SELECT categorie, COUNT(*) AS n FROM etablissements WHERE statut = 'valide' GROUP BY categorie ORDER BY n DESC");
    const contributeurs = await query("SELECT nom, points FROM users WHERE points > 0 ORDER BY points DESC LIMIT 5");
    res.json({ ...chiffres, par_categorie: parCategorie, contributeurs });
}));

/* ---------- Contributions ---------- */

router.get('/contributions', route(async (req, res) => {
    const statut = ['en_attente', 'refuse', 'valide'].includes(req.query.statut) ? req.query.statut : 'en_attente';
    const lignes = await query(
        `SELECT e.id, e.nom, e.categorie, e.lat, e.lng, e.adresse, e.commune, e.telephone, e.horaires, e.statut, e.motif_refus, e.created_at,
                u.nom AS contributeur, u.telephone AS contributeur_telephone,
                (SELECT MIN(p.id) FROM photos p WHERE p.etablissement_id = e.id) AS photo_id
         FROM etablissements e LEFT JOIN users u ON u.id = e.contributeur_id
         WHERE e.statut = ? AND e.source IN ('contribution', 'demo') AND e.contributeur_id IS NOT NULL
         ORDER BY e.id ${statut === 'en_attente' ? 'ASC' : 'DESC'} LIMIT 100`,
        [statut]
    );
    // Établissements déjà connus à moins de 150 m : doublons possibles à vérifier avant de valider
    for (const c of lignes) {
        c.doublons = await query(
            `SELECT id, nom, categorie, ROUND(6371000 * ACOS(LEAST(1, COS(RADIANS(?)) * COS(RADIANS(lat)) * COS(RADIANS(lng) - RADIANS(?)) + SIN(RADIANS(?)) * SIN(RADIANS(lat))))) AS distance
             FROM etablissements WHERE statut = 'valide' AND id <> ? AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
             HAVING distance <= 150 ORDER BY distance LIMIT 3`,
            [c.lat, c.lng, c.lat, c.id, c.lat - 0.0015, c.lat + 0.0015, c.lng - 0.0015, c.lng + 0.0015]
        );
    }
    res.json(lignes);
}));

router.post('/contributions/:id/valider', route(async (req, res) => {
    const resultat = await transaction(async db => {
        const [[etab]] = await db.query("SELECT * FROM etablissements WHERE id = ? AND statut = 'en_attente' FOR UPDATE", [id(req)]);
        if (!etab) throw new ApiError(404, 'Contribution introuvable ou déjà traitée');
        // L'équipe peut corriger le nom ou le type au moment de valider
        const nom = texte(req.body.nom, 200);
        const categorie = CODES.includes(req.body.categorie) ? req.body.categorie : null;
        if (nom || categorie) {
            await db.query('UPDATE etablissements SET nom = COALESCE(?, nom), categorie = COALESCE(?, categorie) WHERE id = ?', [nom, categorie, etab.id]);
            etab.nom = nom || etab.nom;
        }
        if (req.body.verifie) await db.query('UPDATE etablissements SET verifie = TRUE WHERE id = ?', [etab.id]);
        return validerContribution(db, etab, req.user.id);
    });
    res.json({ message: 'Contribution validée', points_attribues: resultat.points });
}));

router.post('/contributions/:id/refuser', route(async (req, res) => {
    const motif = texte(req.body.motif, 255);
    if (!motif) throw new ApiError(400, 'Indiquez le motif du refus');
    const [etab] = await query("SELECT * FROM etablissements WHERE id = ? AND statut = 'en_attente'", [id(req)]);
    if (!etab) throw new ApiError(404, 'Contribution introuvable ou déjà traitée');
    await query("UPDATE etablissements SET statut = 'refuse', motif_refus = ? WHERE id = ?", [motif, etab.id]);
    if (etab.contributeur_id) {
        await notifier({ query }, etab.contributeur_id, 'Contribution non retenue', `« ${etab.nom} » : ${motif}`);
    }
    res.json({ message: 'Contribution refusée' });
}));

router.get('/photos/:id', route(async (req, res) => {
    const [photo] = await query('SELECT data, mime FROM photos WHERE id = ?', [id(req)]);
    if (!photo) throw new ApiError(404, 'Photo introuvable');
    res.setHeader('Content-Type', photo.mime);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(photo.data);
}));

/* ---------- Établissements ---------- */

router.get('/etablissements', route(async (req, res) => {
    const recherche = texte(req.query.q, 80);
    const filtre = req.query.filtre;
    const conditions = ["e.statut = 'valide'"];
    const params = [];
    if (recherche) {
        conditions.push('(e.nom LIKE ? OR e.commune LIKE ?)');
        const motif = `%${recherche.replace(/[\\%_]/g, c => '\\' + c)}%`;
        params.push(motif, motif);
    }
    if (filtre === 'partenaires') conditions.push('e.premium = TRUE');
    if (filtre === 'pharmacies') conditions.push("e.categorie = 'pharmacie'");
    const lignes = await query(
        `SELECT e.id, e.nom, e.categorie, e.commune, e.telephone, e.verifie, e.premium, e.rdv_actif, e.source,
                (SELECT COUNT(*) FROM gardes g WHERE g.etablissement_id = e.id AND g.fin >= UTC_DATE()) AS gardes
         FROM etablissements e WHERE ${conditions.join(' AND ')} ORDER BY e.premium DESC, e.nom LIMIT 50`,
        params
    );
    res.json(lignes);
}));

router.get('/etablissements/:id', route(async (req, res) => {
    const [e] = await query('SELECT * FROM etablissements WHERE id = ?', [id(req)]);
    if (!e) throw new ApiError(404, 'Établissement introuvable');
    const gardes = await query('SELECT id, debut, fin FROM gardes WHERE etablissement_id = ? AND fin >= UTC_DATE() ORDER BY debut', [e.id]);
    const comptes = await query("SELECT id, nom, email, telephone FROM users WHERE etablissement_id = ? AND role = 'etablissement'", [e.id]);
    res.json({ ...e, services: lireJson(e.services, []), rdv_horaires: lireJson(e.rdv_horaires, {}), gardes, comptes });
}));

const BOOLEENS = ['ouvert_24h', 'urgences', 'verifie', 'premium', 'rdv_actif'];
const TEXTES = { adresse: 255, commune: 100, telephone: 60, site_web: 255, horaires: 255, description: 2000 };

router.patch('/etablissements/:id', route(async (req, res) => {
    const [e] = await query('SELECT * FROM etablissements WHERE id = ?', [id(req)]);
    if (!e) throw new ApiError(404, 'Établissement introuvable');
    const b = req.body;
    const champs = {};

    if ('nom' in b) {
        champs.nom = texte(b.nom, 200);
        if (!champs.nom) throw new ApiError(400, 'Le nom est obligatoire');
    }
    if ('categorie' in b) {
        if (!CODES.includes(b.categorie)) throw new ApiError(400, 'Catégorie inconnue');
        champs.categorie = b.categorie;
    }
    for (const [cle, max] of Object.entries(TEXTES)) if (cle in b) champs[cle] = texte(b[cle], max);
    for (const cle of BOOLEENS) if (cle in b) champs[cle] = !!b[cle];
    if ('lat' in b || 'lng' in b) {
        const lat = nombre(b.lat, { min: -90, max: 90 });
        const lng = nombre(b.lng, { min: -180, max: 180 });
        if (lat === null || lng === null) throw new ApiError(400, 'Position invalide');
        Object.assign(champs, { lat: lat.toFixed(6), lng: lng.toFixed(6) });
    }
    if ('services' in b) {
        if (!Array.isArray(b.services) || b.services.length > 30) throw new ApiError(400, 'Liste de services invalide');
        champs.services = JSON.stringify(b.services.map(s => texte(s, 80)).filter(Boolean));
    }
    if ('prix_consultation' in b) {
        if (b.prix_consultation === null || b.prix_consultation === '') {
            champs.prix_consultation = null;
        } else {
            const prix = nombre(b.prix_consultation, { min: 0, max: 10_000_000 });
            if (prix === null) throw new ApiError(400, 'Prix invalide');
            champs.prix_consultation = Math.round(prix);
        }
    }
    if ('rdv_duree' in b) {
        champs.rdv_duree = nombre(b.rdv_duree, { min: 10, max: 120 });
        if (champs.rdv_duree === null) throw new ApiError(400, 'Durée de rendez-vous entre 10 et 120 minutes');
    }
    if ('rdv_horaires' in b) {
        const horaires = validerHoraires(b.rdv_horaires);
        if (!horaires) throw new ApiError(400, 'Horaires de consultation invalides (format 08:00-12:00)');
        champs.rdv_horaires = JSON.stringify(horaires);
    }
    if ('statut' in b) {
        if (!['valide', 'refuse'].includes(b.statut)) throw new ApiError(400, 'Statut invalide');
        champs.statut = b.statut;
    }

    const rdvActif = champs.rdv_actif ?? !!e.rdv_actif;
    const horaires = champs.rdv_horaires ?? e.rdv_horaires;
    if (rdvActif && !Object.keys(lireJson(horaires, {})).length) {
        throw new ApiError(400, 'Renseignez les horaires de consultation avant d\'activer les rendez-vous');
    }
    if (!Object.keys(champs).length) throw new ApiError(400, 'Aucune modification');

    await query(`UPDATE etablissements SET ${Object.keys(champs).map(c => `${c} = ?`).join(', ')} WHERE id = ?`, [...Object.values(champs), e.id]);
    res.json({ message: 'Fiche mise à jour' });
}));

router.post('/etablissements/:id/gardes', route(async (req, res) => {
    const { debut, fin } = req.body;
    const date = /^\d{4}-\d{2}-\d{2}$/;
    if (!date.test(debut || '') || !date.test(fin || '') || fin < debut) throw new ApiError(400, 'Période de garde invalide');
    const [e] = await query("SELECT id, categorie FROM etablissements WHERE id = ? AND statut = 'valide'", [id(req)]);
    if (!e) throw new ApiError(404, 'Établissement introuvable');
    if (e.categorie !== 'pharmacie') throw new ApiError(400, 'Les gardes concernent uniquement les pharmacies');
    const r = await query('INSERT INTO gardes (etablissement_id, debut, fin) VALUES (?, ?, ?)', [e.id, debut, fin]);
    res.status(201).json({ id: r.insertId, debut, fin });
}));

router.delete('/gardes/:id', route(async (req, res) => {
    const r = await query('DELETE FROM gardes WHERE id = ?', [id(req)]);
    if (!r.affectedRows) throw new ApiError(404, 'Garde introuvable');
    res.json({ message: 'Garde supprimée' });
}));

/* ---------- Rendez-vous ---------- */

router.get('/rendez-vous', route(async (req, res) => {
    const statut = ['en_attente', 'confirme', 'annule', 'termine'].includes(req.query.statut) ? req.query.statut : null;
    const lignes = await query(
        `SELECT r.id, r.reference, r.debut, r.motif, r.telephone, r.statut, r.created_at, e.nom AS etablissement, u.nom AS patient
         FROM rendez_vous r JOIN etablissements e ON e.id = r.etablissement_id JOIN users u ON u.id = r.user_id
         ${statut ? 'WHERE r.statut = ?' : ''} ORDER BY r.debut DESC LIMIT 100`,
        statut ? [statut] : []
    );
    res.json(lignes);
}));

router.patch('/rendez-vous/:id', route(async (req, res) => {
    res.json(await changerStatutRdv(id(req), req.body.statut));
}));

/* ---------- Signalements ---------- */

router.get('/signalements', route(async (req, res) => {
    const lignes = await query(
        `SELECT s.id, s.motif, s.message, s.statut, s.created_at, e.id AS etablissement_id, e.nom AS etablissement, u.nom AS auteur
         FROM signalements s JOIN etablissements e ON e.id = s.etablissement_id LEFT JOIN users u ON u.id = s.user_id
         WHERE s.statut = 'nouveau' ORDER BY s.id DESC LIMIT 100`
    );
    res.json(lignes);
}));

router.post('/signalements/:id/traite', route(async (req, res) => {
    const r = await query("UPDATE signalements SET statut = 'traite' WHERE id = ?", [id(req)]);
    if (!r.affectedRows) throw new ApiError(404, 'Signalement introuvable');
    res.json({ message: 'Signalement traité' });
}));

/* ---------- Comptes ---------- */

router.get('/utilisateurs', route(async (req, res) => {
    const recherche = texte(req.query.q, 80);
    const motif = recherche ? `%${recherche.replace(/[\\%_]/g, c => '\\' + c)}%` : null;
    const lignes = await query(
        `SELECT u.id, u.nom, u.email, u.telephone, u.role, u.points, u.actif, u.etablissement_id, e.nom AS etablissement, u.created_at
         FROM users u LEFT JOIN etablissements e ON e.id = u.etablissement_id
         ${motif ? 'WHERE u.nom LIKE ? OR u.email LIKE ? OR u.telephone LIKE ?' : ''}
         ORDER BY u.id DESC LIMIT 50`,
        motif ? [motif, motif, motif] : []
    );
    res.json(lignes);
}));

router.patch('/utilisateurs/:id', route(async (req, res) => {
    const [u] = await query('SELECT id, role FROM users WHERE id = ?', [id(req)]);
    if (!u) throw new ApiError(404, 'Compte introuvable');
    if (u.id === req.user.id) throw new ApiError(400, 'Vous ne pouvez pas modifier votre propre compte ici');

    const champs = {};
    if ('actif' in req.body) champs.actif = !!req.body.actif;
    if ('role' in req.body) {
        if (!['utilisateur', 'etablissement', 'admin'].includes(req.body.role)) throw new ApiError(400, 'Rôle invalide');
        champs.role = req.body.role;
    }
    if ((champs.role || u.role) === 'etablissement') {
        const etabId = Number(req.body.etablissement_id) || 0;
        const [e] = await query("SELECT id FROM etablissements WHERE id = ? AND statut = 'valide'", [etabId]);
        if (!e) throw new ApiError(400, 'Indiquez l\'établissement géré par ce compte');
        champs.etablissement_id = e.id;
    } else if (champs.role) {
        champs.etablissement_id = null;
    }
    if (!Object.keys(champs).length) throw new ApiError(400, 'Aucune modification');
    await query(`UPDATE users SET ${Object.keys(champs).map(c => `${c} = ?`).join(', ')} WHERE id = ?`, [...Object.values(champs), u.id]);
    res.json({ message: 'Compte mis à jour' });
}));

module.exports = router;
module.exports.changerStatutRdv = changerStatutRdv;
