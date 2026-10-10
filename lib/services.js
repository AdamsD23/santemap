/**
 * Règles métier partagées : notifications, points des contributeurs, codes et références
 */

const crypto = require('crypto');
const config = require('../config');
const { PAYS } = require('./pays');
const { maintenantLocal, ajouterJours } = require('./util');
const { query } = require('../db/mysql');
const { envoyerNotification } = require('./mail');

// Sans caractères ambigus (0/O, 1/I…) pour être recopiés facilement
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function code(longueur) {
    const octets = crypto.randomBytes(longueur);
    return Array.from(octets, o => ALPHABET[o % ALPHABET.length]).join('');
}

async function notifier(db, userId, titre, message) {
    await db.query('INSERT INTO notifications (user_id, titre, message) VALUES (?, ?, ?)', [userId, titre, message]);
    // Copie par e-mail pour les comptes qui en ont un, sans attendre l'envoi ni bloquer l'action en cours
    query('SELECT email FROM users WHERE id = ?', [userId])
        .then(([u]) => u?.email && envoyerNotification(u.email, titre, message))
        .catch(err => console.error(`E-mail non envoyé : ${err.message}`));
}

async function crediterPoints(db, userId, points, raison, etablissementId = null) {
    await db.query('UPDATE users SET points = points + ? WHERE id = ?', [points, userId]);
    await db.query(
        'INSERT INTO points_historique (user_id, points, raison, etablissement_id) VALUES (?, ?, ?, ?)',
        [userId, points, raison, etablissementId]
    );
}

/** Palier actuel et prochain palier à atteindre */
function palier(points) {
    const atteints = config.PALIERS.filter(p => points >= p.seuil);
    const suivant = config.PALIERS.find(p => points < p.seuil) || null;
    return { actuel: atteints.at(-1) || null, suivant };
}

/**
 * Valide une contribution : l'établissement apparaît sur la carte et le contributeur gagne ses points.
 * Le parrain du contributeur reçoit un bonus à la première contribution validée de son filleul.
 * À appeler dans une transaction (db = connexion).
 */
async function validerContribution(db, etab, adminId) {
    await db.query(
        "UPDATE etablissements SET statut = 'valide', motif_refus = NULL, valide_par = ?, valide_le = UTC_TIMESTAMP() WHERE id = ?",
        [adminId, etab.id]
    );
    // Pharmacie déclarée de garde par son contributeur : la garde court sur la semaine à venir
    if (etab.garde_declaree && etab.categorie === 'pharmacie') {
        const aujourdhui = maintenantLocal(PAYS[etab.pays || config.PAYS_DEFAUT].fuseau).date;
        await db.query('INSERT INTO gardes (etablissement_id, debut, fin) VALUES (?, ?, ?)', [etab.id, aujourdhui, ajouterJours(aujourdhui, 6)]);
    }
    if (!etab.contributeur_id) return { points: 0 };

    const [[{ photos }]] = await db.query('SELECT COUNT(*) AS photos FROM photos WHERE etablissement_id = ?', [etab.id]);
    let points = config.POINTS.CONTRIBUTION;
    await crediterPoints(db, etab.contributeur_id, config.POINTS.CONTRIBUTION, `Établissement ajouté : ${etab.nom}`, etab.id);
    if (photos > 0) {
        points += config.POINTS.PHOTO;
        await crediterPoints(db, etab.contributeur_id, config.POINTS.PHOTO, `Photo de ${etab.nom}`, etab.id);
    }
    await notifier(db, etab.contributeur_id, 'Contribution validée',
        `« ${etab.nom} » est maintenant visible sur la carte. Vous gagnez ${points} points, merci !`);

    const [[contributeur]] = await db.query('SELECT nom, parrain_id FROM users WHERE id = ?', [etab.contributeur_id]);
    if (contributeur?.parrain_id) {
        const [[{ validees }]] = await db.query(
            "SELECT COUNT(*) AS validees FROM etablissements WHERE contributeur_id = ? AND statut = 'valide'",
            [etab.contributeur_id]
        );
        if (validees === 1) {
            await crediterPoints(db, contributeur.parrain_id, config.POINTS.PARRAINAGE, `Parrainage : première contribution de ${contributeur.nom}`);
            await notifier(db, contributeur.parrain_id, 'Bonus de parrainage',
                `${contributeur.nom}, que vous avez parrainé(e), a fait sa première contribution. Vous gagnez ${config.POINTS.PARRAINAGE} points.`);
        }
    }
    return { points };
}

module.exports = { code, notifier, crediterPoints, palier, validerContribution };
