/**
 * Espace établissement partenaire : ses rendez-vous en ligne
 */

const express = require('express');
const { query } = require('../db/mysql');
const { changerStatutRdv } = require('./admin');
const { ApiError, route, texte } = require('../lib/util');
const { champsFiche } = require('../lib/fiche');

const router = express.Router();

// Un compte établissement n'agit que sur l'établissement qui lui est rattaché
router.use((req, res, next) => {
    if (!req.user.etablissement_id) return next(new ApiError(403, 'Aucun établissement n\'est rattaché à ce compte'));
    next();
});

router.get('/', route(async (req, res) => {
    const [etab] = await query('SELECT id, nom, categorie, commune, rdv_actif, rdv_duree FROM etablissements WHERE id = ?', [req.user.etablissement_id]);
    if (!etab) throw new ApiError(404, 'Aucun établissement n\'est rattaché à ce compte');
    const rendezVous = await query(
        `SELECT r.id, r.reference, r.debut, r.plage, r.canal, r.service, r.motif, r.telephone, r.statut, COALESCE(r.nom_patient, u.nom) AS patient
         FROM rendez_vous r JOIN users u ON u.id = r.user_id
         WHERE r.etablissement_id = ? AND r.debut >= UTC_DATE() - INTERVAL 7 DAY
         ORDER BY r.debut LIMIT 200`,
        [etab.id]
    );
    res.json({ etablissement: etab, rendez_vous: rendezVous });
}));

router.patch('/rendez-vous/:id', route(async (req, res) => {
    res.json(await changerStatutRdv(Number(req.params.id) || 0, req.body.statut, req.user.etablissement_id, req.body.message));
}));

/** Informations qu'un établissement vérifié peut modifier lui-même (le nom, la catégorie et la position restent à l'équipe) */
const TEXTES_PRO = { telephone: 60, site_web: 255, horaires: 255, description: 2000, adresse: 255, quartier: 100 };

router.get('/fiche', route(async (req, res) => {
    const [e] = await query(
        `SELECT id, nom, telephone, site_web, horaires, description, adresse, quartier, premium, assurances, horaires_detail, tarifs
         FROM etablissements WHERE id = ?`, [req.user.etablissement_id]);
    if (!e) throw new ApiError(404, 'Aucun établissement n\'est rattaché à ce compte');
    res.json(e);
}));

router.patch('/fiche', route(async (req, res) => {
    const champs = {};
    for (const [cle, max] of Object.entries(TEXTES_PRO)) if (cle in req.body) champs[cle] = texte(req.body[cle], max);
    Object.assign(champs, champsFiche(req.body));
    if (!Object.keys(champs).length) throw new ApiError(400, 'Aucune modification');
    // Les prestations payantes (tarifs, assurances) ne s'affichent que sur les fiches partenaires
    await query(`UPDATE etablissements SET ${Object.keys(champs).map(c => `${c} = ?`).join(', ')} WHERE id = ?`, [...Object.values(champs), req.user.etablissement_id]);
    res.json({ message: 'Fiche mise à jour' });
}));

module.exports = router;
