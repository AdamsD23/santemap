/**
 * Espace établissement partenaire : ses rendez-vous en ligne
 */

const express = require('express');
const { query } = require('../db/mysql');
const { changerStatutRdv } = require('./admin');
const { ApiError, route } = require('../lib/util');

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
        `SELECT r.id, r.reference, r.debut, r.motif, r.telephone, r.statut, u.nom AS patient
         FROM rendez_vous r JOIN users u ON u.id = r.user_id
         WHERE r.etablissement_id = ? AND r.debut >= UTC_DATE() - INTERVAL 7 DAY
         ORDER BY r.debut LIMIT 200`,
        [etab.id]
    );
    res.json({ etablissement: etab, rendez_vous: rendezVous });
}));

router.patch('/rendez-vous/:id', route(async (req, res) => {
    res.json(await changerStatutRdv(Number(req.params.id) || 0, req.body.statut, req.user.etablissement_id));
}));

module.exports = router;
