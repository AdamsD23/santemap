/**
 * Espace de l'utilisateur connecté : contributions, rendez-vous, points, notifications
 */

const express = require('express');
const config = require('../config');
const { query, transaction } = require('../db/mysql');
const { PAYS } = require('../lib/pays');
const { CODES } = require('../lib/categories');
const { creneauxDuJour, plagesDuJour, PLAGES } = require('../lib/creneaux');
const { code, notifier, palier, crediterPoints } = require('../lib/services');
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
        `SELECT r.id, r.reference, r.debut, r.motif, r.statut, r.plage, r.canal, r.service, r.message, e.id AS etablissement_id,
                e.nom AS etablissement, e.commune, e.quartier, e.telephone
         FROM rendez_vous r JOIN etablissements e ON e.id = r.etablissement_id
         WHERE r.user_id = ? ORDER BY r.debut DESC LIMIT 30`,
        [user.id]
    );
    const echanges = await query('SELECT id, libelle, points, statut, created_at FROM echanges WHERE user_id = ? ORDER BY id DESC LIMIT 10', [user.id]);
    const [{ nonLues }] = await query('SELECT COUNT(*) AS nonLues FROM notifications WHERE user_id = ? AND lu = FALSE', [user.id]);
    const [{ filleuls }] = await query('SELECT COUNT(*) AS filleuls FROM users WHERE parrain_id = ?', [user.id]);

    res.json({
        user: profil(user),
        palier: palier(user.points),
        historique,
        contributions,
        echanges,
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
            `INSERT INTO etablissements (pays, categorie, nom, lat, lng, adresse, commune, quartier, telephone, horaires, garde_declaree, statut, source, contributeur_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'en_attente', 'contribution', ?)`,
            [pays().code, categorie, nom, lat.toFixed(6), lng.toFixed(6), texte(req.body.adresse), texte(req.body.commune, 100), texte(req.body.quartier, 100),
                texte(req.body.telephone, 60), texte(req.body.horaires), categorie === 'pharmacie' && !!req.body.garde, req.user.id]
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

const CANAUX = ['whatsapp', 'sms', 'appel'];

/**
 * Demande de rendez-vous. Deux formes :
 *  - une plage souhaitée (matin, midi, après-midi) : l'établissement confirme l'heure exacte ;
 *  - une heure précise parmi les créneaux libres de l'établissement.
 * Dans les deux cas la demande reste « demandée » jusqu'à la réponse de l'établissement.
 */
router.post('/rendez-vous', route(async (req, res) => {
    const p = pays();
    const maintenant = maintenantLocal(p.fuseau);
    const etablissementId = Number(req.body.etablissement_id) || 0;
    const date = String(req.body.date || '');
    const plage = req.body.plage ? String(req.body.plage) : null;
    const heure = plage ? PLAGES[plage]?.debut : String(req.body.heure || '');
    const telephone = normaliserTelephone(req.body.telephone);
    const canal = CANAUX.includes(req.body.canal) ? req.body.canal : null;
    if (plage && !PLAGES[plage]) throw new ApiError(400, 'Choisissez une plage horaire');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(heure || '')) throw new ApiError(400, 'Choisissez un créneau');
    if (!telephone || telephone.length < 8) throw new ApiError(400, 'Indiquez un numéro de téléphone pour être joint');
    if (date > ajouterJours(maintenant.date, config.RDV_JOURS)) throw new ApiError(400, 'Ce créneau est trop éloigné');

    const rdv = await transaction(async db => {
        const [[e]] = await db.query(
            "SELECT id, nom, rdv_actif, rdv_duree, rdv_horaires FROM etablissements WHERE id = ? AND statut = 'valide' FOR UPDATE",
            [etablissementId]
        );
        if (!e || !e.rdv_actif) throw new ApiError(404, 'Cet établissement ne propose pas de rendez-vous en ligne');

        // Le verrou sur l'établissement empêche deux demandes simultanées pour le même créneau
        if (plage) {
            if (!plagesDuJour(e, date, maintenant, config.RDV_DELAI_MIN).includes(plage)) {
                throw new ApiError(409, 'Cet établissement ne reçoit pas sur cette plage, choisissez-en une autre');
            }
            const [[deja]] = await db.query(
                "SELECT COUNT(*) AS n FROM rendez_vous WHERE user_id = ? AND etablissement_id = ? AND plage = ? AND DATE(debut) = ? AND statut IN ('en_attente', 'confirme')",
                [req.user.id, e.id, plage, date]
            );
            if (deja.n) throw new ApiError(409, 'Vous avez déjà une demande pour cette plage');
        } else {
            const [lignes] = await db.query(
                "SELECT debut FROM rendez_vous WHERE etablissement_id = ? AND statut IN ('en_attente', 'confirme') AND debut >= ? AND debut < ?",
                [e.id, `${date} 00:00:00`, `${ajouterJours(date, 1)} 00:00:00`]
            );
            const pris = new Set(lignes.map(l => String(l.debut).slice(0, 16)));
            if (!creneauxDuJour(e, date, pris, maintenant, config.RDV_DELAI_MIN).includes(heure)) {
                throw new ApiError(409, 'Ce créneau n\'est plus disponible, choisissez-en un autre');
            }
        }

        const reference = `SM-${code(6)}`;
        const service = texte(req.body.service, 100);
        const [r] = await db.query(
            `INSERT INTO rendez_vous (reference, etablissement_id, user_id, debut, motif, telephone, plage, canal, nom_patient, service)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [reference, e.id, req.user.id, `${date} ${heure}:00`, texte(req.body.motif) || service, telephone, plage, canal, texte(req.body.nom_patient, 100), service]
        );
        const jour = date.split('-').reverse().join('/');
        const quand = plage ? `${jour}, ${PLAGES[plage].libelle.toLowerCase()}` : `${jour} à ${heure}`;
        await notifier(db, req.user.id, 'Demande de rendez-vous envoyée',
            `${e.nom} — ${quand}. Référence ${reference}. Ce n'est pas encore une réservation : vous serez prévenu(e) dès que l'établissement répond.`);
        return { id: r.insertId, reference, etablissement: e.nom, debut: `${date} ${heure}:00`, plage, statut: 'en_attente' };
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

/** Échange de points contre du crédit ou un forfait : les points sont débités tout de suite, l'équipe effectue la recharge */
router.post('/echanges', limiteur({ fenetreMs: 60 * 60 * 1000, max: 10 }), route(async (req, res) => {
    const offre = config.ECHANGES.find(o => o.code === req.body.offre);
    const telephone = normaliserTelephone(req.body.telephone);
    if (!offre) throw new ApiError(400, 'Choisissez une offre');
    if (!telephone || telephone.length < 8) throw new ApiError(400, 'Indiquez le numéro à recharger');

    const resultat = await transaction(async db => {
        const [[user]] = await db.query('SELECT id, points FROM users WHERE id = ? FOR UPDATE', [req.user.id]);
        if (user.points < offre.points) throw new ApiError(400, `Il vous manque ${offre.points - user.points} points pour cette offre`);
        const [[{ recents }]] = await db.query(
            "SELECT COUNT(*) AS recents FROM echanges WHERE user_id = ? AND statut <> 'refuse' AND created_at >= UTC_TIMESTAMP() - INTERVAL 30 DAY",
            [user.id]
        );
        if (recents >= config.ECHANGES_MAX_PAR_MOIS) {
            throw new ApiError(429, `Vous pouvez faire ${config.ECHANGES_MAX_PAR_MOIS} échanges par mois : réessayez plus tard`);
        }
        const libelle = `${offre.libelle} — ${offre.detail}`;
        await db.query('INSERT INTO echanges (user_id, offre, libelle, points, telephone) VALUES (?, ?, ?, ?, ?)', [user.id, offre.code, libelle, offre.points, telephone]);
        await crediterPoints(db, user.id, -offre.points, `Échange : ${libelle}`);
        await notifier(db, user.id, 'Échange demandé', `${libelle} pour le ${telephone}. L'équipe effectue la recharge sous 48 h.`);
        return { points: user.points - offre.points };
    });
    res.status(201).json({ message: 'Échange demandé : vous serez prévenu(e) quand la recharge est faite.', ...resultat });
}));

/** Un professionnel demande à gérer la fiche de son établissement ; l'équipe contrôle les justificatifs */
router.post('/revendications', limiteur({ fenetreMs: 60 * 60 * 1000, max: 10 }), route(async (req, res) => {
    const nom = texte(req.body.nom, 100);
    const fonction = texte(req.body.fonction, 100);
    const telephone = normaliserTelephone(req.body.telephone);
    const justificatif = texte(req.body.justificatif, 255);
    if (!nom || !fonction) throw new ApiError(400, 'Indiquez votre nom et votre fonction dans l\'établissement');
    if (!telephone || telephone.length < 8) throw new ApiError(400, 'Indiquez un numéro pour vous rappeler');
    if (!justificatif) throw new ApiError(400, 'Indiquez votre numéro d\'ordre, de licence ou d\'agrément');
    const piece = req.body.piece ? decoderPhoto(req.body.piece, config.PHOTO_MAX_OCTETS) : null;

    const [e] = await query("SELECT id, nom, revendique FROM etablissements WHERE id = ? AND statut = 'valide'", [Number(req.body.etablissement_id) || 0]);
    if (!e) throw new ApiError(404, 'Établissement introuvable');
    if (e.revendique) throw new ApiError(409, 'Cette fiche est déjà gérée par un professionnel');
    const [existe] = await query("SELECT id FROM revendications WHERE etablissement_id = ? AND user_id = ? AND statut = 'en_attente'", [e.id, req.user.id]);
    if (existe) throw new ApiError(409, 'Votre demande est déjà en cours de contrôle');

    await query(
        'INSERT INTO revendications (etablissement_id, user_id, nom, fonction, telephone, justificatif, piece_data, piece_mime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [e.id, req.user.id, nom, fonction, telephone, justificatif, piece?.data || null, piece?.mime || null]
    );
    await notifier({ query }, req.user.id, 'Demande de gestion reçue', `L'équipe contrôle vos justificatifs pour « ${e.nom} » et vous répond rapidement.`);
    res.status(201).json({ message: 'Demande envoyée : l\'équipe contrôle vos justificatifs avant de vous donner accès à la fiche.' });
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
