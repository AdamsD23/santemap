/**
 * Catégories d'établissements : libellé, icône (Material Symbols) et couleur du marqueur
 */

const CATEGORIES = [
    { code: 'pharmacie', libelle: 'Pharmacie', pluriel: 'Pharmacies', icone: 'local_pharmacy', couleur: '#0f7b53' },
    { code: 'hopital', libelle: 'Hôpital', pluriel: 'Hôpitaux', icone: 'local_hospital', couleur: '#a3262a' },
    { code: 'clinique', libelle: 'Clinique', pluriel: 'Cliniques', icone: 'medical_services', couleur: '#0b4f5c' },
    { code: 'medecin', libelle: 'Médecin & centre de santé', pluriel: 'Médecins & centres de santé', icone: 'stethoscope', couleur: '#13697a' },
    { code: 'laboratoire', libelle: 'Laboratoire d\'analyses', pluriel: 'Laboratoires', icone: 'biotech', couleur: '#6a4c93' },
    { code: 'imagerie', libelle: 'Imagerie médicale', pluriel: 'Imagerie médicale', icone: 'radiology', couleur: '#2f5d8a' },
    { code: 'dentiste', libelle: 'Cabinet dentaire', pluriel: 'Dentistes', icone: 'dentistry', couleur: '#1d7c8c' },
    { code: 'kine', libelle: 'Kinésithérapie', pluriel: 'Kinésithérapie', icone: 'accessibility_new', couleur: '#2d6a4f' },
    { code: 'bien_etre', libelle: 'Spa & massage', pluriel: 'Spa & massage', icone: 'spa', couleur: '#9c5b72' }
];

const CODES = CATEGORIES.map(c => c.code);

/**
 * Déduit la catégorie à partir des étiquettes OpenStreetMap.
 * Le nom sert à affiner les cliniques et centres (laboratoires, imagerie, dentistes souvent mal étiquetés).
 */
function categorieDepuisOsm(tags) {
    const amenity = tags.amenity || '';
    const healthcare = tags.healthcare || '';
    const nom = tags.name || '';

    if (amenity === 'pharmacy' || healthcare === 'pharmacy') return 'pharmacie';
    if (tags.leisure === 'spa' || tags.shop === 'massage') return 'bien_etre';
    if (healthcare === 'laboratory') return 'laboratoire';
    if (healthcare === 'radiology') return 'imagerie';
    if (healthcare === 'physiotherapist') return 'kine';
    if (amenity.split(';')[0] === 'dentist' || healthcare === 'dentist') return 'dentiste';

    let categorie = null;
    if (amenity.startsWith('hospital') || healthcare === 'hospital') categorie = 'hopital';
    else if (amenity === 'clinic' || healthcare === 'clinic' || healthcare === 'centre') categorie = 'clinique';
    else if (amenity === 'doctors' || healthcare === 'doctor') categorie = 'medecin';
    if (!categorie) return null;

    if (categorie !== 'hopital') {
        if (/laboratoire|\blabo\b|analyses? m[ée]dicales/i.test(nom)) return 'laboratoire';
        if (/imagerie|radiolog|scanner|[ée]chograph/i.test(nom)) return 'imagerie';
        if (/dentaire|dentiste|stomatolog/i.test(nom)) return 'dentiste';
        if (/kin[ée]si|physioth[ée]rap/i.test(nom)) return 'kine';
    }
    return categorie;
}

module.exports = { CATEGORIES, CODES, categorieDepuisOsm };
