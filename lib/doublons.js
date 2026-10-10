/**
 * Détection des doublons avant l'ajout d'un établissement :
 * noms proches (abréviations, accents et mots courants ignorés) à quelques centaines de mètres.
 */

const MOTS_VIDES = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'l', 'et', 'd', 'a', 'au', 'aux']);
const ABREVIATIONS = { ste: 'sainte', st: 'saint', dr: 'docteur', pharm: 'pharmacie', cab: 'cabinet', clin: 'clinique', hop: 'hopital' };

function mots(nom) {
    return String(nom || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .split(' ')
        .filter(m => m && !MOTS_VIDES.has(m))
        .map(m => ABREVIATIONS[m] || m);
}

/** Ressemblance entre deux noms, de 0 à 1 */
function similarite(a, b) {
    const ma = new Set(mots(a).filter(m => !GENERIQUES.has(m)));
    const mb = new Set(mots(b).filter(m => !GENERIQUES.has(m)));
    if (!ma.size || !mb.size) return 0;
    const communs = [...ma].filter(m => mb.has(m)).length;
    const jaccard = communs / new Set([...ma, ...mb]).size;
    // Un seul mot distinctif en commun ne suffit pas (« Adjamé » dans deux noms différents)
    if (Math.min(ma.size, mb.size) < 2) return jaccard;
    // Le plus court nom inclus dans le plus long (« Sainte Famille » dans « Ste Famille Cocody »)
    return communs / Math.min(ma.size, mb.size) * 0.7 + jaccard * 0.3;
}

// Mots qui désignent le type d'établissement : ils ne suffisent pas à reconnaître un doublon
const GENERIQUES = new Set(['pharmacie', 'clinique', 'cabinet', 'hopital', 'centre', 'laboratoire', 'medical', 'sante', 'dentaire', 'polyclinique', 'docteur', 'spa']);

const SEUIL = 0.75;

module.exports = { similarite, mots, SEUIL };
