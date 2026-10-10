/**
 * Routes publiques : recherche autour de soi, fiche d'un établissement, créneaux, photos, signalements, classement
 */

const express = require('express');
const config = require('../config');
const { query } = require('../db/mysql');
const { PAYS } = require('../lib/pays');
const { CATEGORIES, CODES } = require('../lib/categories');
const { authentifierSiPossible } = require('../middleware/auth');
const { creneauxDuJour, prochainsCreneaux, prochainsJours, PLAGES } = require('../lib/creneaux');
const { similarite, SEUIL } = require('../lib/doublons');
const { ApiError, route, texte, nombre, maintenantLocal, ajouterJours, boiteAutour, lireJson, limiteur } = require('../lib/util');

const router = express.Router();
const pays = () => PAYS[config.PAYS_DEFAUT];

const DISTANCE = `(6371 * ACOS(LEAST(1, COS(RADIANS(?)) * COS(RADIANS(e.lat)) * COS(RADIANS(e.lng) - RADIANS(?)) + SIN(RADIANS(?)) * SIN(RADIANS(e.lat)))))`;

const COLONNES_LISTE = `e.id, e.nom, e.categorie, e.lat, e.lng, e.adresse, e.commune, e.telephone,
    e.ouvert_24h, e.urgences, e.verifie, e.premium, e.rdv_actif,
    EXISTS(SELECT 1 FROM gardes g WHERE g.etablissement_id = e.id AND ? BETWEEN g.debut AND g.fin) AS de_garde,
    (SELECT MIN(p.id) FROM photos p WHERE p.etablissement_id = e.id) AS photo_id`;

function formatListe(e) {
    return {
        id: e.id,
        nom: e.nom,
        categorie: e.categorie,
        lat: Number(e.lat),
        lng: Number(e.lng),
        adresse: e.adresse,
        commune: e.commune,
        telephone: e.telephone,
        ouvert_24h: !!e.ouvert_24h,
        urgences: !!e.urgences,
        verifie: !!e.verifie,
        premium: !!e.premium,
        rdv_actif: !!e.rdv_actif,
        de_garde: !!e.de_garde,
        photo_id: e.photo_id,
        distance: e.distance === undefined ? null : Math.round(e.distance * 1000)
    };
}

/** Rendez-vous déjà pris sur une période, au format 'AAAA-MM-JJ HH:MM' */
async function creneauxPris(etablissementId, du, au) {
    const lignes = await query(
        `SELECT debut FROM rendez_vous
         WHERE etablissement_id = ? AND statut IN ('en_attente', 'confirme') AND debut >= ? AND debut < ?`,
        [etablissementId, `${du} 00:00:00`, `${au} 00:00:00`]
    );
    return new Set(lignes.map(l => String(l.debut).slice(0, 16)));
}

router.get('/meta', route(async (req, res) => {
    const p = pays();
    const [stats] = await query(
        `SELECT (SELECT COUNT(*) FROM etablissements WHERE pays = ? AND statut = 'valide') AS etablissements,
                (SELECT COUNT(DISTINCT contributeur_id) FROM etablissements WHERE pays = ? AND statut = 'valide' AND contributeur_id IS NOT NULL) AS contributeurs`,
        [p.code, p.code]
    );
    res.json({
        stats,
        echanges: config.ECHANGES,
        plages: PLAGES,
        pays: { code: p.code, nom: p.nom, ville: p.ville, centre: p.centre, zoom: p.zoom, urgences: p.urgences, communes: p.communes },
        categories: CATEGORIES,
        points: config.POINTS,
        paliers: config.PALIERS,
        demo: config.SEED_DEMO
    });
}));

router.get('/etablissements', route(async (req, res) => {
    const p = pays();
    const lat = nombre(req.query.lat, { min: -90, max: 90 }) ?? p.centre.lat;
    const lng = nombre(req.query.lng, { min: -180, max: 180 }) ?? p.centre.lng;
    const rayon = nombre(req.query.rayon, { min: 0.2, max: config.RAYON_MAX_KM }) ?? 5;
    const categorie = CODES.includes(req.query.categorie) ? req.query.categorie : null;
    const garde = req.query.garde === '1';
    const recherche = texte(req.query.q, 80);
    const aujourdhui = maintenantLocal(p.fuseau).date;

    let lignes;
    if (recherche) {
        // Recherche par nom ou commune dans tout le pays, les plus proches d'abord
        const motif = `%${recherche.replace(/[\\%_]/g, c => '\\' + c)}%`;
        lignes = await query(
            `SELECT ${COLONNES_LISTE}, ${DISTANCE} AS distance FROM etablissements e
             WHERE e.pays = ? AND e.statut = 'valide' AND (e.nom LIKE ? OR e.commune LIKE ?)
             ORDER BY distance LIMIT 200`,
            [aujourdhui, lat, lng, lat, p.code, motif, motif]
        );
    } else {
        const b = boiteAutour(lat, lng, rayon);
        lignes = await query(
            `SELECT ${COLONNES_LISTE}, ${DISTANCE} AS distance FROM etablissements e
             WHERE e.pays = ? AND e.statut = 'valide' AND e.lat BETWEEN ? AND ? AND e.lng BETWEEN ? AND ?
             HAVING distance <= ? ORDER BY distance LIMIT 3000`,
            [aujourdhui, lat, lng, lat, p.code, b.latMin, b.latMax, b.lngMin, b.lngMax, rayon]
        );
    }

    // Nombre d'établissements par catégorie (pour les filtres), avant d'appliquer le filtre choisi
    const compteurs = { tous: lignes.length, garde: lignes.filter(e => e.de_garde && e.categorie === 'pharmacie').length };
    for (const code of CODES) compteurs[code] = lignes.filter(e => e.categorie === code).length;

    const filtres = lignes
        .filter(e => !categorie || e.categorie === categorie)
        .filter(e => !garde || (e.de_garde && e.categorie === 'pharmacie'));

    res.json({
        centre: { lat, lng },
        rayon,
        recherche,
        total: filtres.length,
        compteurs,
        items: filtres.slice(0, config.RESULTATS_MAX).map(formatListe)
    });
}));

router.get('/etablissements/:id', authentifierSiPossible, route(async (req, res) => {
    const p = pays();
    const maintenant = maintenantLocal(p.fuseau);
    const [e] = await query(
        `SELECT e.*, EXISTS(SELECT 1 FROM gardes g WHERE g.etablissement_id = e.id AND ? BETWEEN g.debut AND g.fin) AS de_garde
         FROM etablissements e WHERE e.id = ?`,
        [maintenant.date, Number(req.params.id) || 0]
    );
    const estAuteur = req.user && e && e.contributeur_id === req.user.id;
    if (!e || (e.statut !== 'valide' && !estAuteur && req.user?.role !== 'admin')) {
        throw new ApiError(404, 'Établissement introuvable');
    }

    const photos = await query('SELECT id FROM photos WHERE etablissement_id = ? ORDER BY id', [e.id]);
    const gardes = await query(
        'SELECT debut, fin FROM gardes WHERE etablissement_id = ? AND fin >= ? ORDER BY debut LIMIT 5',
        [e.id, maintenant.date]
    );

    let creneaux = [];
    if (e.rdv_actif && e.statut === 'valide') {
        const fin = ajouterJours(maintenant.date, config.RDV_JOURS);
        const pris = await creneauxPris(e.id, maintenant.date, fin);
        creneaux = prochainsCreneaux(e, pris, maintenant, config.RDV_DELAI_MIN, config.RDV_JOURS);
    }

    res.json({
        ...formatListe(e),
        site_web: e.site_web,
        quartier: e.quartier,
        agrement: e.agrement,
        revendique: !!e.revendique,
        mis_a_jour: e.updated_at,
        horaires: e.horaires,
        horaires_detail: lireJson(e.horaires_detail, []),
        assurances: e.premium ? e.assurances : null,
        tarifs: e.premium ? lireJson(e.tarifs, []) : [],
        description: e.description,
        statut: e.statut,
        motif_refus: estAuteur || req.user?.role === 'admin' ? e.motif_refus : undefined,
        source: e.source,
        services: e.premium ? lireJson(e.services, []) : [],
        prix_consultation: e.premium ? e.prix_consultation : null,
        rdv_duree: e.rdv_duree,
        rdv_horaires: e.rdv_actif ? lireJson(e.rdv_horaires, {}) : {},
        photos: photos.map(ph => ph.id),
        gardes,
        prochains_creneaux: creneaux
    });
}));

router.get('/etablissements/:id/creneaux', route(async (req, res) => {
    const p = pays();
    const maintenant = maintenantLocal(p.fuseau);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : maintenant.date;
    if (date < maintenant.date || date > ajouterJours(maintenant.date, config.RDV_JOURS)) {
        throw new ApiError(400, `Les rendez-vous se prennent sur les ${config.RDV_JOURS} prochains jours`);
    }
    const [e] = await query("SELECT id, rdv_actif, rdv_duree, rdv_horaires FROM etablissements WHERE id = ? AND statut = 'valide'", [Number(req.params.id) || 0]);
    if (!e || !e.rdv_actif) throw new ApiError(404, 'Cet établissement ne propose pas de rendez-vous en ligne');

    const pris = await creneauxPris(e.id, date, ajouterJours(date, 1));
    res.json({ date, creneaux: creneauxDuJour(e, date, pris, maintenant, config.RDV_DELAI_MIN) });
}));

/** Jours et plages où l'établissement reçoit des demandes de rendez-vous */
router.get('/etablissements/:id/disponibilites', route(async (req, res) => {
    const maintenant = maintenantLocal(pays().fuseau);
    const [e] = await query("SELECT id, rdv_actif, rdv_horaires FROM etablissements WHERE id = ? AND statut = 'valide'", [Number(req.params.id) || 0]);
    if (!e || !e.rdv_actif) throw new ApiError(404, 'Cet établissement ne propose pas de rendez-vous en ligne');
    res.json({ jours: prochainsJours(e, maintenant, config.RDV_DELAI_MIN, config.RDV_JOURS, 3) });
}));

/**
 * Établissements déjà connus qui ressemblent à celui qu'on s'apprête à ajouter :
 * même numéro de téléphone, ou nom proche à moins de 600 m.
 */
router.get('/doublons', route(async (req, res) => {
    const nom = texte(req.query.nom, 200);
    const categorie = CODES.includes(req.query.categorie) ? req.query.categorie : null;
    const lat = nombre(req.query.lat, { min: -90, max: 90 });
    const lng = nombre(req.query.lng, { min: -180, max: 180 });
    if (!nom || nom.length < 3 || lat === null || lng === null) return res.json({ doublons: [] });

    const b = boiteAutour(lat, lng, 0.6);
    const lignes = await query(
        `SELECT e.id, e.nom, e.categorie, e.commune, e.telephone, ${DISTANCE} AS distance FROM etablissements e
         WHERE e.pays = ? AND e.statut = 'valide' AND e.lat BETWEEN ? AND ? AND e.lng BETWEEN ? AND ? ${categorie ? 'AND e.categorie = ?' : ''}
         HAVING distance <= 0.6 ORDER BY distance LIMIT 200`,
        [lat, lng, lat, pays().code, b.latMin, b.latMax, b.lngMin, b.lngMax, ...(categorie ? [categorie] : [])]
    );
    const chiffres = v => String(v || '').replace(/\D/g, '').slice(-8);
    const telephone = chiffres(req.query.telephone);
    const doublons = lignes
        .map(e => ({ ...e, score: similarite(nom, e.nom), meme_telephone: telephone.length === 8 && chiffres(e.telephone) === telephone }))
        .filter(e => e.score >= SEUIL || e.meme_telephone)
        .sort((x, y) => y.score - x.score)
        .slice(0, 3)
        .map(e => ({ id: e.id, nom: e.nom, categorie: e.categorie, commune: e.commune, distance: Math.round(e.distance * 1000), meme_telephone: e.meme_telephone }));
    res.json({ doublons });
}));

router.get('/photos/:id', route(async (req, res) => {
    const [photo] = await query(
        `SELECT p.data, p.mime FROM photos p JOIN etablissements e ON e.id = p.etablissement_id
         WHERE p.id = ? AND e.statut = 'valide'`,
        [Number(req.params.id) || 0]
    );
    if (!photo) throw new ApiError(404, 'Photo introuvable');
    res.setHeader('Content-Type', photo.mime);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(photo.data);
}));

const MOTIFS_SIGNALEMENT = ['ferme', 'mauvaise_position', 'mauvaises_infos', 'doublon', 'autre'];

router.post('/etablissements/:id/signalements',
    limiteur({ fenetreMs: 60 * 60 * 1000, max: 20 }),
    authentifierSiPossible,
    route(async (req, res) => {
        const motif = req.body.motif;
        if (!MOTIFS_SIGNALEMENT.includes(motif)) throw new ApiError(400, 'Motif de signalement invalide');
        const [e] = await query("SELECT id FROM etablissements WHERE id = ? AND statut = 'valide'", [Number(req.params.id) || 0]);
        if (!e) throw new ApiError(404, 'Établissement introuvable');
        await query(
            'INSERT INTO signalements (etablissement_id, user_id, motif, message) VALUES (?, ?, ?, ?)',
            [e.id, req.user?.id || null, motif, texte(req.body.message, 500)]
        );
        res.status(201).json({ message: 'Merci, l\'équipe va vérifier ces informations.' });
    }));

router.get('/classement', route(async (req, res) => {
    const lignes = await query("SELECT nom, points FROM users WHERE points > 0 AND role = 'utilisateur' AND actif = TRUE ORDER BY points DESC, id LIMIT 10");
    // Seuls le prénom et l'initiale du nom sont affichés publiquement
    res.json(lignes.map(l => {
        const [prenom, ...reste] = l.nom.split(/\s+/);
        return { nom: reste.length ? `${prenom} ${reste.at(-1)[0]}.` : prenom, points: l.points };
    }));
}));

module.exports = router;
module.exports.creneauxPris = creneauxPris;
