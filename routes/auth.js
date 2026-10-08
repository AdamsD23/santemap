/**
 * Inscription, connexion et profil
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db/mysql');
const { authentifier, creerJeton } = require('../middleware/auth');
const { ApiError, route, texte, normaliserTelephone, EMAIL } = require('../lib/util');
const { code } = require('../lib/services');

const router = express.Router();

function profil(user) {
    return {
        id: user.id,
        nom: user.nom,
        email: user.email,
        telephone: user.telephone,
        role: user.role,
        etablissement_id: user.etablissement_id,
        points: user.points,
        code_parrainage: user.code_parrainage
    };
}

router.post('/inscription', route(async (req, res) => {
    const nom = texte(req.body.nom, 100);
    const telephone = normaliserTelephone(req.body.telephone);
    const email = texte(req.body.email, 150)?.toLowerCase() || null;
    const motDePasse = String(req.body.mot_de_passe || '');
    const codeParrain = texte(req.body.code_parrainage, 12)?.toUpperCase() || null;

    if (!nom || nom.length < 2) throw new ApiError(400, 'Indiquez votre nom');
    if (!telephone || telephone.length < 8 || telephone.length > 15) throw new ApiError(400, 'Numéro de téléphone invalide');
    if (email && !EMAIL.test(email)) throw new ApiError(400, 'Adresse e-mail invalide');
    if (motDePasse.length < 8) throw new ApiError(400, 'Le mot de passe doit contenir au moins 8 caractères');

    const doublon = await query('SELECT telephone, email FROM users WHERE telephone = ? OR (email IS NOT NULL AND email = ?)', [telephone, email]);
    if (doublon.length) {
        throw new ApiError(409, doublon[0].telephone === telephone ? 'Ce numéro a déjà un compte' : 'Cette adresse e-mail a déjà un compte');
    }

    let parrainId = null;
    if (codeParrain) {
        const [parrain] = await query('SELECT id FROM users WHERE code_parrainage = ?', [codeParrain]);
        if (!parrain) throw new ApiError(400, 'Code de parrainage introuvable');
        parrainId = parrain.id;
    }

    const hash = await bcrypt.hash(motDePasse, 10);
    const res2 = await query(
        'INSERT INTO users (nom, telephone, email, mot_de_passe, code_parrainage, parrain_id) VALUES (?, ?, ?, ?, ?, ?)',
        [nom, telephone, email, hash, code(6), parrainId]
    );
    const [user] = await query('SELECT * FROM users WHERE id = ?', [res2.insertId]);
    res.status(201).json({ token: creerJeton(user), user: profil(user) });
}));

router.post('/connexion', route(async (req, res) => {
    const identifiant = texte(req.body.identifiant, 150) || '';
    const motDePasse = String(req.body.mot_de_passe || '');
    const telephone = normaliserTelephone(identifiant);

    const [user] = identifiant.includes('@')
        ? await query('SELECT * FROM users WHERE email = ?', [identifiant.toLowerCase()])
        : await query('SELECT * FROM users WHERE telephone = ?', [telephone]);

    if (!user || !(await bcrypt.compare(motDePasse, user.mot_de_passe))) {
        throw new ApiError(401, 'Identifiant ou mot de passe incorrect');
    }
    if (!user.actif) throw new ApiError(403, 'Ce compte est désactivé');
    res.json({ token: creerJeton(user), user: profil(user) });
}));

router.get('/moi', authentifier, route(async (req, res) => {
    const [user] = await query('SELECT * FROM users WHERE id = ?', [req.user.id]);
    res.json(profil(user));
}));

module.exports = router;
module.exports.profil = profil;
