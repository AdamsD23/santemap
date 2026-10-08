/* SantéMap — application : carte, liste, fiche, rendez-vous, urgences, compte et contribution */
'use strict';

(() => {
    const { session, api, esc, ic, toast, distance, haversine, jourLisible, dateHeure, initiales, fcfa, dialogue, STATUTS, dateLocale, ajouterJours } = SM;

    const RAYONS = [1, 2, 5, 10, 20];
    const LIBELLES_COURTS = { medecin: 'Médecin', laboratoire: 'Laboratoire', imagerie: 'Imagerie', dentiste: 'Dentiste', kine: 'Kiné', bien_etre: 'Spa & massage' };
    const ORDRE_CHIPS = ['tous', 'pharmacie', 'garde', 'hopital', 'clinique', 'medecin', 'laboratoire', 'imagerie', 'dentiste', 'kine', 'bien_etre'];
    const VUES_PLEIN_ECRAN = ['urgences', 'compte', 'fiche', 'ajouter', 'notifications'];

    const etat = {
        meta: null,
        categories: {},
        position: null,
        centre: null,
        rayon: 5,
        categorie: 'tous',
        recherche: '',
        options: { h24: false, urgences: false, rdv: false },
        resultats: [],
        compteurs: {},
        selection: null,
        detail: null,
        creneauChoisi: null,
        autoSelection: true,
        apresConnexion: null,
        listeMax: 40
    };

    const $ = sel => document.querySelector(sel);
    const vueEl = $('#vue');
    const estMobile = () => window.matchMedia('(max-width: 1023px)').matches;
    let carte, couche, marqueurMoi, carteAjout;
    const marqueurs = new Map();
    let requete = 0;

    /* ---------- Outils d'affichage ---------- */

    const categorie = code => etat.categories[code] || { libelle: code, icone: 'location_on', couleur: '#0f4c5c' };
    const distanceDe = e => (etat.position ? haversine(etat.position, e) : e.distance);
    const premierTelephone = tel => (tel ? tel.split('/')[0].replace(/[^\d+]/g, '') : null);
    const itineraire = e => `https://www.google.com/maps/dir/?api=1&destination=${e.lat},${e.lng}`;
    const chargement = () => `<div class="vide">${ic('progress_activity')}Chargement…</div>`;
    const vide = (icone, texte) => `<div class="vide">${ic(icone)}${esc(texte)}</div>`;

    function vignette(e, grande = false) {
        const cat = categorie(e.categorie);
        if (e.photo_id || e.photos?.[0]) {
            return `<img class="vignette" src="/api/photos/${e.photo_id || e.photos[0]}" alt="" loading="lazy">`;
        }
        return `<div class="vignette" style="--c:${cat.couleur}">${ic(cat.icone, grande ? 'fill' : '')}</div>`;
    }

    function badgesEtat(e, creneau) {
        const b = [];
        if (e.de_garde) b.push('<span class="badge vert">De garde aujourd\'hui</span>');
        else if (e.ouvert_24h) b.push('<span class="badge vert">Ouvert 24h/24</span>');
        if (e.urgences) b.push('<span class="badge rouge">Urgences</span>');
        if (creneau) b.push(`<span class="badge vert">Créneau ${esc(creneau.heure.replace(':', 'h'))}</span>`);
        return b.join('');
    }

    function aPied(m) {
        if (m == null) return '';
        const minutes = Math.max(1, Math.round(m / 80));
        return m < 2500 ? `≈ ${minutes} min à pied` : '';
    }

    /* ---------- Carte ---------- */

    function initialiserCarte() {
        const { centre, zoom } = etat.meta.pays;
        carte = L.map('carte', { zoomControl: false }).setView([centre.lat, centre.lng], zoom);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">contributeurs OpenStreetMap</a>'
        }).addTo(carte);
        couche = L.layerGroup().addTo(carte);
        const zoomProche = () => {
            const proche = carte.getZoom() >= 15;
            $('#carte').classList.toggle('zoom-proche', proche);
            $('#carte').classList.toggle('zoom-loin', !proche);
        };
        carte.on('zoomend', zoomProche);
        carte.on('moveend', verifierZone);
        carte.on('click', () => etat.selection && fermerCarte());
        zoomProche();
        window.addEventListener('resize', () => carte.invalidateSize());
    }

    function icone(e, selectionne) {
        const cat = categorie(e.categorie);
        const couleur = e.urgences ? '#8b1d1d' : e.de_garde ? '#138a5a' : cat.couleur;
        const plein = e.de_garde || e.urgences || e.premium;
        let etiquette = '';
        if (selectionne) etiquette = `<span class="pin-label nom">${esc(e.nom)}</span>`;
        else if (e.de_garde) etiquette = '<span class="pin-label garde">Garde</span>';
        else if (e.urgences) etiquette = '<span class="pin-label urgences">Urgences</span>';
        return L.divIcon({
            className: 'pin-wrap',
            html: `<div class="pin${plein ? ' plein' : ''}${selectionne ? ' selection' : ''}" style="--c:${couleur}">${etiquette}${ic(cat.icone)}</div>`,
            iconSize: [40, 48],
            iconAnchor: [20, 48]
        });
    }

    function afficherMarqueurs() {
        couche.clearLayers();
        marqueurs.clear();
        for (const e of etat.resultats) {
            const choisi = e.id === etat.selection;
            const m = L.marker([e.lat, e.lng], { icon: icone(e, choisi), title: e.nom, riseOnHover: true, zIndexOffset: choisi ? 1000 : 0 });
            m.on('click', ev => {
                L.DomEvent.stopPropagation(ev);
                selectionner(e.id);
            });
            m.addTo(couche);
            marqueurs.set(e.id, m);
        }
    }

    function majIcone(id) {
        document.querySelectorAll(`#liste-panneau .ligne[data-id="${id}"]`).forEach(l => l.classList.toggle('active', id === etat.selection));
        const m = marqueurs.get(id);
        const e = etat.resultats.find(x => x.id === id);
        if (!m || !e) return;
        m.setIcon(icone(e, id === etat.selection));
        m.setZIndexOffset(id === etat.selection ? 1000 : 0);
    }

    function placerMoi() {
        const icon = L.divIcon({ className: 'pin-wrap', html: '<div class="moi"><span class="moi-label">Vous êtes ici</span></div>', iconSize: [22, 22], iconAnchor: [11, 11] });
        const pos = [etat.position.lat, etat.position.lng];
        if (marqueurMoi) marqueurMoi.setLatLng(pos);
        else marqueurMoi = L.marker(pos, { icon, interactive: false, zIndexOffset: 900 }).addTo(carte);
    }

    /** Centre la carte sur l'établissement, en tenant compte du panneau du bas sur téléphone */
    function centrerSur(e) {
        if (!estMobile()) return carte.panTo([e.lat, e.lng]);
        // Le repère doit tomber au milieu de la partie visible, entre la recherche et le panneau du bas
        const decalage = ($('#sheet').offsetHeight - 140) / 2 - 20;
        const point = carte.project([e.lat, e.lng], carte.getZoom()).add([0, Math.max(decalage, 0)]);
        carte.panTo(carte.unproject(point, carte.getZoom()));
    }

    function verifierZone() {
        if (document.body.dataset.vue !== 'carte' || !etat.centre) return;
        const c = carte.getCenter();
        const ecart = haversine(etat.centre, { lat: c.lat, lng: c.lng });
        $('#btn-zone').hidden = ecart < etat.rayon * 1000 * 0.35 || !!etat.recherche;
    }

    /* ---------- Chargement des établissements ---------- */

    const filtreOptions = e => (!etat.options.h24 || e.ouvert_24h || e.de_garde) && (!etat.options.urgences || e.urgences) && (!etat.options.rdv || e.rdv_actif);

    async function charger({ ajuster = false } = {}) {
        const numero = ++requete;
        const p = new URLSearchParams({ lat: etat.centre.lat.toFixed(5), lng: etat.centre.lng.toFixed(5), rayon: etat.rayon });
        if (etat.categorie === 'garde') p.set('garde', '1');
        else if (etat.categorie !== 'tous') p.set('categorie', etat.categorie);
        if (etat.recherche) p.set('q', etat.recherche);

        let res;
        try {
            res = await api('/etablissements?' + p);
        } catch (err) {
            return toast(err.message, true);
        }
        if (numero !== requete) return; // une recherche plus récente a été lancée

        etat.compteurs = res.compteurs;
        etat.resultats = res.items.filter(filtreOptions);
        // L'API renvoie au plus 300 établissements : le total réel sert au compteur
        etat.total = Object.values(etat.options).some(Boolean) ? etat.resultats.length : res.total;
        if (etat.selection && !etat.resultats.some(e => e.id === etat.selection)) fermerCarte(false);

        afficherChips();
        afficherMarqueurs();
        afficherProximite();
        afficherPanneau();
        if (document.body.dataset.vue === 'liste') afficherListe();
        $('#btn-zone').hidden = true;

        if (ajuster && etat.resultats.length) {
            const bornes = L.latLngBounds(etat.resultats.slice(0, 25).map(e => [e.lat, e.lng]));
            carte.fitBounds(bornes, { padding: [70, 70], maxZoom: 16 });
        }
        if (etat.autoSelection && !etat.selection && etat.resultats.length && document.body.dataset.vue === 'carte') {
            selectionner(etat.resultats[0].id);
        }
    }

    function afficherChips() {
        $('#chips').innerHTML = ORDRE_CHIPS.map(code => {
            const actif = etat.categorie === code;
            const n = etat.compteurs[code];
            const cat = etat.categories[code];
            const libelle = code === 'tous' ? 'Tous' : code === 'garde' ? 'Pharmacie de garde' : LIBELLES_COURTS[code] || cat.libelle;
            const symbole = actif ? ic('check') : code === 'tous' ? '' : code === 'garde' ? ic('nights_stay') : ic(cat.icone);
            return `<button type="button" class="chip${actif ? ' active' : ''}" data-cat="${code}" aria-pressed="${actif}">${symbole}${esc(libelle)}${actif && n !== undefined ? `<span class="count">${n}</span>` : ''}</button>`;
        }).join('');
    }

    function afficherProximite() {
        const n = etat.total;
        const el = $('#proximite');
        if (!n) {
            const texte = etat.categorie === 'garde'
                ? 'Aucune pharmacie de garde renseignée ici aujourd\'hui'
                : etat.recherche ? `Aucun résultat pour « ${esc(etat.recherche)} »` : 'Aucun établissement dans ce rayon';
            const suivant = RAYONS.find(r => r > etat.rayon);
            el.innerHTML = `<span>${ic('info')}${texte}</span>${suivant && !etat.recherche ? `<a href="#" data-action="elargir">${suivant} km ${ic('chevron_right')}</a>` : ''}`;
            return;
        }
        const quoi = etat.recherche ? `résultat${n > 1 ? 's' : ''} pour « ${esc(etat.recherche)} »` : `établissement${n > 1 ? 's' : ''} à proximité`;
        el.innerHTML = `<span>${ic('explore')}${n} ${quoi}</span><a href="#/liste">Voir la liste ${ic('chevron_right')}</a>`;
    }

    function afficherBandeauUrgence() {
        const [samu, pompiers] = etat.meta.pays.urgences;
        $('#bandeau-urgence').innerHTML = `
            <span class="rond">${ic('medical_services')}</span>
            <div><b>Besoin d'une aide médicale urgente ?</b><small>${esc(samu.libelle)} (${esc(samu.numero)}) ou ${esc(pompiers.libelle)} (${esc(pompiers.numero)})</small></div>
            <a href="tel:${esc(samu.numero)}">Appeler le ${esc(samu.numero)}</a>`;
    }

    /* ---------- Sélection et carte de l'établissement ---------- */

    async function selectionner(id, { centrer = true } = {}) {
        const precedent = etat.selection;
        etat.selection = id;
        etat.detail = null;
        majIcone(precedent);
        majIcone(id);
        const e = etat.resultats.find(x => x.id === id);
        if (!e) return;
        afficherCarte(e);
        if (centrer) centrerSur(e);
        if (e.rdv_actif) {
            try {
                const detail = await api(`/etablissements/${id}`);
                if (etat.selection === id) {
                    etat.detail = detail;
                    afficherCarte(e);
                    // La carte a grandi avec les créneaux : on recentre
                    if (centrer) centrerSur(e);
                }
            } catch { /* la carte reste affichée sans les créneaux */ }
        }
    }

    function fermerCarte(manuel = true) {
        const precedent = etat.selection;
        etat.selection = null;
        etat.detail = null;
        majIcone(precedent);
        $('#fiche-carte').hidden = true;
        $('#sheet').classList.remove('avec-carte');
        if (manuel) etat.autoSelection = false;
    }

    function afficherCarte(e) {
        const cat = categorie(e.categorie);
        const creneaux = etat.detail?.prochains_creneaux || [];
        const dist = distanceDe(e);
        const tel = premierTelephone(e.telephone);
        const sous = [e.commune, e.premium ? 'Établissement partenaire' : null, e.verifie ? 'Vérifié' : null].filter(Boolean).join(' • ') || cat.libelle;

        let principal;
        if (e.rdv_actif) principal = `<a class="btn btn-primary" href="#/fiche/${e.id}">${ic('calendar_month')}Prendre RDV</a>`;
        else if (tel) principal = `<a class="btn btn-primary" href="tel:${esc(tel)}">${ic('call')}Appeler</a>`;
        else principal = `<a class="btn btn-primary" href="${itineraire(e)}" target="_blank" rel="noopener">${ic('directions')}Itinéraire</a>`;

        const secondaires = [];
        if (e.rdv_actif || tel) secondaires.push(`<a class="btn btn-carre" href="${itineraire(e)}" target="_blank" rel="noopener" aria-label="Itinéraire">${ic('directions')}</a>`);
        if (e.rdv_actif && tel) secondaires.push(`<a class="btn btn-carre" href="tel:${esc(tel)}" aria-label="Appeler">${ic('call')}</a>`);
        if (!e.rdv_actif) secondaires.push(`<a class="btn btn-carre" href="#/fiche/${e.id}" aria-label="Voir la fiche">${ic('info')}</a>`);

        const el = $('#fiche-carte');
        el.style.setProperty('--c', cat.couleur);
        el.innerHTML = `
            <div class="handle"></div>
            <button type="button" class="close-card" data-action="fermer-carte" aria-label="Fermer">${ic('close')}</button>
            <div class="badges">
                <span class="badge">${esc(cat.libelle)}</span>${badgesEtat(e, creneaux[0])}
                ${dist != null ? `<span class="meta"><span>${ic('directions_walk')}${distance(dist)}</span>${aPied(dist) ? `<span>${aPied(dist)}</span>` : ''}</span>` : ''}
            </div>
            <a class="ident" href="#/fiche/${e.id}">
                ${vignette(e)}
                <div>
                    <h2>${esc(e.nom)}${e.verifie ? ic('verified', 'fill') : ''}</h2>
                    <p>${esc(sous)}</p>
                    <p class="adresse">${ic('location_on')}${esc(e.adresse || e.commune || 'Adresse non renseignée')}</p>
                </div>
            </a>
            ${creneaux.length ? `
                <p class="dispos-titre">Prochaines disponibilités :</p>
                <div class="creneaux">${creneaux.map(c => `
                    <button type="button" class="creneau" data-action="creneau" data-id="${e.id}" data-date="${c.date}" data-heure="${c.heure}">
                        ${esc(c.heure)}<small>${esc(jourLisible(c.date))}</small>
                    </button>`).join('')}
                </div>` : ''}
            <div class="actions">${principal}${secondaires.join('')}</div>`;
        el.hidden = false;
        $('#sheet').classList.add('avec-carte');
    }

    /* ---------- Liste ---------- */

    function afficherListe() {
        const n = etat.total;
        const lignes = etat.resultats.slice(0, etat.listeMax).map(ligneEtablissement).join('');
        $('#liste').innerHTML = n
            ? `<div class="liste-entete"><span>${n} établissement${n > 1 ? 's' : ''}${etat.recherche ? '' : ` à moins de ${etat.rayon} km`}</span><span>Les plus proches d'abord</span></div>
               ${lignes}
               ${etat.resultats.length > etat.listeMax ? `<button type="button" class="btn btn-ligne plus" data-action="plus-liste">Afficher plus</button>` : ''}`
            : vide('search_off', etat.categorie === 'garde' ? 'Aucune pharmacie de garde renseignée ici aujourd\'hui.' : 'Aucun établissement trouvé. Essayez un rayon plus grand ou une autre recherche.');
    }

    /** Sur ordinateur, la liste des plus proches occupe le panneau sous la fiche ; un clic les montre sur la carte */
    function afficherPanneau() {
        if (estMobile()) return;
        const proches = etat.resultats.slice(0, 25);
        $('#liste-panneau').innerHTML = proches.length
            ? `<h2>Les plus proches</h2>${proches.map(e => ligneEtablissement(e, true)).join('')}`
            : '';
    }

    function ligneEtablissement(e, surCarte = false) {
        const cat = categorie(e.categorie);
        const dist = distanceDe(e);
        const lien = surCarte ? `href="#/carte" data-action="voir" data-id="${e.id}"` : `href="#/fiche/${e.id}"`;
        return `<a class="ligne${surCarte && e.id === etat.selection ? ' active' : ''}" ${lien}>
            ${vignette(e)}
            <div class="ligne-corps">
                <div class="ligne-titre">${esc(e.nom)}${e.verifie ? ic('verified', 'fill') : ''}</div>
                <div class="ligne-sous">${esc(cat.libelle)}${e.commune ? ` • ${esc(e.commune)}` : ''}</div>
                ${badgesEtat(e) || e.rdv_actif ? `<div class="badges">${badgesEtat(e)}${e.rdv_actif ? '<span class="badge">RDV en ligne</span>' : ''}</div>` : ''}
            </div>
            <div class="ligne-fin">${dist != null ? distance(dist) : ''}</div>
        </a>`;
    }

    /* ---------- Fiche détaillée et rendez-vous ---------- */

    async function vueFiche(id) {
        vueEl.innerHTML = chargement();
        let e;
        try {
            e = await api(`/etablissements/${id}`);
        } catch (err) {
            vueEl.innerHTML = `<div class="vue-contenu"><button type="button" class="retour" data-action="retour">${ic('arrow_back')}Retour</button>${vide('error', err.message)}</div>`;
            return;
        }
        if (location.hash !== `#/fiche/${id}`) return;

        const cat = categorie(e.categorie);
        const dist = distanceDe(e);
        const tel = premierTelephone(e.telephone);
        const photo = e.photos[0];
        const infos = [
            `<div class="info">${ic('location_on')}<div>${esc(e.adresse || e.commune || 'Adresse non renseignée')}${e.adresse && e.commune ? `<small>${esc(e.commune)}</small>` : ''}${dist != null ? `<small>À ${distance(dist)} de vous</small>` : ''}</div></div>`,
            e.telephone ? `<div class="info">${ic('call')}<div>${e.telephone.split('/').map(t => `<a href="tel:${esc(premierTelephone(t))}">${esc(t.trim())}</a>`).join('<br>')}</div></div>` : '',
            `<div class="info">${ic('schedule')}<div>${esc(e.horaires || (e.ouvert_24h ? 'Ouvert 24h/24' : 'Horaires non renseignés'))}</div></div>`,
            e.site_web ? `<div class="info">${ic('language')}<div><a href="${esc(/^https?:\/\//.test(e.site_web) ? e.site_web : 'https://' + e.site_web)}" target="_blank" rel="noopener nofollow">${esc(e.site_web)}</a></div></div>` : '',
            ...e.gardes.map(g => `<div class="info">${ic('nights_stay')}<div>De garde ${g.debut === g.fin ? `le ${esc(jourLisible(g.debut))}` : `du ${esc(jourLisible(g.debut))} au ${esc(jourLisible(g.fin))}`}</div></div>`)
        ].join('');

        const sourceTexte = { osm: 'OpenStreetMap', contribution: 'ajouté par la communauté SantéMap', demo: 'exemple de démonstration' }[e.source] || 'équipe SantéMap';

        vueEl.innerHTML = `
            <div class="fiche-banniere" style="--c:${cat.couleur}">
                ${photo ? `<img src="/api/photos/${photo}" alt="Photo de ${esc(e.nom)}">` : ic(cat.icone, 'fill')}
                <button type="button" class="retour" data-action="retour">${ic('arrow_back')}Retour</button>
            </div>
            <div class="fiche-corps"><div class="vue-contenu">
                ${e.statut !== 'valide' ? `<p class="erreur">${e.statut === 'refuse' ? `Contribution non retenue : ${esc(e.motif_refus || '')}` : 'En attente de vérification par l\'équipe : cette fiche n\'est pas encore publique.'}</p>` : ''}
                <div class="badges"><span class="badge">${esc(cat.libelle)}</span>${e.premium ? '<span class="badge or">Partenaire</span>' : ''}${badgesEtat(e)}</div>
                <h1>${esc(e.nom)}${e.verifie ? ic('verified', 'fill') : ''}</h1>
                ${e.description ? `<p class="intro">${esc(e.description)}</p>` : ''}
                <div class="actions">
                    <a class="btn btn-primary" href="${itineraire(e)}" target="_blank" rel="noopener">${ic('directions')}Itinéraire</a>
                    ${tel ? `<a class="btn btn-carre" href="tel:${esc(tel)}" aria-label="Appeler">${ic('call')}</a>` : ''}
                    <button type="button" class="btn btn-carre" data-action="partager" aria-label="Partager">${ic('share')}</button>
                </div>
                <div class="infos">${infos}</div>
                ${e.services.length ? `<h2 class="section">Services proposés</h2><div class="services">${e.services.map(s => `<span class="service">${esc(s)}</span>`).join('')}</div>` : ''}
                ${e.prix_consultation ? `<p class="prix">Consultation à partir de <b>${fcfa(e.prix_consultation)}</b></p>` : ''}
                ${e.rdv_actif && e.statut === 'valide' ? sectionRdv(e) : ''}
                <div class="source"><span>Source : ${esc(sourceTexte)}</span>${e.statut === 'valide' ? '<button type="button" data-action="signaler">Signaler une erreur</button>' : ''}</div>
            </div></div>`;

        vueEl.querySelector('[data-action="partager"]').addEventListener('click', () => partager(e));
        vueEl.querySelector('[data-action="signaler"]')?.addEventListener('click', () => signaler(e));
        if (e.rdv_actif && e.statut === 'valide') brancherRdv(e);
    }

    function joursOuverts(e) {
        const jours = [];
        const aujourdhui = dateLocale();
        for (let i = 0; i < 14; i++) {
            const date = ajouterJours(aujourdhui, i);
            const j = new Date(`${date}T12:00:00`).getDay() || 7;
            jours.push({ date, ouvert: (e.rdv_horaires?.[j] || []).length > 0 });
        }
        return jours;
    }

    function sectionRdv(e) {
        const user = session.user();
        return `
            <h2 class="section" id="rdv">Prendre rendez-vous</h2>
            <div class="jours">${joursOuverts(e).map(j => {
                const d = new Date(`${j.date}T12:00:00`);
                return `<button type="button" class="jour" data-date="${j.date}" ${j.ouvert ? '' : 'disabled'}>${esc(jourLisible(j.date).split(' ')[0].replace('Aujourd\'hui', 'Auj.'))}<b>${d.getDate()}</b></button>`;
            }).join('')}</div>
            <div class="grille-creneaux" id="grille-creneaux"></div>
            <form class="form" id="form-rdv" hidden style="margin-top:16px">
                <div class="champ"><label for="rdv-motif">Motif (facultatif)</label><input class="input" id="rdv-motif" maxlength="255" placeholder="Ex. consultation, vaccination…"></div>
                <div class="champ"><label for="rdv-tel">Téléphone pour vous joindre</label><input class="input" id="rdv-tel" type="tel" inputmode="tel" value="${esc(user?.telephone || '')}" required></div>
                <p class="erreur" id="rdv-erreur" hidden></p>
                <button class="btn btn-primary" type="submit">${ic('event_available')}<span id="rdv-bouton">Confirmer le rendez-vous</span></button>
                <p class="note">L'établissement confirme votre demande ; vous êtes prévenu(e) dans l'application.</p>
            </form>`;
    }

    function brancherRdv(e) {
        const grille = vueEl.querySelector('#grille-creneaux');
        const form = vueEl.querySelector('#form-rdv');
        let choix = null;

        async function choisirJour(date, heurePreferee) {
            vueEl.querySelectorAll('.jour').forEach(b => b.classList.toggle('active', b.dataset.date === date));
            grille.innerHTML = '<p class="note">Chargement des créneaux…</p>';
            form.hidden = true;
            choix = null;
            let res;
            try {
                res = await api(`/etablissements/${e.id}/creneaux?date=${date}`);
            } catch (err) {
                grille.innerHTML = `<p class="erreur">${esc(err.message)}</p>`;
                return;
            }
            grille.innerHTML = res.creneaux.length
                ? res.creneaux.map(h => `<button type="button" class="creneau" data-heure="${h}">${h}</button>`).join('')
                : '<p class="note">Plus de créneau libre ce jour-là : choisissez un autre jour.</p>';
            if (heurePreferee) grille.querySelector(`[data-heure="${heurePreferee}"]`)?.click();
        }

        vueEl.querySelectorAll('.jour:not([disabled])').forEach(b => b.addEventListener('click', () => choisirJour(b.dataset.date)));
        grille.addEventListener('click', ev => {
            const b = ev.target.closest('.creneau');
            if (!b) return;
            grille.querySelectorAll('.creneau').forEach(x => x.classList.toggle('choisi', x === b));
            choix = { date: vueEl.querySelector('.jour.active').dataset.date, heure: b.dataset.heure };
            vueEl.querySelector('#rdv-bouton').textContent = `Confirmer : ${jourLisible(choix.date)} à ${choix.heure}`;
            form.hidden = false;
        });

        form.addEventListener('submit', async ev => {
            ev.preventDefault();
            if (!choix) return;
            if (!session.jeton()) {
                etat.apresConnexion = location.hash;
                etat.creneauChoisi = choix;
                toast('Connectez-vous pour confirmer votre rendez-vous');
                location.hash = '#/compte';
                return;
            }
            const erreur = vueEl.querySelector('#rdv-erreur');
            erreur.hidden = true;
            const bouton = form.querySelector('button[type="submit"]');
            bouton.disabled = true;
            try {
                const rdv = await api('/moi/rendez-vous', {
                    methode: 'POST',
                    corps: { etablissement_id: e.id, date: choix.date, heure: choix.heure, motif: vueEl.querySelector('#rdv-motif').value, telephone: vueEl.querySelector('#rdv-tel').value }
                });
                form.outerHTML = `<div class="element" style="margin-top:16px"><b>${ic('check_circle', 'fill')} Demande envoyée</b>
                    <p>${esc(jourLisible(choix.date))} à ${esc(choix.heure)} — référence <b>${esc(rdv.reference)}</b>. Vous serez prévenu(e) dès que ${esc(e.nom)} confirme.</p></div>`;
                grille.innerHTML = '';
                rafraichirNotifications();
            } catch (err) {
                erreur.textContent = err.message;
                erreur.hidden = false;
                bouton.disabled = false;
                if (err.status === 409) choisirJour(choix.date);
            }
        });

        // Créneau choisi depuis la carte, ou premier jour disponible
        const choisi = etat.creneauChoisi;
        etat.creneauChoisi = null;
        const premierJour = choisi?.date || e.prochains_creneaux[0]?.date || joursOuverts(e).find(j => j.ouvert)?.date;
        if (premierJour) choisirJour(premierJour, choisi?.heure);
        if (choisi) setTimeout(() => vueEl.querySelector('#rdv')?.scrollIntoView({ behavior: 'smooth' }), 300);
    }

    async function partager(e) {
        const url = `${location.origin}/#/fiche/${e.id}`;
        const texte = `${e.nom} (${categorie(e.categorie).libelle}) sur SantéMap`;
        if (navigator.share) {
            try { await navigator.share({ title: e.nom, text: texte, url }); } catch { /* partage annulé */ }
        } else {
            window.open(`https://wa.me/?text=${encodeURIComponent(`${texte} : ${url}`)}`, '_blank', 'noopener');
        }
    }

    function signaler(e) {
        const { el, fermer } = dialogue(`
            <h3>Signaler une erreur</h3>
            <p class="note">Sur « ${esc(e.nom)} ». L'équipe vérifie chaque signalement.</p>
            <form class="form" id="form-signalement">
                <div class="champ"><label for="sig-motif">Problème</label>
                    <select class="input" id="sig-motif">
                        <option value="ferme">L'établissement a fermé</option>
                        <option value="mauvaise_position">Il n'est pas au bon endroit</option>
                        <option value="mauvaises_infos">Nom, téléphone ou horaires faux</option>
                        <option value="doublon">Il apparaît en double</option>
                        <option value="autre">Autre</option>
                    </select></div>
                <div class="champ"><label for="sig-message">Précisions (facultatif)</label><textarea class="input" id="sig-message" maxlength="500"></textarea></div>
                <div class="actions"><button type="button" class="btn btn-ligne" data-fermer>Annuler</button><button class="btn btn-primary" type="submit">Envoyer</button></div>
            </form>`);
        el.querySelector('form').addEventListener('submit', async ev => {
            ev.preventDefault();
            try {
                const res = await api(`/etablissements/${e.id}/signalements`, { methode: 'POST', corps: { motif: el.querySelector('#sig-motif').value, message: el.querySelector('#sig-message').value } });
                fermer();
                toast(res.message);
            } catch (err) {
                toast(err.message, true);
            }
        });
    }

    /* ---------- Urgences ---------- */

    async function vueUrgences() {
        const { urgences } = etat.meta.pays;
        vueEl.innerHTML = `<div class="vue-contenu">
            <h1>Urgences</h1>
            <p class="intro">En cas de danger pour la vie, appelez immédiatement.</p>
            <div class="numeros">${urgences.map(u => `
                <a class="numero" href="tel:${esc(u.numero)}">
                    <span class="rond">${esc(u.numero)}</span>
                    <div><b>${esc(u.libelle)}</b><small>${esc(u.description)}</small></div>
                    ${ic('call', 'fill')}
                </a>`).join('')}
            </div>
            <div class="conseil">${ic('info')}<span>En attendant les secours : restez calme, donnez une adresse précise et un repère connu, et ne raccrochez pas avant qu'on vous le dise.</span></div>
            <h2 class="section">Hôpitaux les plus proches</h2>
            <div id="hopitaux">${chargement()}</div>
        </div>`;
        try {
            const c = etat.position || etat.centre;
            const res = await api(`/etablissements?categorie=hopital&rayon=30&lat=${c.lat.toFixed(5)}&lng=${c.lng.toFixed(5)}`);
            const liste = [...res.items].sort((a, b) => (b.urgences - a.urgences) || (a.distance - b.distance)).slice(0, 8);
            vueEl.querySelector('#hopitaux').innerHTML = liste.length ? liste.map(ligneEtablissement).join('') : vide('local_hospital', 'Aucun hôpital trouvé à moins de 30 km.');
        } catch (err) {
            vueEl.querySelector('#hopitaux').innerHTML = vide('error', err.message);
        }
    }

    /* ---------- Compte ---------- */

    function vueConnexion() {
        const demo = etat.meta.demo;
        vueEl.innerHTML = `<div class="vue-contenu">
            <h1>Mon compte</h1>
            <p class="intro">Connectez-vous pour prendre rendez-vous, ajouter des établissements sur la carte et gagner des points.</p>
            <div class="onglets" role="tablist">
                <button type="button" class="active" data-onglet="connexion" role="tab">Connexion</button>
                <button type="button" data-onglet="inscription" role="tab">Créer un compte</button>
            </div>
            <form class="form" id="form-connexion">
                <div class="champ"><label for="cx-id">Téléphone ou e-mail</label><input class="input" id="cx-id" autocomplete="username" required></div>
                <div class="champ"><label for="cx-mdp">Mot de passe</label><input class="input" id="cx-mdp" type="password" autocomplete="current-password" required></div>
                <p class="erreur" hidden></p>
                <button class="btn btn-primary" type="submit">Se connecter</button>
                ${demo ? '<p class="note">Compte de démonstration : <b>demo@santemap.ci</b> / <b>demo12345</b></p>' : ''}
            </form>
            <form class="form" id="form-inscription" hidden>
                <div class="champ"><label for="in-nom">Nom et prénom</label><input class="input" id="in-nom" autocomplete="name" required></div>
                <div class="champ"><label for="in-tel">Téléphone</label><input class="input" id="in-tel" type="tel" inputmode="tel" autocomplete="tel" placeholder="07 00 00 00 00" required></div>
                <div class="champ"><label for="in-email">E-mail <small>(facultatif)</small></label><input class="input" id="in-email" type="email" autocomplete="email"></div>
                <div class="champ"><label for="in-mdp">Mot de passe</label><input class="input" id="in-mdp" type="password" autocomplete="new-password" minlength="8" required><small>8 caractères minimum</small></div>
                <div class="champ"><label for="in-code">Code de parrainage <small>(facultatif)</small></label><input class="input" id="in-code" autocapitalize="characters" maxlength="12"></div>
                <p class="erreur" hidden></p>
                <button class="btn btn-primary" type="submit">Créer mon compte</button>
            </form>
        </div>`;

        vueEl.querySelectorAll('[data-onglet]').forEach(b => b.addEventListener('click', () => {
            vueEl.querySelectorAll('[data-onglet]').forEach(x => x.classList.toggle('active', x === b));
            vueEl.querySelector('#form-connexion').hidden = b.dataset.onglet !== 'connexion';
            vueEl.querySelector('#form-inscription').hidden = b.dataset.onglet !== 'inscription';
        }));

        const soumettre = (id, chemin, corps) => vueEl.querySelector(id).addEventListener('submit', async ev => {
            ev.preventDefault();
            const form = ev.currentTarget;
            const erreur = form.querySelector('.erreur');
            erreur.hidden = true;
            form.querySelector('button[type="submit"]').disabled = true;
            try {
                const res = await api(chemin, { methode: 'POST', corps: corps() });
                session.enregistrer(res.token, res.user);
                majEntete();
                rafraichirNotifications();
                toast(`Bienvenue ${res.user.nom.split(' ')[0]} !`);
                const suite = etat.apresConnexion;
                etat.apresConnexion = null;
                if (suite && suite !== location.hash) location.hash = suite;
                else router();
            } catch (err) {
                erreur.textContent = err.message;
                erreur.hidden = false;
                form.querySelector('button[type="submit"]').disabled = false;
            }
        });
        soumettre('#form-connexion', '/auth/connexion', () => ({ identifiant: vueEl.querySelector('#cx-id').value, mot_de_passe: vueEl.querySelector('#cx-mdp').value }));
        soumettre('#form-inscription', '/auth/inscription', () => ({
            nom: vueEl.querySelector('#in-nom').value,
            telephone: vueEl.querySelector('#in-tel').value,
            email: vueEl.querySelector('#in-email').value,
            mot_de_passe: vueEl.querySelector('#in-mdp').value,
            code_parrainage: vueEl.querySelector('#in-code').value
        }));
    }

    async function vueCompte() {
        if (!session.jeton()) return vueConnexion();
        vueEl.innerHTML = chargement();
        let t;
        try {
            t = await api('/moi/tableau');
        } catch (err) {
            if (!session.jeton()) return vueConnexion();
            vueEl.innerHTML = vide('error', err.message);
            return;
        }
        if (location.hash !== '#/compte') return;
        session.majUser(t.user);
        majEntete();

        const u = t.user;
        const { actuel, suivant } = t.palier;
        const base = actuel?.seuil || 0;
        const progression = suivant ? Math.round(((u.points - base) / (suivant.seuil - base)) * 100) : 100;
        const roles = { admin: 'Équipe SantéMap', etablissement: 'Compte établissement', utilisateur: 'Membre' };

        vueEl.innerHTML = `<div class="vue-contenu">
            <div class="profil">
                <span class="avatar">${esc(initiales(u.nom))}</span>
                <div><b>${esc(u.nom)}</b><small>${esc(roles[u.role])}${u.telephone ? ` • ${esc(u.telephone)}` : ''}</small></div>
            </div>

            <div class="points">
                <div class="points-haut">
                    <div class="points-nombre">${u.points} <small>points</small></div>
                    ${actuel ? `<span class="badge or">${ic('workspace_premium', 'fill')}${esc(actuel.nom)}</span>` : ''}
                </div>
                <div class="jauge"><div style="width:${Math.max(4, Math.min(progression, 100))}%"></div></div>
                <p class="note">${suivant ? `Encore <b>${suivant.seuil - u.points} points</b> pour le palier ${esc(suivant.nom)}.` : 'Vous avez atteint le palier le plus haut, bravo !'} Les cadeaux de chaque palier sont annoncés par l'équipe SantéMap.</p>
                <ul class="regles">
                    <li><b>+${etat.meta.points.CONTRIBUTION}</b> par établissement ajouté et validé</li>
                    <li><b>+${etat.meta.points.PHOTO}</b> si vous ajoutez une photo</li>
                    <li><b>+${etat.meta.points.PARRAINAGE}</b> quand une personne parrainée fait sa première contribution</li>
                </ul>
                <div class="parrainage">
                    <span class="note">Votre code</span><code>${esc(u.code_parrainage)}</code>
                    <button type="button" class="btn btn-ligne btn-petit" data-action="partager-code">${ic('share')}Inviter</button>
                </div>
                ${t.filleuls ? `<p class="note">${t.filleuls} personne${t.filleuls > 1 ? 's ont' : ' a'} rejoint SantéMap avec votre code.</p>` : ''}
            </div>

            <div class="menu-compte">
                <a href="#/ajouter">${ic('add_location_alt')}Ajouter un établissement${ic('chevron_right', 'fin')}</a>
                <a href="#/notifications">${ic('notifications')}Notifications${t.notifications_non_lues ? ` <span class="statut en_attente">${t.notifications_non_lues}</span>` : ''}${ic('chevron_right', 'fin')}</a>
                ${u.role === 'admin' ? `<a href="/admin.html">${ic('admin_panel_settings')}Administration${ic('chevron_right', 'fin')}</a>` : ''}
                <button type="button" data-action="deconnexion">${ic('logout')}Se déconnecter</button>
            </div>

            ${u.role === 'etablissement' ? '<h2 class="section">Rendez-vous de mon établissement</h2><div id="pro">' + chargement() + '</div>' : ''}

            <h2 class="section">Mes rendez-vous</h2>
            ${t.rendez_vous.length ? t.rendez_vous.map(r => `
                <div class="element">
                    <div class="element-haut"><b>${esc(r.etablissement)}</b><span class="statut ${r.statut}">${STATUTS[r.statut]}</span></div>
                    <p>${esc(dateHeure(r.debut))} • réf. ${esc(r.reference)}${r.motif ? ` • ${esc(r.motif)}` : ''}</p>
                    ${['en_attente', 'confirme'].includes(r.statut) && r.debut.slice(0, 10) >= dateLocale() ? `<div class="actions"><a class="btn btn-ligne btn-petit" href="#/fiche/${r.etablissement_id}">Voir la fiche</a><button type="button" class="btn btn-ligne btn-petit" data-action="annuler-rdv" data-id="${r.id}">Annuler</button></div>` : ''}
                </div>`).join('') : '<p class="note">Aucun rendez-vous pour le moment. Les établissements partenaires proposent la prise de rendez-vous depuis leur fiche.</p>'}

            <h2 class="section">Mes contributions</h2>
            ${t.contributions.length ? t.contributions.map(c => `
                <div class="element">
                    <div class="element-haut"><b>${esc(c.nom)}</b><span class="statut ${c.statut}">${STATUTS[c.statut]}</span></div>
                    <p>${esc(categorie(c.categorie).libelle)}${c.commune ? ` • ${esc(c.commune)}` : ''}${c.motif_refus ? ` — ${esc(c.motif_refus)}` : ''}</p>
                </div>`).join('') : `<p class="note">Vous n'avez encore rien ajouté. Une pharmacie ou une clinique manque près de chez vous ? <a href="#/ajouter"><b>Ajoutez-la</b></a>.</p>`}

            <h2 class="section">Meilleurs contributeurs</h2>
            <div class="classement" id="classement">${chargement()}</div>
        </div>`;

        api('/classement').then(liste => {
            const el = vueEl.querySelector('#classement');
            if (el) el.innerHTML = liste.length ? liste.map(l => `<div class="element"><b>${esc(l.nom)}</b><span>${l.points} pts</span></div>`).join('') : '<p class="note">Soyez le premier contributeur !</p>';
        }).catch(() => { /* classement facultatif */ });

        if (u.role === 'etablissement') afficherPro();
    }

    async function afficherPro() {
        const el = vueEl.querySelector('#pro');
        try {
            const { etablissement, rendez_vous: liste } = await api('/pro');
            el.innerHTML = `<p class="note">${esc(etablissement.nom)}</p>` + (liste.length ? liste.map(r => `
                <div class="element">
                    <div class="element-haut"><b>${esc(r.patient)}</b><span class="statut ${r.statut}">${STATUTS[r.statut]}</span></div>
                    <p>${esc(dateHeure(r.debut))} • <a href="tel:${esc(r.telephone)}">${esc(r.telephone)}</a>${r.motif ? ` • ${esc(r.motif)}` : ''} • réf. ${esc(r.reference)}</p>
                    ${['en_attente', 'confirme'].includes(r.statut) ? `<div class="actions">
                        ${r.statut === 'en_attente' ? `<button type="button" class="btn btn-primary btn-petit" data-action="pro-statut" data-id="${r.id}" data-statut="confirme">Confirmer</button>` : `<button type="button" class="btn btn-ligne btn-petit" data-action="pro-statut" data-id="${r.id}" data-statut="termine">Terminé</button>`}
                        <button type="button" class="btn btn-ligne btn-petit" data-action="pro-statut" data-id="${r.id}" data-statut="annule">Annuler</button></div>` : ''}
                </div>`).join('') : '<p class="note">Aucun rendez-vous à venir.</p>');
        } catch (err) {
            el.innerHTML = `<p class="erreur">${esc(err.message)}</p>`;
        }
    }

    /* ---------- Ajouter un établissement ---------- */

    function vueAjouter() {
        if (!session.jeton()) {
            vueEl.innerHTML = `<div class="vue-contenu">
                <button type="button" class="retour" data-action="retour">${ic('arrow_back')}Retour</button>
                <h1>Ajouter un établissement</h1>
                <p class="intro">Une pharmacie, une clinique ou un laboratoire manque sur la carte ? Connectez-vous pour l'ajouter : chaque ajout validé vous rapporte des points.</p>
                <a class="btn btn-primary" href="#/compte" data-action="connexion-puis-ajout">Se connecter ou créer un compte</a>
            </div>`;
            return;
        }
        const pts = etat.meta.points;
        vueEl.innerHTML = `<div class="vue-contenu">
            <button type="button" class="retour" data-action="retour">${ic('arrow_back')}Retour</button>
            <h1>Ajouter un établissement</h1>
            <p class="intro">L'équipe vérifie chaque ajout avant sa publication. Vous gagnez <b>${pts.CONTRIBUTION} points</b> à la validation, et <b>${pts.PHOTO} de plus</b> avec une photo.</p>
            <form class="form" id="form-ajout">
                <div class="champ">
                    <span class="label">Emplacement</span>
                    <div class="picker">
                        <div id="carte-ajout"></div>
                        <div class="picker-pin">${ic('location_on')}</div>
                        <button type="button" class="btn btn-ligne btn-petit" id="ajout-position">${ic('my_location')}Ma position</button>
                    </div>
                    <small>Déplacez la carte pour mettre le repère rouge sur l'entrée de l'établissement.</small>
                </div>
                <div class="champ"><label for="aj-cat">Type</label>
                    <select class="input" id="aj-cat" required>
                        <option value="">Choisir…</option>
                        ${etat.meta.categories.map(c => `<option value="${c.code}">${esc(c.libelle)}</option>`).join('')}
                    </select></div>
                <div class="champ"><label for="aj-nom">Nom</label><input class="input" id="aj-nom" maxlength="200" placeholder="Ex. Pharmacie Sainte-Marie" required></div>
                <div class="champ"><label for="aj-tel">Téléphone <small>(facultatif)</small></label><input class="input" id="aj-tel" type="tel" inputmode="tel" maxlength="60"></div>
                <div class="champ"><label for="aj-commune">Commune ou quartier</label><input class="input" id="aj-commune" maxlength="100" placeholder="Ex. Yopougon Sideci"></div>
                <div class="champ"><label for="aj-adresse">Repère <small>(facultatif)</small></label><input class="input" id="aj-adresse" maxlength="255" placeholder="Ex. en face du marché, à côté de la station"></div>
                <div class="champ"><label for="aj-horaires">Horaires <small>(facultatif)</small></label><input class="input" id="aj-horaires" maxlength="255" placeholder="Ex. lun–sam 8h–20h"></div>
                <label class="photo-zone">
                    <input type="file" id="aj-photo" accept="image/*" capture="environment" hidden>
                    <span id="aj-apercu">${ic('add_a_photo')}</span>
                    <span><b>Ajouter une photo</b><br><small class="note">La façade ou l'enseigne (+${pts.PHOTO} points)</small></span>
                </label>
                <p class="erreur" hidden></p>
                <button class="btn btn-primary" type="submit">${ic('send')}Envoyer pour vérification</button>
            </form>
        </div>`;

        const depart = carte.getCenter();
        carteAjout = L.map('carte-ajout', { zoomControl: false, attributionControl: false }).setView([depart.lat, depart.lng], 17);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(carteAjout);

        vueEl.querySelector('#ajout-position').addEventListener('click', () => {
            navigator.geolocation?.getCurrentPosition(
                pos => carteAjout?.setView([pos.coords.latitude, pos.coords.longitude], 18),
                () => toast('Position introuvable : placez le repère à la main', true),
                { enableHighAccuracy: true, timeout: 10000 }
            );
        });

        let photo = null;
        vueEl.querySelector('#aj-photo').addEventListener('change', async ev => {
            const fichier = ev.target.files[0];
            if (!fichier) return;
            try {
                photo = await redimensionner(fichier);
                vueEl.querySelector('#aj-apercu').innerHTML = `<img src="${photo}" alt="Aperçu de la photo">`;
            } catch {
                toast('Impossible de lire cette photo', true);
            }
        });

        vueEl.querySelector('#form-ajout').addEventListener('submit', async ev => {
            ev.preventDefault();
            const form = ev.currentTarget;
            const erreur = form.querySelector('.erreur');
            erreur.hidden = true;
            const bouton = form.querySelector('button[type="submit"]');
            bouton.disabled = true;
            const c = carteAjout.getCenter();
            try {
                const res = await api('/moi/contributions', {
                    methode: 'POST',
                    corps: {
                        categorie: form.querySelector('#aj-cat').value,
                        nom: form.querySelector('#aj-nom').value,
                        telephone: form.querySelector('#aj-tel').value,
                        commune: form.querySelector('#aj-commune').value,
                        adresse: form.querySelector('#aj-adresse').value,
                        horaires: form.querySelector('#aj-horaires').value,
                        lat: c.lat,
                        lng: c.lng,
                        photo
                    }
                });
                toast(res.message);
                location.hash = '#/compte';
            } catch (err) {
                erreur.textContent = err.message;
                erreur.hidden = false;
                bouton.disabled = false;
            }
        });
    }

    /** Réduit la photo (1280 px, JPEG) avant l'envoi pour économiser les données mobiles */
    async function redimensionner(fichier, max = 1280) {
        const image = await createImageBitmap(fichier, { imageOrientation: 'from-image' });
        const echelle = Math.min(1, max / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(image.width * echelle);
        canvas.height = Math.round(image.height * echelle);
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.82);
    }

    /* ---------- Notifications ---------- */

    async function vueNotifications() {
        if (!session.jeton()) {
            etat.apresConnexion = '#/notifications';
            return vueConnexion();
        }
        vueEl.innerHTML = chargement();
        try {
            const liste = await api('/moi/notifications');
            vueEl.innerHTML = `<div class="vue-contenu">
                <button type="button" class="retour" data-action="retour">${ic('arrow_back')}Retour</button>
                <h1>Notifications</h1>
                ${liste.length ? liste.map(n => `<div class="element"><div class="element-haut"><b>${esc(n.titre)}</b>${n.lu ? '' : '<span class="statut valide">Nouveau</span>'}</div><p>${esc(n.message)}</p></div>`).join('') : vide('notifications', 'Aucune notification pour le moment.')}
            </div>`;
            if (liste.some(n => !n.lu)) {
                await api('/moi/notifications/lues', { methode: 'POST' });
                $('#btn-notifs .dot').hidden = true;
            }
        } catch (err) {
            vueEl.innerHTML = vide('error', err.message);
        }
    }

    async function rafraichirNotifications() {
        if (!session.jeton()) {
            $('#btn-notifs .dot').hidden = true;
            return;
        }
        try {
            const liste = await api('/moi/notifications');
            $('#btn-notifs .dot').hidden = !liste.some(n => !n.lu);
        } catch { /* sans effet sur le reste de l'application */ }
    }

    function majEntete() {
        const user = session.user();
        $('#btn-avatar').innerHTML = user ? esc(initiales(user.nom)) : ic('person');
    }

    /* ---------- Position ---------- */

    async function nommerLieu(pos) {
        try {
            const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&accept-language=fr&lat=${pos.lat.toFixed(5)}&lon=${pos.lng.toFixed(5)}`);
            const a = (await r.json()).address || {};
            const quartier = a.suburb || a.city_district || a.town || a.village || a.city;
            if (quartier) $('#lieu').textContent = [quartier, a.city && a.city !== quartier ? a.city : null].filter(Boolean).join(' • ');
        } catch { /* le nom du quartier est facultatif */ }
    }

    function localiser(manuel) {
        if (!navigator.geolocation) {
            if (manuel) toast('La localisation n\'est pas disponible sur cet appareil', true);
            return;
        }
        navigator.geolocation.getCurrentPosition(pos => {
            const position = { lat: pos.coords.latitude, lng: pos.coords.longitude };
            const { centre, nom } = { ...etat.meta.pays };
            // Hors du pays couvert, on garde la carte sur la ville principale
            if (haversine(position, centre) > 1200000) {
                if (manuel) toast(`SantéMap couvre pour l'instant la ${nom} : affichage d'${etat.meta.pays.ville}`);
                return;
            }
            etat.position = position;
            etat.centre = { ...position };
            etat.autoSelection = true;
            fermerCarte(false);
            placerMoi();
            carte.setView([position.lat, position.lng], Math.max(carte.getZoom(), 15));
            nommerLieu(position);
            charger();
        }, err => {
            if (manuel) toast(err.code === 1 ? 'Autorisez la localisation dans votre navigateur pour voir ce qui est autour de vous' : 'Position introuvable pour le moment', true);
        }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
    }

    /* ---------- Filtres ---------- */

    function ouvrirFiltres() {
        const { el, fermer } = dialogue(`
            <h3>Filtres</h3>
            <form class="form" id="form-filtres">
                <div class="champ"><span class="label">Rayon de recherche</span>
                    <div class="services">${[...RAYONS, 50].map(r => `<label class="service"><input type="radio" name="rayon" value="${r}" ${r === etat.rayon ? 'checked' : ''}> ${r} km</label>`).join('')}</div></div>
                <div class="champ"><span class="label">Afficher seulement</span>
                    <label><input type="checkbox" name="h24" ${etat.options.h24 ? 'checked' : ''}> Ouverts 24h/24 ou de garde</label>
                    <label><input type="checkbox" name="urgences" ${etat.options.urgences ? 'checked' : ''}> Avec service d'urgences</label>
                    <label><input type="checkbox" name="rdv" ${etat.options.rdv ? 'checked' : ''}> Rendez-vous en ligne</label></div>
                <div class="actions"><button type="button" class="btn btn-ligne" data-fermer>Annuler</button><button class="btn btn-primary" type="submit">Appliquer</button></div>
            </form>`);
        el.querySelector('form').addEventListener('submit', ev => {
            ev.preventDefault();
            const f = ev.currentTarget;
            etat.rayon = Number(f.rayon.value);
            etat.options = { h24: f.h24.checked, urgences: f.urgences.checked, rdv: f.rdv.checked };
            $('#rayon-texte').textContent = `${etat.rayon} km`;
            fermer();
            etat.autoSelection = true;
            charger();
        });
    }

    /* ---------- Navigation ---------- */

    function router() {
        const [, nom = 'carte', param] = location.hash.split('/');
        const vue = ['carte', 'liste', ...VUES_PLEIN_ECRAN].includes(nom) ? nom : 'carte';
        document.body.dataset.vue = vue;
        document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('active', a.dataset.vue === (['ajouter', 'notifications'].includes(vue) ? 'compte' : vue)));
        $('#liste').hidden = vue !== 'liste';
        vueEl.hidden = !VUES_PLEIN_ECRAN.includes(vue);
        if (vue !== 'ajouter' && carteAjout) {
            carteAjout.remove();
            carteAjout = null;
        }
        vueEl.scrollTop = 0;

        switch (vue) {
            case 'liste': afficherListe(); $('.main').scrollTop = 0; break;
            case 'urgences': vueUrgences(); break;
            case 'compte': vueCompte(); break;
            case 'fiche': vueFiche(Number(param)); break;
            case 'ajouter': vueAjouter(); break;
            case 'notifications': vueNotifications(); break;
            default: setTimeout(() => carte.invalidateSize(), 60);
        }
    }

    function brancherEvenements() {
        $('#chips').addEventListener('click', ev => {
            const b = ev.target.closest('.chip');
            if (!b) return;
            etat.categorie = b.dataset.cat;
            etat.autoSelection = true;
            fermerCarte(false);
            etat.listeMax = 40;
            afficherChips();
            charger();
        });

        const champ = $('#recherche');
        $('#form-recherche').addEventListener('submit', ev => {
            ev.preventDefault();
            etat.recherche = champ.value.trim();
            champ.blur();
            etat.autoSelection = true;
            fermerCarte(false);
            charger({ ajuster: !!etat.recherche });
        });
        champ.addEventListener('input', () => {
            $('#btn-effacer').hidden = !champ.value;
            if (!champ.value && etat.recherche) {
                etat.recherche = '';
                charger();
            }
        });
        $('#btn-effacer').addEventListener('click', () => {
            champ.value = '';
            $('#btn-effacer').hidden = true;
            etat.recherche = '';
            charger();
        });

        // Recherche vocale (Chrome, Edge, Safari récents)
        const Reconnaissance = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (Reconnaissance) {
            const micro = $('#btn-micro');
            micro.hidden = false;
            micro.addEventListener('click', () => {
                const rec = new Reconnaissance();
                rec.lang = 'fr-FR';
                rec.onresult = e => {
                    champ.value = e.results[0][0].transcript;
                    $('#btn-effacer').hidden = false;
                    $('#form-recherche').requestSubmit();
                };
                rec.onend = () => micro.classList.remove('ecoute');
                rec.onerror = () => toast('Je n\'ai pas compris, réessayez', true);
                micro.classList.add('ecoute');
                rec.start();
            });
        }

        $('#btn-localiser').addEventListener('click', () => localiser(true));
        $('#btn-calques').addEventListener('click', () => {
            const clair = $('#carte').classList.toggle('tuiles-claires');
            toast(clair ? 'Carte épurée' : 'Carte détaillée');
        });
        $('#btn-rayon').addEventListener('click', () => {
            etat.rayon = RAYONS[(RAYONS.indexOf(etat.rayon) + 1) % RAYONS.length] || 5;
            $('#rayon-texte').textContent = `${etat.rayon} km`;
            charger();
        });
        $('#btn-zone').addEventListener('click', () => {
            const c = carte.getCenter();
            etat.centre = { lat: c.lat, lng: c.lng };
            etat.autoSelection = true;
            fermerCarte(false);
            charger();
        });
        $('#btn-filtres').addEventListener('click', ouvrirFiltres);

        document.addEventListener('click', async ev => {
            const cible = ev.target.closest('[data-action]');
            if (!cible) return;
            const action = cible.dataset.action;
            if (action === 'fermer-carte') fermerCarte();
            else if (action === 'voir') {
                ev.preventDefault();
                selectionner(Number(cible.dataset.id));
                $('#sheet').scrollTop = 0;
            }
            else if (action === 'retour') history.length > 1 ? history.back() : (location.hash = '#/carte');
            else if (action === 'creneau') {
                etat.creneauChoisi = { date: cible.dataset.date, heure: cible.dataset.heure };
                location.hash = `#/fiche/${cible.dataset.id}`;
            } else if (action === 'elargir') {
                ev.preventDefault();
                etat.rayon = RAYONS.find(r => r > etat.rayon) || etat.rayon;
                $('#rayon-texte').textContent = `${etat.rayon} km`;
                charger();
            } else if (action === 'plus-liste') {
                etat.listeMax += 40;
                afficherListe();
            } else if (action === 'connexion-puis-ajout') {
                etat.apresConnexion = '#/ajouter';
            } else if (action === 'deconnexion') {
                session.fermer();
                majEntete();
                rafraichirNotifications();
                toast('Vous êtes déconnecté(e)');
                vueCompte();
            } else if (action === 'annuler-rdv') {
                if (!confirm('Annuler ce rendez-vous ?')) return;
                try {
                    await api(`/moi/rendez-vous/${cible.dataset.id}/annuler`, { methode: 'POST' });
                    toast('Rendez-vous annulé');
                    vueCompte();
                } catch (err) { toast(err.message, true); }
            } else if (action === 'pro-statut') {
                try {
                    await api(`/pro/rendez-vous/${cible.dataset.id}`, { methode: 'PATCH', corps: { statut: cible.dataset.statut } });
                    toast('Rendez-vous mis à jour');
                    afficherPro();
                } catch (err) { toast(err.message, true); }
            } else if (action === 'partager-code') {
                const user = session.user();
                const texte = `Rejoins-moi sur SantéMap pour trouver les pharmacies, cliniques et hôpitaux autour de toi. Mon code de parrainage : ${user.code_parrainage} — ${location.origin}`;
                if (navigator.share) navigator.share({ title: 'SantéMap', text: texte }).catch(() => {});
                else window.open(`https://wa.me/?text=${encodeURIComponent(texte)}`, '_blank', 'noopener');
            }
        });

        document.addEventListener('sm:deconnexion', () => {
            majEntete();
            $('#btn-notifs .dot').hidden = true;
        });
        window.addEventListener('hashchange', router);
    }

    async function demarrer() {
        try {
            etat.meta = await api('/meta');
        } catch (err) {
            toast(err.message, true);
            return;
        }
        for (const c of etat.meta.categories) etat.categories[c.code] = c;
        etat.centre = { ...etat.meta.pays.centre };
        $('#lieu').textContent = etat.meta.pays.ville;

        initialiserCarte();
        afficherChips();
        afficherBandeauUrgence();
        brancherEvenements();
        majEntete();
        router();
        await charger();
        localiser(false);
        rafraichirNotifications();
    }

    demarrer();
})();
