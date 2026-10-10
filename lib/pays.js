/**
 * Pays couverts. Pour en ajouter un : importer ses établissements
 * (node scripts/import-osm.js BJ) puis compléter cette liste.
 */

const PAYS = {
    CI: {
        code: 'CI',
        nom: 'Côte d\'Ivoire',
        ville: 'Abidjan',
        centre: { lat: 5.3364, lng: -4.0267 },
        zoom: 14,
        fuseau: 'Africa/Abidjan',
        indicatif: '+225',
        // Communes proposées à la saisie d'un établissement (la saisie reste libre pour les autres villes)
        communes: ['Abobo', 'Adjamé', 'Anyama', 'Attécoubé', 'Bingerville', 'Cocody', 'Koumassi', 'Marcory', 'Plateau', 'Port-Bouët', 'Songon', 'Treichville', 'Yopougon'],
        urgences: [
            { numero: '185', libelle: 'SAMU', description: 'Urgences médicales' },
            { numero: '180', libelle: 'Sapeurs-pompiers (GSPM)', description: 'Accidents, incendies, secours' },
            { numero: '170', libelle: 'Police secours', description: 'Agression, danger immédiat' },
            { numero: '111', libelle: 'Police', description: 'Police nationale' }
        ]
    }
};

module.exports = { PAYS };
