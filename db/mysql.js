/**
 * Connexion MySQL et création des tables de SantéMap
 */

const mysql = require('mysql2/promise');
const config = require('../config');

let pool;

function options(avecBase = true) {
    return {
        host: config.DB_HOST,
        user: config.DB_USER,
        password: config.DB_PASSWORD,
        port: config.DB_PORT,
        ...(avecBase && { database: config.DB_NAME }),
        ...(config.DB_SSL && { ssl: config.DB_SSL_CA ? { ca: config.DB_SSL_CA } : { rejectUnauthorized: true } }),
        waitForConnections: true,
        connectionLimit: 10,
        dateStrings: true,
        decimalNumbers: true,
        timezone: 'Z',
        charset: 'utf8mb4'
    };
}

async function initDB() {
    try {
        const connexion = await mysql.createConnection(options(false));
        await connexion.query(`CREATE DATABASE IF NOT EXISTS \`${config.DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        await connexion.end();
    } catch (err) {
        // Chez certains hébergeurs, la base existe déjà et le compte ne peut pas en créer
        console.warn(`Création de la base ignorée : ${err.message}`);
    }
    pool = mysql.createPool(options(true));
    await pool.query('SELECT 1');
    return pool;
}

async function getPool() {
    if (!pool) await initDB();
    return pool;
}

async function query(sql, params = []) {
    const p = await getPool();
    const [lignes] = await p.query(sql, params);
    return lignes;
}

async function transaction(fn) {
    const p = await getPool();
    const connexion = await p.getConnection();
    try {
        await connexion.beginTransaction();
        const resultat = await fn(connexion);
        await connexion.commit();
        return resultat;
    } catch (err) {
        await connexion.rollback();
        throw err;
    } finally {
        connexion.release();
    }
}

const TABLES = [
    `CREATE TABLE IF NOT EXISTS etablissements (
        id INT AUTO_INCREMENT PRIMARY KEY,
        pays CHAR(2) NOT NULL DEFAULT 'CI',
        categorie VARCHAR(20) NOT NULL,
        nom VARCHAR(200) NOT NULL,
        lat DECIMAL(9,6) NOT NULL,
        lng DECIMAL(9,6) NOT NULL,
        adresse VARCHAR(255) NULL,
        commune VARCHAR(100) NULL,
        telephone VARCHAR(60) NULL,
        site_web VARCHAR(255) NULL,
        horaires VARCHAR(255) NULL,
        ouvert_24h BOOLEAN NOT NULL DEFAULT FALSE,
        urgences BOOLEAN NOT NULL DEFAULT FALSE,
        description TEXT NULL,
        statut ENUM('en_attente','valide','refuse') NOT NULL DEFAULT 'valide',
        motif_refus VARCHAR(255) NULL,
        source ENUM('osm','contribution','admin','demo') NOT NULL DEFAULT 'admin',
        osm_id VARCHAR(30) NULL UNIQUE,
        contributeur_id INT NULL,
        valide_par INT NULL,
        valide_le DATETIME NULL,
        verifie BOOLEAN NOT NULL DEFAULT FALSE,
        premium BOOLEAN NOT NULL DEFAULT FALSE,
        services TEXT NULL,
        prix_consultation INT NULL,
        rdv_actif BOOLEAN NOT NULL DEFAULT FALSE,
        rdv_duree SMALLINT NOT NULL DEFAULT 30,
        rdv_horaires TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_position (pays, statut, lat, lng),
        INDEX idx_contributeur (contributeur_id, statut)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nom VARCHAR(100) NOT NULL,
        telephone VARCHAR(20) NULL UNIQUE,
        email VARCHAR(150) NULL UNIQUE,
        mot_de_passe VARCHAR(255) NOT NULL,
        role ENUM('utilisateur','etablissement','admin') NOT NULL DEFAULT 'utilisateur',
        etablissement_id INT NULL,
        points INT NOT NULL DEFAULT 0,
        code_parrainage VARCHAR(12) NOT NULL UNIQUE,
        parrain_id INT NULL,
        actif BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (etablissement_id) REFERENCES etablissements(id) ON DELETE SET NULL,
        FOREIGN KEY (parrain_id) REFERENCES users(id) ON DELETE SET NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS photos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        etablissement_id INT NOT NULL,
        data MEDIUMBLOB NOT NULL,
        mime VARCHAR(30) NOT NULL,
        ajoute_par INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_etablissement (etablissement_id),
        FOREIGN KEY (etablissement_id) REFERENCES etablissements(id) ON DELETE CASCADE,
        FOREIGN KEY (ajoute_par) REFERENCES users(id) ON DELETE SET NULL
    )`,

    `CREATE TABLE IF NOT EXISTS gardes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        etablissement_id INT NOT NULL,
        debut DATE NOT NULL,
        fin DATE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_periode (debut, fin),
        FOREIGN KEY (etablissement_id) REFERENCES etablissements(id) ON DELETE CASCADE
    )`,

    `CREATE TABLE IF NOT EXISTS rendez_vous (
        id INT AUTO_INCREMENT PRIMARY KEY,
        reference VARCHAR(12) NOT NULL UNIQUE,
        etablissement_id INT NOT NULL,
        user_id INT NOT NULL,
        debut DATETIME NOT NULL,
        motif VARCHAR(255) NULL,
        telephone VARCHAR(20) NOT NULL,
        statut ENUM('en_attente','confirme','annule','termine') NOT NULL DEFAULT 'en_attente',
        annule_par ENUM('patient','etablissement') NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_creneau (etablissement_id, debut),
        FOREIGN KEY (etablissement_id) REFERENCES etablissements(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS points_historique (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        points INT NOT NULL,
        raison VARCHAR(150) NOT NULL,
        etablissement_id INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user (user_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (etablissement_id) REFERENCES etablissements(id) ON DELETE SET NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS notifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        titre VARCHAR(150) NOT NULL,
        message VARCHAR(500) NOT NULL,
        lu BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user (user_id, lu),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS signalements (
        id INT AUTO_INCREMENT PRIMARY KEY,
        etablissement_id INT NOT NULL,
        user_id INT NULL,
        motif ENUM('ferme','mauvaise_position','mauvaises_infos','doublon','autre') NOT NULL,
        message VARCHAR(500) NULL,
        statut ENUM('nouveau','traite') NOT NULL DEFAULT 'nouveau',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_statut (statut),
        FOREIGN KEY (etablissement_id) REFERENCES etablissements(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
];

async function initTables() {
    for (const sql of TABLES) await query(sql);
}

/** Supprime toutes les tables (utilisé uniquement par les tests) */
async function supprimerTables() {
    await query('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of ['signalements', 'notifications', 'points_historique', 'rendez_vous', 'gardes', 'photos', 'users', 'etablissements']) {
        await query(`DROP TABLE IF EXISTS ${table}`);
    }
    await query('SET FOREIGN_KEY_CHECKS = 1');
}

async function closePool() {
    if (pool) {
        await pool.end();
        pool = undefined;
    }
}

module.exports = { initDB, getPool, query, transaction, initTables, supprimerTables, closePool };
