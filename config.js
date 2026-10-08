/**
 * Configuration de SantéMap (variables d'environnement, avec valeurs par défaut pour le développement)
 */

require('dotenv').config();

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';
const bool = (value, fallback = false) =>
    value === undefined ? fallback : ['1', 'true', 'yes', 'oui'].includes(String(value).toLowerCase());

if (IS_PRODUCTION && !process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET doit être défini en production (variable d\'environnement).');
}

module.exports = {
    PORT: process.env.PORT || 3000,
    NODE_ENV,
    IS_PRODUCTION,

    JWT_SECRET: process.env.JWT_SECRET || 'dev-secret-a-changer',
    // Sur téléphone, on reste connecté longtemps
    JWT_EXPIRY: '30d',

    DB_HOST: process.env.DB_HOST || 'localhost',
    DB_USER: process.env.DB_USER || 'root',
    DB_PASSWORD: process.env.DB_PASSWORD || '',
    DB_NAME: process.env.DB_NAME || 'santemap',
    DB_PORT: Number(process.env.DB_PORT || 3306),
    DB_SSL: bool(process.env.DB_SSL),
    DB_SSL_CA: process.env.DB_SSL_CA ? process.env.DB_SSL_CA.replace(/\\n/g, '\n') : undefined,

    // Compte administrateur créé au premier démarrage
    ADMIN_EMAIL: process.env.ADMIN_EMAIL || 'admin@santemap.ci',
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin12345',

    // Import des établissements OpenStreetMap (data/osm-<pays>.json) au premier démarrage
    IMPORT_OSM: bool(process.env.IMPORT_OSM, true),
    // Comptes et établissement de démonstration
    SEED_DEMO: bool(process.env.SEED_DEMO, !IS_PRODUCTION),

    PAYS_DEFAUT: (process.env.PAYS_DEFAUT || 'CI').toUpperCase(),

    // Points gagnés par les contributeurs
    POINTS: {
        CONTRIBUTION: 10,
        PHOTO: 5,
        PARRAINAGE: 20
    },
    // Paliers de récompense (les cadeaux sont définis par l'équipe)
    PALIERS: [
        { seuil: 50, nom: 'Bronze' },
        { seuil: 150, nom: 'Argent' },
        { seuil: 300, nom: 'Or' }
    ],

    RAYON_MAX_KM: 50,
    RESULTATS_MAX: 300,
    PHOTO_MAX_OCTETS: 1.5 * 1024 * 1024,
    CONTRIBUTIONS_EN_ATTENTE_MAX: 30,
    // Délai minimum avant un rendez-vous, en minutes
    RDV_DELAI_MIN: 30,
    RDV_JOURS: 14
};
