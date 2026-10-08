/**
 * Espace de l'utilisateur connecté : contributions, rendez-vous, points, notifications
 */

const express = require('express');
const config = require('../config');
const { query, transaction } = require('../db/mysql');
const { PAYS } = require('../lib/pays');
const { CODES } = require('../lib/categories');
const { creneauxDuJour } = require('../lib/creneaux');
const { code, notifier, palier } = require('../lib/services');
const { profil } = require('./auth');
const { ApiError, route, texte, nombre, normaliserTelephone, decoderPhoto, maintenantLocal, ajouterJours, limiteur } = require('../lib/util');

const router = express.Router();
const pays = () => PAYS[config.PAYS_DEFAUT];

/** Tableau de bord du compte : profil, points, contributions, rendez-vous */
router.get('/tableau', route(async (req, res) => {
    const [user] = await query('SELECT * FROM users WHERE id = ?', [req.user.id]);
    const historique = await query('SELECT points, raison, created_at FROM points_historique WHERE user_id = ? ORDER BY id DESC LIMIT 20', [user.id]);
    const contributions = await query(
        `SELECT id, nom, categorie, commune, statut, motif_refus, created_at FROM etablissements
         WHERE contributeur_id = ? ORDER BY id DESC LIMIT 50`,
        [user.id]
    );
    const rendezVous = await query(
        `SELECT r.id, r.reference, r.debut, r.motif, r.statut, e.id AS etablissement_id, e.nom AS etablissement, e.commune, e.telephone
         FROM rendez_vous r JOIN etablissements e ON e.id = r.etablissement_id
         WHERE r.user_id = ? ORDER BY r.debut DESC LIMIT 30`,
        [user.id]
    );
    const [{ nonLues }] = await query('SELECT COUNT(*) AS nonLues FROM notifications WHERE user_id = ? AND lu = FALSE', [user.id]);
    const [{ filleuls }] = await query('SELECT COUNT(*) AS filleuls FROM users WHERE parrain_id = ?', [user.id]);

    res.json({
        user: profil(user),
        palier: palier(user.points),
        historique,
        contributions,
        rendez_vous: rendezVous,
        notifications_non_lues: nonLues,
        filleuls
    });
}));

router.post('/contributions', limiteur({ fenetreMs: 60 * 60 * 1000, max: 30 }), route(async (req, res) => {
    const nom = texte(req.body.nom, 200);
    const categorie = req.body.categorie;
    const lat = nombre(req.body.lat, { min: -90, max: 90 });
    const lng = nombre(req.body.lng, { min: -180, max: 180 });
    if (!nom || nom.length < 3) throw new ApiError(400, 'Indiquez le nom de l\'établissement');
    if (!CODES.includes(categorie)) throw new ApiError(400, 'Choisissez le type d\'établissement');
    if (lat === null || lng === null) throw new ApiError(400, 'Placez l\'établissement sur la carte');

    const photo = req.body.photo ? decoderPhoto(req.body.photo, config.PHOTO_MAX_OCTETS) : null;

    const [{ enAttente }] = await query(
        "SELECT COUNT(*) AS enAttente FROM etablissements WHERE contributeur_id = ? AND statut = 'en_attente'",
        [req.user.id]
    );
    if (enAttente >= config.CONTRIBUTIONS_EN_ATTENTE_MAX) {
        throw new ApiError(429, 'Vous avez déjà beaucoup de contributions en attente : patientez pendant leur vérification');
    }

    const id = await transaction(async db => {
        const [r] = await db.query(
            `INSERT INTO etablissements (pays, categorie, nom, lat, lng, adresse, commune, telephone, horaires, statut, source, contributeur_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'en_attente', 'contribution', ?)`,
            [pays().code, categorie, nom, lat.toFixed(6), lng.toFixed(6), texte(req.body.adresse), texte(req.body.commune, 100),
                texte(req.body.telephone, 60), texte(req.body.horaires), req.user.id]
        );
        if (photo) {
            await db.query('INSERT INTO photos (etablissement_id, data, mime, ajoute_par) VALUES (?, ?, ?, ?)', [r.insertId, photo.data, photo.mime, req.user.id]);
        }
        return r.insertId;
    });

    const gain = config.POINTS.CONTRIBUTION + (photo ? config.POINTS.PHOTO : 0);
    res.status(201).json({
        id,
        statut: 'en_attente',
        message: `Merci ! L'équipe va vérifier « ${nom} ». Vous gagnerez ${gain} points à la validation.`
    });
}));

router.post('/rendez-vous', route(async (req, res) => {
    const p = pays();
    const maintenant = maintenantLocal(p.fuseau);
    const etablissementId = Number(req.body.etablissement_id) || 0;
    const date = String(req.body.date || '');
    const heure = String(req.body.heure || '');
    const telephone = normaliserTelephone(req.body.telephone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(heure)) throw new ApiError(400, 'Choisissez un créneau');
    if (!telephone || telephone.length < 8) throw new ApiError(400, 'Indiquez un numéro de téléphone pour être joint');
    if (date > ajouterJours(maintenant.date, config.RDV_JOURS)) throw new ApiError(400, 'Ce créneau est trop éloigné');

    const rdv = await transaction(async db => {
        const [[e]] = await db.query(
            "SELECT id, nom, rdv_actif, rdv_duree, rdv_horaires FROM etablissements WHERE id = ? AND statut = 'valide' FOR UPDATE",
            [etablissementId]
        );
        if (!e || !e.rdv_actif) throw new ApiError(404, 'Cet établissement ne propose pas de rendez-vous en ligne');

        // Le verrou sur l'établissement empêche deux réservations simultanées du même créneau
        const [lignes] = await db.query(
            "SELECT debut FROM rendez_vous WHERE etablissement_id = ? AND statut IN ('en_attente', 'confirme') AND debut >= ? AND debut < ?",
            [e.id, `${date} 00:00:00`, `${ajouterJours(date, 1)} 00:00:00`]
        );
        const pris = new Set(lignes.map(l => String(l.debut).slice(0, 16)));
        if (!creneauxDuJour(e, date, pris, maintenant, config.RDV_DELAI_MIN).includes(heure)) {
            throw new ApiError(409, 'Ce créneau n\'est plus disponible, choisissez-en un autre');
        }

        const reference = `SM-${code(6)}`;
        const [r] = await db.query(
            'INSERT INTO rendez_vous (reference, etablissement_id, user_id, debut, motif, telephone) VALUES (?, ?, ?, ?, ?, ?)',
            [reference, e.id, req.user.id, `${date} ${heure}:00`, texte(req.body.motif), telephone]
        );
        await notifier(db, req.user.id, 'Demande de rendez-vous envoyée',
            `${e.nom} — ${date.split('-').reverse().join('/')} à ${heure}. Référence ${reference}. Vous serez prévenu(e) dès la confirmation.`);
        return { id: r.insertId, reference, etablissement: e.nom, debut: `${date} ${heure}:00`, statut: 'en_attente' };
    });
    res.status(201).json(rdv);
}));

router.post('/rendez-vous/:id/annuler', route(async (req, res) => {
    const [rdv] = await query('SELECT * FROM rendez_vous WHERE id = ? AND user_id = ?', [Number(req.params.id) || 0, req.user.id]);
    if (!rdv) throw new ApiError(404, 'Rendez-vous introuvable');
    if (!['en_attente', 'confirme'].includes(rdv.statut)) throw new ApiError(400, 'Ce rendez-vous ne peut plus être annulé');
    await query("UPDATE rendez_vous SET statut = 'annule', annule_par = 'patient' WHERE id = ?", [rdv.id]);
    res.json({ message: 'Rendez-vous annulé' });
}));

router.get('/notifications', route(async (req, res) => {
    const lignes = await query('SELECT id, titre, message, lu, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30', [req.user.id]);
    res.json(lignes.map(n => ({ ...n, lu: !!n.lu })));
}));

router.post('/notifications/lues', route(async (req, res) => {
    await query('UPDATE notifications SET lu = TRUE WHERE user_id = ? AND lu = FALSE', [req.user.id]);
    res.json({ message: 'ok' });
}));

module.exports = router;
