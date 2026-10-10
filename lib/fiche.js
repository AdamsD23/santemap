/**
 * Champs structurés de la fiche d'un établissement (horaires par service, tarifs, assurances),
 * validés de la même façon par l'administration et par l'espace établissement.
 */

const { ApiError, texte, nombre } = require('./util');

/**
 * Retourne les colonnes à mettre à jour d'après le corps de la requête
 *  - horaires_detail : [{ libelle: 'Service des Urgences', horaires: '24h / 24 • 7j / 7' }]
 *  - tarifs          : [{ libelle: 'Consultation Médecine Générale', detail: 'Heures de jour', prix: 15000 }]
 *  - assurances      : texte libre
 */
function champsFiche(b) {
    const champs = {};
    if ('horaires_detail' in b) {
        if (!Array.isArray(b.horaires_detail) || b.horaires_detail.length > 10) throw new ApiError(400, 'Horaires par service invalides');
        champs.horaires_detail = JSON.stringify(b.horaires_detail.map(h => ({ libelle: texte(h?.libelle, 80), horaires: texte(h?.horaires, 60) })).filter(h => h.libelle && h.horaires));
    }
    if ('tarifs' in b) {
        if (!Array.isArray(b.tarifs) || b.tarifs.length > 15) throw new ApiError(400, 'Liste de tarifs invalide');
        champs.tarifs = JSON.stringify(b.tarifs.map(t => ({
            libelle: texte(t?.libelle, 100),
            detail: texte(t?.detail, 100),
            prix: nombre(t?.prix, { min: 0, max: 10_000_000 })
        })).filter(t => t.libelle && t.prix !== null));
    }
    if ('assurances' in b) champs.assurances = texte(b.assurances, 255);
    return champs;
}

module.exports = { champsFiche };
