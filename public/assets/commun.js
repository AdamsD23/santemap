/* SantéMap — outils communs à l'application et à l'administration */
'use strict';

const SM = (() => {
    const CLE_JETON = 'santemap.jeton';
    const CLE_USER = 'santemap.user';

    // Le stockage local peut être indisponible (navigation privée) : l'application fonctionne quand même
    function lire(cle) {
        try { return localStorage.getItem(cle); } catch { return null; }
    }
    function ecrire(cle, valeur) {
        try {
            if (valeur === null) localStorage.removeItem(cle);
            else localStorage.setItem(cle, valeur);
        } catch { /* stockage indisponible */ }
    }

    const session = {
        jeton: () => lire(CLE_JETON),
        user() {
            try { return JSON.parse(lire(CLE_USER) || 'null'); } catch { return null; }
        },
        enregistrer(jeton, user) {
            ecrire(CLE_JETON, jeton);
            ecrire(CLE_USER, JSON.stringify(user));
        },
        majUser(user) { ecrire(CLE_USER, JSON.stringify(user)); },
        fermer() {
            ecrire(CLE_JETON, null);
            ecrire(CLE_USER, null);
        }
    };

    async function api(chemin, { methode = 'GET', corps } = {}) {
        const jeton = session.jeton();
        const res = await fetch('/api' + chemin, {
            method: methode,
            headers: {
                ...(corps !== undefined && { 'Content-Type': 'application/json' }),
                ...(jeton && { Authorization: `Bearer ${jeton}` })
            },
            body: corps !== undefined ? JSON.stringify(corps) : undefined
        });
        let donnees = null;
        try { donnees = await res.json(); } catch { /* réponse vide */ }
        if (res.status === 401 && jeton) {
            session.fermer();
            document.dispatchEvent(new CustomEvent('sm:deconnexion'));
        }
        if (!res.ok) {
            const err = new Error(donnees?.error || 'Connexion impossible, vérifiez votre réseau');
            err.status = res.status;
            throw err;
        }
        return donnees;
    }

    const esc = valeur => String(valeur ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const ic = (nom, classe = '') => `<span class="ms ${classe}" aria-hidden="true">${nom}</span>`;

    let minuteur;
    function toast(message, erreur = false) {
        const el = document.getElementById('toast');
        if (!el) return;
        el.textContent = message;
        el.classList.toggle('erreur-toast', erreur);
        el.classList.add('visible');
        clearTimeout(minuteur);
        minuteur = setTimeout(() => el.classList.remove('visible'), erreur ? 4500 : 3000);
    }

    function distance(m) {
        if (m === null || m === undefined) return '';
        return m < 1000 ? `${Math.round(m / 10) * 10 || 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} km`;
    }

    /** Distance en mètres entre deux points (formule de haversine) */
    function haversine(a, b) {
        const r = Math.PI / 180;
        const dLat = (b.lat - a.lat) * r;
        const dLng = (b.lng - a.lng) * r;
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
        return 2 * 6371000 * Math.asin(Math.sqrt(h));
    }

    const JOURS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
    const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

    function dateLocale(date = new Date()) {
        const p = n => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
    }
    function ajouterJours(iso, n) {
        const d = new Date(`${iso}T12:00:00`);
        d.setDate(d.getDate() + n);
        return dateLocale(d);
    }
    /** « Aujourd'hui », « Demain » ou « lun. 12 oct. » */
    function jourLisible(iso) {
        const aujourdhui = dateLocale();
        if (iso === aujourdhui) return 'Aujourd\'hui';
        if (iso === ajouterJours(aujourdhui, 1)) return 'Demain';
        const d = new Date(`${iso}T12:00:00`);
        return `${JOURS[d.getDay()]} ${d.getDate()} ${MOIS[d.getMonth()]}`;
    }
    function dateHeure(sql) {
        const [date, heure] = String(sql).split(' ');
        return `${jourLisible(date)} à ${(heure || '').slice(0, 5)}`;
    }

    /** Pour les boutons de jour : { titre: 'Demain', sous: '19 avr.' } */
    function jourCourt(iso) {
        const d = new Date(`${iso}T12:00:00`);
        const aujourdhui = dateLocale();
        const titre = iso === aujourdhui ? 'Aujourd\'hui' : iso === ajouterJours(aujourdhui, 1) ? 'Demain' : { 0: 'Dimanche', 1: 'Lundi', 2: 'Mardi', 3: 'Mercredi', 4: 'Jeudi', 5: 'Vendredi', 6: 'Samedi' }[d.getDay()];
        return { titre, sous: `${d.getDate()} ${MOIS[d.getMonth()]}` };
    }

    const initiales = nom => String(nom || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(m => m[0].toUpperCase()).join('');
    const fcfa = n => `${Number(n).toLocaleString('fr-FR').replace(/ | /g, ' ')} FCFA`;

    /** Fenêtre de dialogue ; renvoie l'élément et une fonction pour la fermer */
    function dialogue(html) {
        const el = document.createElement('div');
        el.className = 'dialogue';
        el.innerHTML = `<div class="dialogue-boite" role="dialog" aria-modal="true">${html}</div>`;
        const fermer = () => el.remove();
        el.addEventListener('click', e => { if (e.target === el || e.target.closest('[data-fermer]')) fermer(); });
        document.body.appendChild(el);
        el.querySelector('input, select, textarea, button')?.focus();
        return { el, fermer };
    }

    const STATUTS = {
        en_attente: 'En attente', valide: 'Validée', refuse: 'Refusée',
        confirme: 'Confirmé', annule: 'Annulé', termine: 'Terminé', absent: 'Absence constatée'
    };
    // Une demande de rendez-vous n'est jamais présentée comme une réservation tant que l'établissement n'a pas confirmé
    const STATUTS_RDV = {
        en_attente: 'Demandée, en attente de réponse', confirme: 'Confirmée', refuse: 'Refusée',
        annule: 'Annulée', termine: 'Terminée', absent: 'Absence constatée'
    };
    const PLAGES = { matin: 'Matin', midi: 'Midi', apres_midi: 'Après-midi' };

    return { session, api, esc, ic, toast, distance, haversine, dateLocale, ajouterJours, jourLisible, jourCourt, dateHeure, initiales, fcfa, dialogue, STATUTS, STATUTS_RDV, PLAGES };
})();
