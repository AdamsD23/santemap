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

    // E-mails de notification (rendez-vous, contributions, échanges). Sans SMTP_HOST, aucun e-mail n'est envoyé.
    SMTP_HOST: process.env.SMTP_HOST || '',
    SMTP_PORT: Number(process.env.SMTP_PORT || 587),
    SMTP_USER: process.env.SMTP_USER || '',
    SMTP_PASSWORD: process.env.SMTP_PASSWORD || '',
    MAIL_FROM: process.env.MAIL_FROM || 'SantéMap <no-reply@santemap.ci>',

    PAYS_DEFAUT: (process.env.PAYS_DEFAUT || 'CI').toUpperCase(),

    // Points gagnés par les contributeurs : 50 pour un établissement validé (nom 20 + position 30,
    // détail affiché à l'écran), 50 de plus avec la photo de la devanture ou de la plaque
    POINTS: {
        CONTRIBUTION: 50,
        PHOTO: 50,
        PARRAINAGE: 50
    },
    // Niveaux des contributeurs
    PALIERS: [
        { seuil: 0, nom: 'Éclaireur', niveau: 1 },
        { seuil: 150, nom: 'Relais', niveau: 2 },
        { seuil: 300, nom: 'Veilleur', niveau: 3 },
        { seuil: 600, nom: 'Sentinelle', niveau: 4 }
    ],
    // Offres d'échange des points : 1 point vaut 5 FCFA de crédit. L'équipe effectue la recharge
    // après la demande ; les montants et plafonds sont à confirmer avant le lancement public.
    ECHANGES: [
        { code: 'orange', libelle: 'Orange CI', detail: '1 000 FCFA de crédit', points: 200 },
        { code: 'mtn', libelle: 'MTN CI', detail: '1 500 FCFA de crédit', points: 300 },
        { code: 'moov', libelle: 'Moov Africa', detail: '2 000 FCFA de crédit', points: 400 },
        { code: 'internet', libelle: 'Pass 10 Go', detail: 'Forfait Internet', points: 450 }
    ],
    // Demandes d'échange par heure et par adresse IP (anti-abus)
    LIMITE_ECHANGES_HEURE: Number(process.env.LIMITE_ECHANGES_HEURE || 10),
    // Valeur d'un point en FCFA de crédit
    FCFA_PAR_POINT: 5,
    // Plafond d'échanges par membre sur 30 jours (anti-fraude)
    ECHANGES_MAX_PAR_MOIS: 3,
    // Budget total de récompenses par mois civil, en FCFA, pour tous les membres (0 = sans limite).
    // Une fois atteint, les échanges sont bloqués jusqu'au mois suivant.
    ECHANGES_BUDGET_MOIS: Number(process.env.ECHANGES_BUDGET_MOIS ?? 100000),

    RAYON_MAX_KM: 50,
    RESULTATS_MAX: 300,
    PHOTO_MAX_OCTETS: 1.5 * 1024 * 1024,
    CONTRIBUTIONS_EN_ATTENTE_MAX: 30,
    // Délai minimum avant un rendez-vous, en minutes
    RDV_DELAI_MIN: 30,
    RDV_JOURS: 14
};
