/**
 * Outils communs : erreurs d'API, validation, téléphones, photos, dates locales, limitation de débit
 */

class ApiError extends Error {
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

/** Transmet les erreurs des routes asynchrones au gestionnaire d'erreurs */
const route = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Texte nettoyé (caractères de contrôle retirés), tronqué, ou null s'il est vide */
function texte(valeur, max = 255) {
    if (valeur === undefined || valeur === null) return null;
    const propre = String(valeur).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    return propre ? propre.slice(0, max) : null;
}

function nombre(valeur, { min = -Infinity, max = Infinity } = {}) {
    const n = Number(valeur);
    return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/** Garde uniquement les chiffres ; un numéro ivoirien saisi avec l'indicatif +225 est ramené à 10 chiffres */
function normaliserTelephone(valeur) {
    const chiffres = String(valeur || '').replace(/\D/g, '');
    if (chiffres.length === 13 && chiffres.startsWith('225')) return chiffres.slice(3);
    return chiffres || null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Décode une photo envoyée en data URL et vérifie qu'il s'agit vraiment d'une image JPEG, PNG ou WebP
 */
function decoderPhoto(dataUrl, maxOctets) {
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
    if (!m) throw new ApiError(400, 'Photo invalide : formats acceptés JPEG, PNG ou WebP');
    const data = Buffer.from(m[2], 'base64');
    if (data.length > maxOctets) throw new ApiError(400, 'Photo trop lourde (1,5 Mo maximum)');

    const estJpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    const estPng = data.subarray(0, 4).toString('hex') === '89504e47';
    const estWebp = data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP';
    const mime = estJpeg ? 'image/jpeg' : estPng ? 'image/png' : estWebp ? 'image/webp' : null;
    if (!mime) throw new ApiError(400, 'Le fichier envoyé n\'est pas une image');
    return { data, mime };
}

/** Date et heure actuelles dans le fuseau du pays : { date: '2026-10-08', heure: '14:05' } */
function maintenantLocal(fuseau) {
    const parts = new Intl.DateTimeFormat('sv-SE', {
        timeZone: fuseau, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).format(new Date());
    const [date, heure] = parts.split(' ');
    return { date, heure };
}

function ajouterJours(date, jours) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + jours);
    return d.toISOString().slice(0, 10);
}

/** Rectangle englobant un cercle (pré-filtre rapide avant le calcul exact de la distance) */
function boiteAutour(lat, lng, km) {
    const dLat = km / 111.32;
    const dLng = km / (111.32 * Math.max(Math.cos(lat * Math.PI / 180), 0.01));
    return { latMin: lat - dLat, latMax: lat + dLat, lngMin: lng - dLng, lngMax: lng + dLng };
}

/** Lit une colonne JSON stockée en texte */
function lireJson(valeur, defaut) {
    if (valeur === null || valeur === undefined || valeur === '') return defaut;
    if (typeof valeur !== 'string') return valeur;
    try { return JSON.parse(valeur); } catch { return defaut; }
}

/** Limitation du nombre de requêtes par adresse IP sur une fenêtre de temps */
function limiteur({ fenetreMs, max, message = 'Trop de requêtes, réessayez dans quelques minutes' }) {
    const compteurs = new Map();
    return (req, res, next) => {
        const maintenant = Date.now();
        const cle = req.ip;
        let entree = compteurs.get(cle);
        if (!entree || maintenant - entree.debut > fenetreMs) {
            entree = { debut: maintenant, nombre: 0 };
            compteurs.set(cle, entree);
        }
        entree.nombre++;
        if (compteurs.size > 10000) {
            for (const [k, v] of compteurs) if (maintenant - v.debut > fenetreMs) compteurs.delete(k);
        }
        if (entree.nombre > max) {
            res.setHeader('Retry-After', Math.ceil((entree.debut + fenetreMs - maintenant) / 1000));
            return res.status(429).json({ error: message, code: 'TROP_DE_REQUETES' });
        }
        next();
    };
}

module.exports = {
    ApiError, route, texte, nombre, normaliserTelephone, EMAIL, decoderPhoto,
    maintenantLocal, ajouterJours, boiteAutour, lireJson, limiteur
};
