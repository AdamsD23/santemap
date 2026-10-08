/**
 * Authentification par jeton JWT. Le rôle et l'état du compte sont relus en base à chaque requête.
 */

const jwt = require('jsonwebtoken');
const config = require('../config');
const { query } = require('../db/mysql');

async function lireUtilisateur(req) {
    const entete = req.headers.authorization || '';
    if (!entete.startsWith('Bearer ')) return null;
    let payload;
    try {
        payload = jwt.verify(entete.slice(7), config.JWT_SECRET);
    } catch {
        return undefined;
    }
    const [user] = await query('SELECT id, nom, role, etablissement_id, actif FROM users WHERE id = ?', [payload.id]);
    return user && user.actif ? user : undefined;
}

/** Connexion obligatoire */
async function authentifier(req, res, next) {
    try {
        const user = await lireUtilisateur(req);
        if (!user) {
            return res.status(401).json({
                error: user === null ? 'Connectez-vous pour continuer' : 'Session expirée, reconnectez-vous',
                code: 'NON_CONNECTE'
            });
        }
        req.user = user;
        next();
    } catch (err) {
        next(err);
    }
}

/** Connexion facultative : req.user est rempli si un jeton valide est fourni */
async function authentifierSiPossible(req, res, next) {
    try {
        req.user = (await lireUtilisateur(req)) || null;
        next();
    } catch (err) {
        next(err);
    }
}

function exigerRole(...roles) {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Accès réservé', code: 'INTERDIT' });
        }
        next();
    };
}

function creerJeton(user) {
    return jwt.sign({ id: user.id }, config.JWT_SECRET, { expiresIn: config.JWT_EXPIRY });
}

module.exports = { authentifier, authentifierSiPossible, exigerRole, creerJeton };
