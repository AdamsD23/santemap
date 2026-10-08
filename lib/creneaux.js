/**
 * Créneaux de rendez-vous d'un établissement.
 *
 * Les horaires de consultation sont enregistrés par jour de la semaine (1 = lundi … 7 = dimanche) :
 *   { "1": ["08:00-12:00", "14:00-17:00"], "6": ["08:00-12:00"] }
 * Les heures sont celles du pays de l'établissement.
 */

const { ajouterJours, lireJson } = require('./util');

const PLAGE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

const minutes = hhmm => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const hhmm = total => `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;

/** Jour de la semaine d'une date AAAA-MM-JJ (1 = lundi … 7 = dimanche) */
function jourSemaine(date) {
    const j = new Date(`${date}T00:00:00Z`).getUTCDay();
    return j === 0 ? 7 : j;
}

/** Vérifie et normalise des horaires de consultation ; renvoie null s'ils sont invalides */
function validerHoraires(horaires) {
    if (!horaires || typeof horaires !== 'object' || Array.isArray(horaires)) return null;
    const propre = {};
    for (const [jour, plages] of Object.entries(horaires)) {
        if (!/^[1-7]$/.test(jour) || !Array.isArray(plages)) return null;
        const valides = [];
        for (const plage of plages) {
            const m = PLAGE.exec(String(plage));
            if (!m || minutes(plage.slice(0, 5)) >= minutes(plage.slice(6))) return null;
            valides.push(String(plage));
        }
        if (valides.length) propre[jour] = valides.sort();
    }
    return propre;
}

/**
 * Créneaux libres d'une journée
 * @param etab        établissement (rdv_horaires, rdv_duree)
 * @param date        'AAAA-MM-JJ'
 * @param pris        Set des créneaux déjà réservés, au format 'AAAA-MM-JJ HH:MM'
 * @param maintenant  { date, heure } dans le fuseau du pays
 * @param delaiMin    délai minimum avant un rendez-vous, en minutes
 */
function creneauxDuJour(etab, date, pris, maintenant, delaiMin) {
    const horaires = lireJson(etab.rdv_horaires, {});
    const plages = horaires[jourSemaine(date)] || [];
    const duree = etab.rdv_duree || 30;
    const limite = date === maintenant.date ? minutes(maintenant.heure) + delaiMin : -1;
    if (date < maintenant.date) return [];

    const libres = [];
    for (const plage of plages) {
        const debut = minutes(plage.slice(0, 5));
        const fin = minutes(plage.slice(6));
        for (let t = debut; t + duree <= fin; t += duree) {
            const heure = hhmm(t);
            if (t > limite && !pris.has(`${date} ${heure}`)) libres.push(heure);
        }
    }
    return libres;
}

/** Les prochains créneaux libres sur plusieurs jours (pour la fiche de l'établissement) */
function prochainsCreneaux(etab, pris, maintenant, delaiMin, jours, nombre = 3) {
    const resultat = [];
    for (let i = 0; i < jours && resultat.length < nombre; i++) {
        const date = ajouterJours(maintenant.date, i);
        for (const heure of creneauxDuJour(etab, date, pris, maintenant, delaiMin)) {
            resultat.push({ date, heure });
            if (resultat.length === nombre) break;
        }
    }
    return resultat;
}

module.exports = { validerHoraires, creneauxDuJour, prochainsCreneaux, jourSemaine };
