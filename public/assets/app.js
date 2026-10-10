/* SantéMap — application : carte, liste, fiche, rendez-vous, urgences, compte et contribution */
'use strict';

(() => {
    const { session, api, esc, ic, toast, distance, haversine, jourLisible, jourCourt, dateHeure, initiales, fcfa, dialogue, STATUTS, PLAGES, dateLocale } = SM;

    const RAYONS = [1, 2, 5, 10, 20];
    const LIBELLES_COURTS = { medecin: 'Médecin', laboratoire: 'Laboratoire', imagerie: 'Imagerie', dentiste: 'Dentiste', kine: 'Kiné', bien_etre: 'Spa & massage' };
    const ORDRE_CHIPS = ['tous', 'pharmacie', 'garde', 'hopital', 'clinique', 'medecin', 'laboratoire', 'imagerie', 'dentiste', 'kine', 'bien_etre'];
    const VUES_PLEIN_ECRAN = ['urgences', 'compte', 'fiche', 'rdv', 'ajouter', 'notifications'];

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
        brouillonRdv: null,
        autoSelection: true,
        apresConnexion: null,
        listeMax: 40
    };

    const $ = sel => document.querySelector(sel);
    const vueEl = $('#vue');
    const estMobile = () => window.matchMedia('(max-width: 1023px)').matches;
    let carte, couche, marqueurMoi, carteAjout, carteFiche;
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

    function badgesEtat(e) {
        const b = [];
        if (e.de_garde) b.push('<span class="badge vert">De garde aujourd\'hui</span>');
        else if (e.ouvert_24h) b.push('<span class="badge vert">Ouvert 24h/24</span>');
        if (e.urgences) b.push('<span class="badge rouge">Urgences</span>');
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
        majIcone(precedent);
        majIcone(id);
        const e = etat.resultats.find(x => x.id === id);
        if (!e) return;
        afficherCarte(e);
        if (centrer) centrerSur(e);
    }

    function fermerCarte(manuel = true) {
        const precedent = etat.selection;
        etat.selection = null;
        majIcone(precedent);
        $('#fiche-carte').hidden = true;
        $('#sheet').classList.remove('avec-carte');
        if (manuel) etat.autoSelection = false;
    }

    function afficherCarte(e) {
        const cat = categorie(e.categorie);
        const dist = distanceDe(e);
        const tel = premierTelephone(e.telephone);
        const sous = [e.commune, e.premium ? 'Établissement partenaire' : null, e.verifie ? 'Vérifié' : null].filter(Boolean).join(' • ') || cat.libelle;

        let principal;
        if (e.rdv_actif) principal = `<a class="btn btn-primary" href="#/rdv/${e.id}">${ic('calendar_month')}Prendre RDV</a>`;
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
                <span class="badge">${esc(cat.libelle)}</span>${badgesEtat(e)}
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

    /* ---------- Fiche détaillée ---------- */

    const SOURCES = { osm: 'OpenStreetMap', contribution: 'la communauté SantéMap', demo: 'un exemple de démonstration', admin: 'l\'équipe SantéMap' };
    const RDV_COURT = { en_attente: 'En attente de réponse', confirme: 'Confirmé', refuse: 'Refusé', annule: 'Annulé', termine: 'Terminé', absent: 'Absence constatée' };
    const CANAUX = { whatsapp: ['chat', 'WhatsApp'], sms: ['sms', 'SMS direct'], appel: ['phone_in_talk', 'Appel vocal'] };
    const ICONES_PLAGES = { matin: 'light_mode', midi: 'wb_twilight', apres_midi: 'nights_stay' };

    /** Niveau de vérification : la présence d'une fiche n'est jamais une certification officielle */
    function verification(e) {
        if (e.verifie && e.revendique) return { classe: 'ok', icone: 'verified_user', titre: 'Vérifié par SantéMap • géré par l\'établissement', texte: e.agrement };
        if (e.verifie) return { classe: 'ok', icone: 'verified_user', titre: 'Vérifié par l\'équipe SantéMap', texte: e.agrement };
        if (e.revendique) return { classe: 'ok', icone: 'verified', titre: 'Fiche gérée par l\'établissement', texte: e.agrement || 'Justificatifs contrôlés par l\'équipe SantéMap.' };
        return { classe: 'neutre', icone: 'info', titre: 'Publié, non vérifié', texte: `Informations issues de ${SOURCES[e.source] || 'la communauté'}. Une fiche n'est pas une certification officielle.` };
    }

    function dateLongue(sql) {
        const d = new Date(String(sql).replace(' ', 'T') + 'Z');
        return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    }

    const prixCfa = n => `${Number(n).toLocaleString('fr-FR').replace(/[  ]/g, ' ')} F`;

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
        const v = verification(e);
        const publie = e.statut === 'valide';
        const lieu = [e.adresse, e.quartier && e.commune ? `${e.quartier}, ${e.commune}` : e.quartier || e.commune].filter(Boolean).join(' • ');

        const horaires = e.horaires_detail.length
            ? e.horaires_detail
            : [{ libelle: e.ouvert_24h ? 'Ouvert' : 'Horaires', horaires: e.horaires || (e.ouvert_24h ? '24h / 24' : 'Non renseignés') }];
        const gardes = e.gardes.map(g => `<div class="horaire garde"><span>${ic('nights_stay')}De garde</span><b>${g.debut === g.fin ? esc(jourLisible(g.debut)) : `${esc(jourLisible(g.debut))} → ${esc(jourLisible(g.fin))}`}</b></div>`).join('');

        const tarifs = e.tarifs.length ? e.tarifs : e.prix_consultation ? [{ libelle: 'Consultation', detail: 'à partir de', prix: e.prix_consultation }] : [];
        const photos = e.photos;

        vueEl.innerHTML = `
            <div class="fiche-hero" style="--c:${cat.couleur}">
                ${photos.length
                    ? `<div class="hero-defile" id="hero-defile">${photos.map(p => `<img src="/api/photos/${p}" alt="Photo de ${esc(e.nom)}" loading="lazy">`).join('')}</div>`
                    : ic(cat.icone, 'fill')}
                <button type="button" class="retour" data-action="retour" aria-label="Retour">${ic('arrow_back')}</button>
                ${photos.length && e.verifie ? `<span class="hero-badge">${ic('verified', 'fill')}Photos vérifiées par l'équipe</span>` : ''}
                <div class="hero-bas">
                    <span class="hero-legende">${esc(cat.libelle)}${e.ouvert_24h ? ' • 24h/24' : ''}</span>
                    ${photos.length ? `<span class="hero-compteur" id="hero-compteur">${photos.length > 1 ? `<i class="pt actif"></i>${'<i class="pt"></i>'.repeat(photos.length - 1)}` : ''}<b>${photos.length} vue${photos.length > 1 ? 's' : ''}</b></span>` : ''}
                </div>
            </div>

            <div class="fiche-page">
                ${!publie ? `<p class="erreur">${e.statut === 'refuse' ? `Contribution non retenue : ${esc(e.motif_refus || '')}` : 'En attente de vérification par l\'équipe : cette fiche n\'est pas encore publique.'}</p>` : ''}
                <section class="bloc fiche-tete">
                    <div class="badges"><span class="badge">${esc(cat.libelle)}</span>${e.premium ? '<span class="badge or">Partenaire</span>' : ''}${badgesEtat(e)}</div>
                    <h1>${esc(e.nom)}</h1>
                    <p class="fiche-adresse">${ic('location_on')}<span>${esc(lieu || 'Adresse non renseignée')}${dist != null ? ` • à ${distance(dist)} de vous` : ''}</span></p>
                    ${e.description ? `<p class="intro">${esc(e.description)}</p>` : ''}

                    <div class="verif ${v.classe}">
                        ${ic(v.icone, 'fill')}
                        <div><b>${esc(v.titre)}</b>${v.texte ? `<small>${esc(v.texte)}</small>` : ''}</div>
                    </div>

                    <div class="actions-grille">
                        ${tel ? `<a class="btn btn-vert" href="tel:${esc(tel)}">${ic('call')}Appeler</a>` : `<span class="btn btn-ligne desactive">${ic('call')}Pas de numéro</span>`}
                        <a class="btn btn-ligne" href="${itineraire(e)}" target="_blank" rel="noopener">${ic('directions')}Itinéraire GPS</a>
                        ${e.rdv_actif && publie ? `<a class="btn btn-teal" href="#/rdv/${e.id}">${ic('calendar_month')}Prendre RDV</a>` : `<button type="button" class="btn btn-ligne" data-action="partager">${ic('share')}Partager</button>`}
                        ${publie ? `<button type="button" class="btn btn-alerte" data-action="signaler">${ic('flag')}Signaler erreur</button>` : ''}
                    </div>
                    ${e.telephone && e.telephone.includes('/') ? `<p class="note">${e.telephone.split('/').map(t => `<a href="tel:${esc(premierTelephone(t))}">${esc(t.trim())}</a>`).join(' • ')}</p>` : ''}
                </section>

                <section class="bloc">
                    <h2>${ic('schedule')}Horaires d'accueil</h2>
                    ${horaires.map((h, i) => `<div class="horaire"><span><i class="pastille p${i % 3}"></i>${esc(h.libelle)}</span><b>${esc(h.horaires)}</b></div>`).join('')}
                    ${gardes}
                </section>

                ${e.services.length ? `<section class="bloc">
                    <h2>${ic('health_and_safety')}Spécialités disponibles<small>${e.services.length} pôle${e.services.length > 1 ? 's' : ''}</small></h2>
                    <div class="specialites">${e.services.map(s => `<span class="specialite">${ic('stethoscope')}${esc(s)}</span>`).join('')}</div>
                </section>` : ''}

                ${tarifs.length ? `<section class="bloc">
                    <h2>${ic('payments')}Tarifs indicatifs déclarés<small>En francs CFA</small></h2>
                    ${tarifs.map(t => `<div class="tarif"><div><b>${esc(t.libelle)}</b>${t.detail ? `<small>${esc(t.detail)}</small>` : ''}</div><span>${esc(prixCfa(t.prix))}</span></div>`).join('')}
                    ${e.assurances ? `<div class="assurances">${ic('credit_card')}<span>Prise en charge acceptée : ${esc(e.assurances)}</span></div>` : ''}
                    <p class="note">Tarifs communiqués par l'établissement, à confirmer sur place.</p>
                </section>` : ''}

                <section class="bloc">
                    <h2>${ic('map')}Localisation &amp; repères<small>${esc(e.quartier || e.commune || '')}</small></h2>
                    <div class="mini-carte-zone"><div id="mini-carte"></div>${e.adresse ? `<span class="mini-repere">${ic('pin_drop')}${esc(e.adresse)}</span>` : ''}</div>
                    ${e.site_web ? `<p class="note">${ic('language')} <a href="${esc(/^https?:\/\//.test(e.site_web) ? e.site_web : 'https://' + e.site_web)}" target="_blank" rel="noopener nofollow">${esc(e.site_web)}</a></p>` : ''}
                </section>

                ${publie && !e.revendique ? `<section class="bloc revendiquer">
                    <div class="revendiquer-haut">${ic('workspace_premium', 'fill')}<h2>Vous êtes le gérant ou le responsable ?</h2></div>
                    <p>Mettez à jour vos horaires, vos spécialités et vos tarifs, et recevez les demandes de rendez-vous. L'équipe contrôle vos justificatifs avant de vous donner accès à la fiche.</p>
                    <button type="button" class="btn btn-vert" data-action="revendiquer">${ic('verified_user')}Revendiquer cette fiche</button>
                </section>` : ''}

                <p class="maj">${ic('history')}<span>${e.mis_a_jour ? `Dernière mise à jour : <b>${esc(dateLongue(e.mis_a_jour))}</b> • ` : ''}Source : ${esc(SOURCES[e.source] || 'équipe SantéMap')}</span></p>
            </div>`;

        vueEl.querySelector('[data-action="partager"]')?.addEventListener('click', () => partager(e));
        vueEl.querySelector('[data-action="signaler"]')?.addEventListener('click', () => signaler(e));
        vueEl.querySelector('[data-action="revendiquer"]')?.addEventListener('click', () => revendiquer(e));

        const defile = vueEl.querySelector('#hero-defile');
        if (defile && photos.length > 1) {
            defile.addEventListener('scroll', () => {
                const i = Math.round(defile.scrollLeft / defile.clientWidth);
                vueEl.querySelectorAll('#hero-compteur .pt').forEach((p, n) => p.classList.toggle('actif', n === i));
            }, { passive: true });
        }

        // Petite carte, sans interaction : un repère sur l'établissement
        carteFiche = L.map('mini-carte', { zoomControl: false, dragging: false, scrollWheelZoom: false, touchZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false })
            .setView([e.lat, e.lng], 16);
        carteFiche.attributionControl.setPrefix(false);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' }).addTo(carteFiche);
        L.marker([e.lat, e.lng], { icon: icone(e, false), interactive: false }).addTo(carteFiche);
    }

    /** Demande de gestion d'une fiche : l'équipe contrôle les justificatifs avant tout accès */
    function revendiquer(e) {
        if (!session.jeton()) {
            etat.apresConnexion = location.hash;
            toast('Connectez-vous pour revendiquer une fiche');
            location.hash = '#/compte';
            return;
        }
        const user = session.user();
        const { el, fermer } = dialogue(`
            <h3>Revendiquer « ${esc(e.nom)} »</h3>
            <p class="note">Réservé au gérant ou au responsable médical. Vos justificatifs ne sont vus que par l'équipe SantéMap.</p>
            <form class="form">
                <div class="champ"><label for="rv-nom">Votre nom</label><input class="input" id="rv-nom" value="${esc(user?.nom || '')}" required maxlength="100"></div>
                <div class="champ"><label for="rv-fonction">Votre fonction</label><input class="input" id="rv-fonction" placeholder="Ex. pharmacien titulaire, directeur" required maxlength="100"></div>
                <div class="champ"><label for="rv-tel">Téléphone pour vous rappeler</label><input class="input" id="rv-tel" type="tel" inputmode="tel" value="${esc(user?.telephone || '')}" required></div>
                <div class="champ"><label for="rv-justif">Numéro d'ordre, de licence ou d'agrément</label><input class="input" id="rv-justif" required maxlength="255"></div>
                <div class="champ"><label for="rv-piece">Photo du document <small>(facultatif)</small></label><input class="input" id="rv-piece" type="file" accept="image/*"></div>
                <p class="erreur" hidden></p>
                <div class="actions"><button type="button" class="btn btn-ligne" data-fermer>Annuler</button><button class="btn btn-primary" type="submit">Envoyer</button></div>
            </form>`);
        el.querySelector('form').addEventListener('submit', async ev => {
            ev.preventDefault();
            const erreur = el.querySelector('.erreur');
            erreur.hidden = true;
            try {
                const fichier = el.querySelector('#rv-piece').files[0];
                const res = await api('/moi/revendications', {
                    methode: 'POST',
                    corps: {
                        etablissement_id: e.id,
                        nom: el.querySelector('#rv-nom').value,
                        fonction: el.querySelector('#rv-fonction').value,
                        telephone: el.querySelector('#rv-tel').value,
                        justificatif: el.querySelector('#rv-justif').value,
                        piece: fichier ? await redimensionner(fichier) : undefined
                    }
                });
                fermer();
                toast(res.message);
            } catch (err) {
                erreur.textContent = err.message;
                erreur.hidden = false;
            }
        });
    }

    /* ---------- Demande de rendez-vous ---------- */

    const quandRdv = r => (r.plage ? `${jourLisible(String(r.debut).slice(0, 10))} • ${PLAGES[r.plage]}` : dateHeure(r.debut));

    function carteDemarche(r) {
        const relancer = ['en_attente', 'confirme'].includes(r.statut) && r.telephone;
        return `<div class="demarche">
            <div class="demarche-haut"><b>${esc(r.etablissement)}</b><span class="pastille-statut ${r.statut}">${ic({ en_attente: 'hourglass_top', confirme: 'check_circle', refuse: 'close', annule: 'close', termine: 'check', absent: 'error' }[r.statut], 'fill')}${esc(RDV_COURT[r.statut])}</span></div>
            <p>${ic('event_available')}${esc(quandRdv(r))}${r.service ? ` • ${esc(r.service)}` : ''}</p>
            ${r.message ? `<p class="note">« ${esc(r.message)} »</p>` : ''}
            <div class="demarche-bas"><span>${ic('location_on')}${esc(r.quartier || r.commune || '')}</span>
                <a href="#/fiche/${r.etablissement_id}">Détails ${ic('chevron_right')}</a>
                ${relancer && r.statut === 'en_attente' ? `<a href="tel:${esc(premierTelephone(r.telephone))}">Relancer ${ic('replay')}</a>` : ''}</div>
        </div>`;
    }

    async function vueRdv(id) {
        vueEl.innerHTML = chargement();
        let e, jours = [];
        try {
            e = await api(`/etablissements/${id}`);
        } catch (err) {
            vueEl.innerHTML = `<div class="vue-contenu"><button type="button" class="retour" data-action="retour">${ic('arrow_back')}Retour</button>${vide('error', err.message)}</div>`;
            return;
        }
        if (location.hash !== `#/rdv/${id}`) return;
        const retour = `<button type="button" class="retour" data-action="retour">${ic('arrow_back')}Retour</button>`;
        if (!e.rdv_actif || e.statut !== 'valide') {
            const tel = premierTelephone(e.telephone);
            vueEl.innerHTML = `<div class="vue-contenu">${retour}${vide('event_available', 'Cet établissement ne propose pas encore la demande de rendez-vous en ligne.')}
                <div class="actions">${tel ? `<a class="btn btn-primary" href="tel:${esc(tel)}">${ic('call')}Appeler</a>` : ''}<a class="btn btn-ligne" href="#/fiche/${e.id}">Voir la fiche</a></div></div>`;
            return;
        }
        try { jours = (await api(`/etablissements/${id}/disponibilites`)).jours; } catch { /* la page indique qu'aucun jour n'est proposé */ }

        const cat = categorie(e.categorie);
        const user = session.user();
        const dist = distanceDe(e);
        const brouillon = etat.brouillonRdv?.id === id ? etat.brouillonRdv : {};
        etat.brouillonRdv = null;
        const choix = { date: brouillon.date || jours[0]?.date, plage: brouillon.plage || null, canal: brouillon.canal || 'whatsapp' };
        const plagesDuJour = () => jours.find(j => j.date === choix.date)?.plages || [];
        if (!plagesDuJour().includes(choix.plage)) choix.plage = plagesDuJour()[0] || null;

        vueEl.innerHTML = `<div class="vue-contenu rdv">
            ${retour}
            <section class="bloc rdv-etab">
                <div class="rdv-etab-haut"><span class="badge vert">${e.verifie ? 'ÉTABLISSEMENT VÉRIFIÉ' : 'ÉTABLISSEMENT'}</span>${dist != null ? `<span class="rdv-distance">${ic('location_on')}${distance(dist)}</span>` : ''}</div>
                <div class="rdv-etab-nom"><span class="rdv-icone" style="--c:${cat.couleur}">${ic(cat.icone, 'fill')}</span>
                    <div><h1>${esc(e.nom)}</h1><p>${ic('location_on')}${esc([e.quartier || e.commune, e.adresse].filter(Boolean).join(' • ') || 'Adresse non renseignée')}</p></div></div>
            </section>

            <div class="info-privee">${ic('lock')}<div><b>Prise de contact directe et confidentielle</b>
                <p>Cette demande est transmise à l'accueil de l'établissement. <b>Ce n'est pas une réservation</b> : votre rendez-vous n'est effectif qu'après sa confirmation. Aucun dossier médical ni diagnostic n'est conservé sur nos serveurs.</p></div></div>

            <form class="form" id="form-rdv" novalidate>
                <section class="bloc etape">
                    <h2><span class="num">1</span>Service ou praticien souhaité</h2>
                    <p class="note">Sélectionnez le motif de consultation pour orienter le secrétariat.</p>
                    <div class="select-zone"><select class="input" id="rdv-service">
                        <option value="">${e.services.length ? 'Choisissez une spécialité médicale…' : 'Consultation (motif précisé à l\'accueil)'}</option>
                        ${e.services.map(s => `<option ${brouillon.service === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
                    </select>${ic('expand_more')}</div>
                </section>

                <section class="bloc etape">
                    <h2><span class="num">2</span>Date &amp; plage horaire</h2>
                    ${jours.length ? `
                    <p class="label">Jour proposé :</p>
                    <div class="jours-rdv" id="jours-rdv">${jours.map(j => { const c = jourCourt(j.date); return `<button type="button" class="jour-rdv${j.date === choix.date ? ' active' : ''}" data-date="${j.date}"><b>${esc(c.titre)}</b><span>${esc(c.sous)}</span></button>`; }).join('')}</div>
                    <p class="label">Créneau de disponibilité :</p>
                    <div class="plages" id="plages"></div>` : '<p class="erreur">Aucun jour de consultation n\'est disponible dans les 14 prochains jours : contactez l\'établissement par téléphone.</p>'}
                </section>

                <section class="bloc etape">
                    <h2><span class="num">3</span>Coordonnées du patient</h2>
                    <div class="champ"><label for="rdv-nom">Nom et prénom</label>
                        <div class="champ-icone">${ic('person')}<input class="input" id="rdv-nom" placeholder="Ex. Aminata Touré" value="${esc(brouillon.nom || user?.nom || '')}" maxlength="100" autocomplete="name"></div></div>
                    <div class="champ"><label for="rdv-tel">Téléphone mobile (${esc(etat.meta.pays.nom)})</label>
                        <div class="champ-icone prefixe"><span class="indicatif">+225</span><input class="input" id="rdv-tel" type="tel" inputmode="tel" placeholder="07 00 12 34 56" value="${esc(brouillon.telephone || user?.telephone || '')}" autocomplete="tel"></div>
                        <small>Compatible Orange, MTN, Moov, Wave</small></div>
                    <div class="champ"><span class="label">Canal de confirmation souhaité :</span>
                        <div class="canaux" id="canaux">${Object.entries(CANAUX).map(([code, [icone, libelle]]) => `<button type="button" class="canal${code === choix.canal ? ' active' : ''}" data-canal="${code}">${ic(icone, 'fill')}${libelle}</button>`).join('')}</div></div>
                </section>

                <p class="erreur" id="rdv-erreur" hidden></p>
                <button class="btn btn-vert grand" type="submit" ${jours.length ? '' : 'disabled'}>${ic('send')}Envoyer ma demande de créneau</button>
                <p class="note centre">${ic('verified_user')} Gratuit • Sans engagement financier</p>
            </form>

            <div id="rdv-recents"></div>
        </div>`;

        const zonePlages = vueEl.querySelector('#plages');
        function afficherPlages() {
            if (!zonePlages) return;
            const dispo = plagesDuJour();
            zonePlages.innerHTML = Object.entries(etat.meta.plages).map(([code, p]) => `
                <label class="plage${dispo.includes(code) ? '' : ' fermee'}">
                    ${ic(ICONES_PLAGES[code])}
                    <span><b>${esc(p.libelle)}</b><small>${p.debut.replace(':', 'h')} — ${p.fin.replace(':', 'h')}${dispo.includes(code) ? '' : ' • indisponible'}</small></span>
                    <input type="radio" name="plage" value="${code}" ${choix.plage === code ? 'checked' : ''} ${dispo.includes(code) ? '' : 'disabled'}>
                </label>`).join('');
        }
        afficherPlages();

        vueEl.querySelector('#jours-rdv')?.addEventListener('click', ev => {
            const b = ev.target.closest('.jour-rdv');
            if (!b) return;
            choix.date = b.dataset.date;
            if (!plagesDuJour().includes(choix.plage)) choix.plage = plagesDuJour()[0] || null;
            vueEl.querySelectorAll('.jour-rdv').forEach(x => x.classList.toggle('active', x === b));
            afficherPlages();
        });
        zonePlages?.addEventListener('change', ev => { choix.plage = ev.target.value; });
        vueEl.querySelector('#canaux').addEventListener('click', ev => {
            const b = ev.target.closest('.canal');
            if (!b) return;
            choix.canal = b.dataset.canal;
            vueEl.querySelectorAll('.canal').forEach(x => x.classList.toggle('active', x === b));
        });

        const afficherRecents = async () => {
            const zone = vueEl.querySelector('#rdv-recents');
            if (!zone || !session.jeton()) return;
            try {
                const t = await api('/moi/tableau');
                const liste = t.rendez_vous.slice(0, 4);
                const actives = t.rendez_vous.filter(r => ['en_attente', 'confirme'].includes(r.statut)).length;
                if (zone.isConnected && liste.length) {
                    zone.innerHTML = `<h2 class="section-titre">${ic('history')}Mes démarches récentes<span class="compte-actives">${actives} active${actives > 1 ? 's' : ''}</span></h2>${liste.map(carteDemarche).join('')}`;
                }
            } catch { /* liste facultative */ }
        };
        afficherRecents();

        const form = vueEl.querySelector('#form-rdv');
        form.addEventListener('submit', async ev => {
            ev.preventDefault();
            const erreur = vueEl.querySelector('#rdv-erreur');
            erreur.hidden = true;
            const corps = {
                etablissement_id: e.id,
                date: choix.date,
                plage: choix.plage,
                service: vueEl.querySelector('#rdv-service').value,
                nom_patient: vueEl.querySelector('#rdv-nom').value.trim(),
                telephone: vueEl.querySelector('#rdv-tel').value,
                canal: choix.canal
            };
            const probleme = e.services.length && !corps.service ? 'Choisissez le service ou la spécialité souhaitée'
                : !corps.plage ? 'Choisissez un jour et une plage horaire'
                : !corps.nom_patient ? 'Indiquez le nom du patient'
                : (corps.telephone.replace(/\D/g, '').length < 8) ? 'Indiquez un numéro de téléphone valide' : null;
            if (probleme) {
                erreur.textContent = probleme;
                erreur.hidden = false;
                return;
            }
            if (!session.jeton()) {
                etat.apresConnexion = location.hash;
                etat.brouillonRdv = { id, date: corps.date, plage: corps.plage, canal: corps.canal, service: corps.service, nom: corps.nom_patient, telephone: corps.telephone };
                toast('Connectez-vous pour envoyer votre demande');
                location.hash = '#/compte';
                return;
            }
            const bouton = form.querySelector('button[type="submit"]');
            bouton.disabled = true;
            try {
                const rdv = await api('/moi/rendez-vous', { methode: 'POST', corps });
                const [, libelleCanal] = CANAUX[corps.canal];
                form.outerHTML = `<div class="bloc rdv-envoye">${ic('hourglass_top', 'fill')}
                    <h2>Demande envoyée</h2>
                    <p><b>${esc(jourLisible(corps.date))} • ${esc(PLAGES[corps.plage])}</b> chez ${esc(e.nom)}. Référence <b>${esc(rdv.reference)}</b>.</p>
                    <p>Ce n'est pas encore une réservation : l'établissement doit la confirmer. Il vous répond par ${esc(libelleCanal)} et vous le voyez ici et dans vos notifications.</p>
                    <a class="btn btn-ligne" href="#/carte">Retour à la carte</a></div>`;
                rafraichirNotifications();
                afficherRecents();
            } catch (err) {
                erreur.textContent = err.message;
                erreur.hidden = false;
                bouton.disabled = false;
            }
        });
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

    /** Carte des points : niveau, équivalent en crédit, recharges possibles */
    function htmlCredit(u, palier, budget) {
        const { actuel, suivant } = palier;
        const base = actuel?.seuil || 0;
        const progression = suivant ? Math.round(((u.points - base) / (suivant.seuil - base)) * 100) : 100;
        const offres = etat.meta.echanges;
        const minimum = Math.min(...offres.map(o => o.points));
        const sigles = { orange: 'OG', mtn: 'MTN', moov: 'MA', internet: '10Go' };
        const epuise = budget?.restant !== null && budget?.restant !== undefined && budget.restant < minimum * 5;
        return `<section class="credit">
            <div class="credit-haut">
                <span class="credit-etiquette">${ic('verified_user', 'fill')}COMPTE CITOYEN ENGAGÉ</span>
                ${actuel ? `<span class="niveau">${ic('workspace_premium', 'fill')}Niveau ${actuel.niveau} : ${esc(actuel.nom)}</span>` : ''}
            </div>
            <div class="credit-corps">
                <div><span class="credit-points">${u.points}</span><span class="credit-unite"> pts</span>
                    <p>${ic('payments')}<span>Équivalent <b>${esc(fcfa(u.points * 5))}</b> de recharge mobile</span></p></div>
                ${suivant ? `<small class="credit-reste">+${suivant.seuil - u.points} vers Niv. ${suivant.niveau}</small>` : ''}
            </div>
            <div class="jauge"><div style="width:${Math.max(4, Math.min(progression, 100))}%"></div></div>
            <p class="note">${suivant ? `Prochain niveau : <b>${esc(suivant.nom)}</b> (${suivant.seuil} pts)` : 'Vous avez atteint le niveau le plus haut, bravo !'}</p>
            <div class="recharges-titre"><span>RECHARGES TÉLÉCOMS</span><span>Dès ${minimum} pts</span></div>
            <div class="offres">${offres.map(o => `
                <button type="button" class="offre${u.points >= o.points ? '' : ' grise'}" data-action="echanger" data-offre="${o.code}">
                    <span class="operateur ${o.code}">${sigles[o.code] || ''}</span>
                    <span><b>${esc(o.libelle)}</b><small>${esc(o.detail)} (${o.points} pts)</small></span>
                </button>`).join('')}</div>
            <button type="button" class="btn btn-vert grand" data-action="echanger"${u.points < minimum || epuise ? ' disabled' : ''}>${ic('swap_horiz')}Échanger mes ${u.points} points en crédit</button>
            ${epuise ? '<p class="erreur">Le budget de récompenses de ce mois est épuisé : revenez le mois prochain, vos points sont conservés.</p>' : ''}
            <p class="note">1 point = ${esc(fcfa(5))} de crédit. L'équipe effectue la recharge sous 48 h ; les barèmes peuvent évoluer.</p>
        </section>`;
    }

    function ouvrirEchange(offrePreferee) {
        const user = session.user();
        const points = user?.points || 0;
        const { el, fermer } = dialogue(`
            <h3>Échanger mes points</h3>
            <p class="note">Vous avez <b>${points} points</b>. Choisissez une offre : les points sont débités tout de suite.</p>
            <form class="form">
                <div class="choix-offres">${etat.meta.echanges.map((o, i) => {
                    const possible = points >= o.points;
                    return `<label class="choix-offre${possible ? '' : ' grise'}"><input type="radio" name="offre" value="${o.code}" ${possible && (o.code === offrePreferee || (!offrePreferee && i === 0)) ? 'checked' : ''} ${possible ? '' : 'disabled'}>
                        <span><b>${esc(o.libelle)}</b><small>${esc(o.detail)}</small></span><em>${o.points} pts</em></label>`;
                }).join('')}</div>
                <div class="champ"><label for="ec-tel">Numéro à recharger</label><input class="input" id="ec-tel" type="tel" inputmode="tel" value="${esc(user?.telephone || '')}" required></div>
                <p class="erreur" hidden></p>
                <div class="actions"><button type="button" class="btn btn-ligne" data-fermer>Annuler</button><button class="btn btn-primary" type="submit">Confirmer l'échange</button></div>
            </form>`);
        el.querySelector('form').addEventListener('submit', async ev => {
            ev.preventDefault();
            const erreur = el.querySelector('.erreur');
            erreur.hidden = true;
            const choix = el.querySelector('input[name="offre"]:checked');
            if (!choix) {
                erreur.textContent = 'Vous n\'avez pas encore assez de points pour une offre : continuez à contribuer !';
                erreur.hidden = false;
                return;
            }
            try {
                const res = await api('/moi/echanges', { methode: 'POST', corps: { offre: choix.value, telephone: el.querySelector('#ec-tel').value } });
                fermer();
                toast(res.message);
                router();
            } catch (err) {
                erreur.textContent = err.message;
                erreur.hidden = false;
            }
        });
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
        const roles = { admin: 'Équipe SantéMap', etablissement: 'Compte établissement', utilisateur: 'Membre' };

        vueEl.innerHTML = `<div class="vue-contenu">
            <div class="profil">
                <span class="avatar">${esc(initiales(u.nom))}</span>
                <div><b>${esc(u.nom)}</b><small>${esc(roles[u.role])}${u.telephone ? ` • ${esc(u.telephone)}` : ''}</small></div>
            </div>

            ${htmlCredit(u, t.palier, t.budget)}
            <div class="points sans-bordure">
                <ul class="regles">
                    <li><b>+${etat.meta.points.CONTRIBUTION}</b> par établissement ajouté et validé</li>
                    <li><b>+${etat.meta.points.PHOTO}</b> si vous ajoutez une photo de la devanture</li>
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
                ${u.role === 'etablissement' ? `<button type="button" data-action="modifier-fiche">${ic('edit')}Modifier la fiche de mon établissement</button>` : ''}
                ${u.role === 'admin' ? `<a href="/admin.html">${ic('admin_panel_settings')}Administration${ic('chevron_right', 'fin')}</a>` : ''}
                <button type="button" data-action="deconnexion">${ic('logout')}Se déconnecter</button>
            </div>

            ${u.role === 'etablissement' ? '<h2 class="section">Rendez-vous de mon établissement</h2><div id="pro">' + chargement() + '</div>' : ''}

            <h2 class="section">Mes rendez-vous</h2>
            ${t.rendez_vous.length ? t.rendez_vous.map(r => `
                <div class="demarche">
                    <div class="demarche-haut"><b>${esc(r.etablissement)}</b><span class="pastille-statut ${r.statut}">${esc(RDV_COURT[r.statut])}</span></div>
                    <p>${ic('event_available')}${esc(quandRdv(r))} • réf. ${esc(r.reference)}${r.service ? ` • ${esc(r.service)}` : r.motif ? ` • ${esc(r.motif)}` : ''}</p>
                    ${r.statut === 'en_attente' ? '<p class="note">Demande envoyée : ce n\'est pas encore une réservation confirmée.</p>' : ''}
                    ${r.message ? `<p class="note">« ${esc(r.message)} »</p>` : ''}
                    ${['en_attente', 'confirme'].includes(r.statut) && r.debut.slice(0, 10) >= dateLocale() ? `<div class="actions"><a class="btn btn-ligne btn-petit" href="#/fiche/${r.etablissement_id}">Voir la fiche</a><button type="button" class="btn btn-ligne btn-petit" data-action="annuler-rdv" data-id="${r.id}">Annuler</button></div>` : ''}
                </div>`).join('') : '<p class="note">Aucun rendez-vous pour le moment. Les établissements partenaires proposent la demande de rendez-vous depuis leur fiche.</p>'}

            ${t.echanges.length ? `<h2 class="section">Mes échanges de points</h2>${t.echanges.map(x => `
                <div class="element"><div class="element-haut"><b>${esc(x.libelle)}</b><span class="statut ${x.statut === 'effectue' ? 'valide' : x.statut === 'refuse' ? 'refuse' : 'en_attente'}">${{ demande: 'Demandé', effectue: 'Effectué', refuse: 'Refusé' }[x.statut]}</span></div>
                    <p>${x.points} points • ${esc(dateLongue(x.created_at))}</p></div>`).join('')}` : ''}

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
                <div class="demarche">
                    <div class="demarche-haut"><b>${esc(r.patient)}</b><span class="pastille-statut ${r.statut}">${esc(RDV_COURT[r.statut])}</span></div>
                    <p>${ic('event_available')}${esc(quandRdv(r))}${r.service ? ` • ${esc(r.service)}` : ''}</p>
                    <p>${ic('call')}<a href="tel:${esc(r.telephone)}">${esc(r.telephone)}</a>${r.canal ? ` • confirmer par ${esc(CANAUX[r.canal][1])}` : ''} • réf. ${esc(r.reference)}</p>
                    ${['en_attente', 'confirme'].includes(r.statut) ? `<div class="actions">
                        ${r.statut === 'en_attente'
                            ? `<button type="button" class="btn btn-primary btn-petit" data-action="pro-statut" data-id="${r.id}" data-statut="confirme">Accepter</button>
                               <button type="button" class="btn btn-ligne btn-petit" data-action="pro-statut" data-id="${r.id}" data-statut="refuse">Refuser</button>`
                            : `<button type="button" class="btn btn-ligne btn-petit" data-action="pro-statut" data-id="${r.id}" data-statut="termine">Terminé</button>
                               <button type="button" class="btn btn-ligne btn-petit" data-action="pro-statut" data-id="${r.id}" data-statut="absent">Absent</button>`}
                        <button type="button" class="btn btn-ligne btn-petit" data-action="pro-statut" data-id="${r.id}" data-statut="annule">Annuler</button></div>` : ''}
                </div>`).join('') : '<p class="note">Aucun rendez-vous à venir.</p>');
        } catch (err) {
            el.innerHTML = `<p class="erreur">${esc(err.message)}</p>`;
        }
    }

    /** Un établissement vérifié met à jour lui-même ses informations (le nom et la position restent à l'équipe) */
    async function modifierFiche() {
        let f;
        try {
            f = await api('/pro/fiche');
        } catch (err) {
            return toast(err.message, true);
        }
        let horaires = [];
        let tarifs = [];
        try { horaires = JSON.parse(f.horaires_detail || '[]'); tarifs = JSON.parse(f.tarifs || '[]'); } catch { /* champs vides */ }
        const { el, fermer } = dialogue(`
            <h3>${esc(f.nom)}</h3>
            <form class="form">
                <div class="champ"><label for="mf-tel">Téléphone</label><input class="input" id="mf-tel" value="${esc(f.telephone || '')}" maxlength="60"></div>
                <div class="champ"><label for="mf-adresse">Repère visuel</label><input class="input" id="mf-adresse" value="${esc(f.adresse || '')}" maxlength="255"></div>
                <div class="champ"><label for="mf-quartier">Quartier</label><input class="input" id="mf-quartier" value="${esc(f.quartier || '')}" maxlength="100"></div>
                <div class="champ"><label for="mf-horaires">Horaires (résumé)</label><input class="input" id="mf-horaires" value="${esc(f.horaires || '')}" maxlength="255"></div>
                <div class="champ"><label for="mf-detail">Horaires par service <small>(un par ligne : Service | horaires)</small></label>
                    <textarea class="input" id="mf-detail" placeholder="Urgences | 24h / 24 • 7j / 7">${esc(horaires.map(h => `${h.libelle} | ${h.horaires}`).join('\n'))}</textarea></div>
                <div class="champ"><label for="mf-tarifs">Tarifs indicatifs <small>(un par ligne : Prestation | précision | prix en FCFA)</small></label>
                    <textarea class="input" id="mf-tarifs" placeholder="Consultation générale | Heures de jour | 15000">${esc(tarifs.map(x => `${x.libelle} | ${x.detail || ''} | ${x.prix}`).join('\n'))}</textarea>
                    ${f.premium ? '' : '<small>Les tarifs et assurances ne s\'affichent que sur les fiches partenaires.</small>'}</div>
                <div class="champ"><label for="mf-assurances">Assurances et moyens de paiement</label><input class="input" id="mf-assurances" value="${esc(f.assurances || '')}" maxlength="255"></div>
                <div class="champ"><label for="mf-description">Description</label><textarea class="input" id="mf-description" maxlength="2000">${esc(f.description || '')}</textarea></div>
                <p class="erreur" hidden></p>
                <div class="actions"><button type="button" class="btn btn-ligne" data-fermer>Annuler</button><button class="btn btn-primary" type="submit">Enregistrer</button></div>
            </form>`);
        el.querySelector('form').addEventListener('submit', async ev => {
            ev.preventDefault();
            const lignes = id => el.querySelector(id).value.split('\n').map(l => l.split('|').map(x => x.trim())).filter(l => l[0]);
            try {
                await api('/pro/fiche', {
                    methode: 'PATCH',
                    corps: {
                        telephone: el.querySelector('#mf-tel').value,
                        adresse: el.querySelector('#mf-adresse').value,
                        quartier: el.querySelector('#mf-quartier').value,
                        horaires: el.querySelector('#mf-horaires').value,
                        description: el.querySelector('#mf-description').value,
                        assurances: el.querySelector('#mf-assurances').value,
                        horaires_detail: lignes('#mf-detail').map(([libelle, h]) => ({ libelle, horaires: h })),
                        tarifs: lignes('#mf-tarifs').map(([libelle, detail, prix]) => ({ libelle, detail, prix: Number(String(prix).replace(/\D/g, '')) }))
                    }
                });
                fermer();
                toast('Fiche mise à jour');
            } catch (err) {
                const erreur = el.querySelector('.erreur');
                erreur.textContent = err.message;
                erreur.hidden = false;
            }
        });
    }

    /* ---------- Ajouter un établissement ---------- */

    function vueAjouter() {
        if (!session.jeton()) {
            vueEl.innerHTML = `<div class="vue-contenu">
                <button type="button" class="retour" data-action="retour">${ic('arrow_back')}Retour</button>
                <h1>Ajouter un établissement</h1>
                <p class="intro">Une pharmacie, une clinique ou un laboratoire manque sur la carte ? Connectez-vous pour l'ajouter : chaque ajout validé vous rapporte des points, échangeables contre du crédit téléphonique.</p>
                <a class="btn btn-primary" href="#/compte" data-action="connexion-puis-ajout">Se connecter ou créer un compte</a>
            </div>`;
            return;
        }
        const pts = etat.meta.points;
        const ptsNom = Math.round(pts.CONTRIBUTION * 0.4);
        const ptsPosition = pts.CONTRIBUTION - ptsNom;
        const stats = etat.meta.stats;
        const choix = { categorie: '', positionChoisie: false, photo: null, nomPhoto: '' };

        vueEl.innerHTML = `<div class="vue-contenu ajout">
            <div id="zone-credit"></div>
            <div class="stats-bandeau">${ic('groups')}<div><b>${stats.etablissements.toLocaleString('fr-FR')} structures répertoriées</b>
                <span>${stats.contributeurs ? `Grâce à ${stats.contributeurs.toLocaleString('fr-FR')} contributeur${stats.contributeurs > 1 ? 's' : ''} et à OpenStreetMap` : 'Grâce à OpenStreetMap et à la communauté'} en ${esc(etat.meta.pays.nom)}.</span></div></div>

            <h1 class="titre-ajout">${ic('add_location_alt')}Ajouter un établissement ou signaler une garde</h1>
            <p class="intro">Aidez vos voisins de ${esc(etat.meta.pays.ville)} à trouver un secours fiable en moins de 3 minutes.</p>

            <form class="form" id="form-ajout" novalidate>
                <div class="champ"><label for="aj-nom"><span>Nom de l'établissement *</span><em class="pts">+${ptsNom} pts</em></label>
                    <div class="champ-icone fin">${ic('check_circle', 'fill ok')}<input class="input" id="aj-nom" maxlength="200" placeholder="Ex. Pharmacie Sainte-Marie" required autocomplete="off"></div>
                    <div id="alerte-doublon"></div></div>

                <div class="champ"><span class="label"><span>Catégorie du lieu *</span><em class="obligatoire">Obligatoire</em></span>
                    <div class="categories" id="aj-categories" role="radiogroup" aria-label="Catégorie">${etat.meta.categories.map(c =>
                        `<button type="button" class="categorie-choix" role="radio" aria-checked="false" data-cat="${c.code}">${ic(c.icone)}${esc(c.libelle)}</button>`).join('')}</div></div>

                <label class="garde-case" id="garde-zone" hidden>
                    <span class="garde-icone">${ic('nights_stay', 'fill')}</span>
                    <span><b>Pharmacie de garde cette semaine</b><small>Elle apparaît comme « de garde » sur la carte dès la validation.</small></span>
                    <input type="checkbox" id="aj-garde">
                </label>

                <div class="deux">
                    <div class="champ"><label for="aj-commune">Commune *</label>
                        <input class="input" id="aj-commune" list="communes" maxlength="100" placeholder="Ex. Cocody" required autocomplete="off">
                        <datalist id="communes">${(etat.meta.pays.communes || []).map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>
                    <div class="champ"><label for="aj-quartier">Quartier *</label><input class="input" id="aj-quartier" maxlength="100" placeholder="Ex. Angré 8e Tranche" required></div>
                </div>

                <div class="champ"><label for="aj-adresse"><span>Repère visuel &amp; position *</span><em class="pts">+${ptsPosition} pts</em></label>
                    <button type="button" class="btn btn-gps" id="ajout-gps">${ic('my_location')}Prendre ma position GPS exacte actuelle</button>
                    <p class="note" id="gps-etat" hidden></p>
                    <input class="input" id="aj-adresse" maxlength="255" placeholder="Ex. Face station Petroci, carrefour Bluetooth">
                    <div class="picker">
                        <div id="carte-ajout"></div>
                        <div class="picker-pin">${ic('location_on')}</div>
                    </div>
                    <small>Pas de GPS ? Déplacez la carte pour mettre le repère rouge sur l'entrée de l'établissement.</small></div>

                <details class="plus-infos"><summary>Plus d'informations <small>(facultatif)</small></summary>
                    <div class="champ"><label for="aj-tel">Téléphone</label><input class="input" id="aj-tel" type="tel" inputmode="tel" maxlength="60"></div>
                    <div class="champ"><label for="aj-horaires">Horaires</label><input class="input" id="aj-horaires" maxlength="255" placeholder="Ex. lun–sam 8h–20h"></div>
                </details>

                <div class="champ"><span class="label"><span>Photo de la devanture ou plaque officielle</span><em class="pts bonus">+${pts.PHOTO} pts bonus</em></span>
                    <label class="photo-zone" id="photo-zone">
                        <input type="file" id="aj-photo" accept="image/*" hidden>
                        <span class="photo-rond">${ic('add_a_photo')}</span>
                        <b>Prendre une photo ou importer</b>
                        <small class="note">JPG, PNG ou WebP : plaque, enseigne ou façade bien visibles</small>
                    </label>
                    <div class="photo-prete" id="photo-prete" hidden><img alt="Aperçu de la photo" id="photo-apercu"><div><b id="photo-nom"></b><small>Photo prête à l'envoi</small></div><button type="button" class="icon-btn" id="photo-retirer" aria-label="Retirer la photo">${ic('delete')}</button></div></div>

                <div class="info-moderation">${ic('schedule')}<p><b>Vérification par l'équipe avant publication.</b> Vos points sont crédités dès que la fiche est validée par un modérateur. Les doublons et les adresses introuvables sont refusés.</p></div>

                <p class="erreur" hidden></p>
                <button class="btn btn-vert grand" type="submit" id="aj-envoyer">${ic('send')}<span id="aj-envoyer-texte">Soumettre et cumuler +${pts.CONTRIBUTION} points</span></button>
                <p class="note centre">Les ajouts sont vérifiés avant d'être publiés.</p>
            </form>
        </div>`;

        // Points et niveau du membre (la carte se remplit dès que les données arrivent)
        api('/moi/tableau').then(t => {
            session.majUser(t.user);
            const zone = vueEl.querySelector('#zone-credit');
            if (zone) zone.innerHTML = htmlCredit(t.user, t.palier, t.budget);
        }).catch(() => { /* le formulaire reste utilisable sans la carte des points */ });

        const form = vueEl.querySelector('#form-ajout');
        const nom = form.querySelector('#aj-nom');
        const total = () => pts.CONTRIBUTION + (choix.photo ? pts.PHOTO : 0);
        const majTotal = () => { form.querySelector('#aj-envoyer-texte').textContent = `Soumettre et cumuler +${total()} points`; };

        const depart = carte.getCenter();
        carteAjout = L.map('carte-ajout', { zoomControl: false, attributionControl: false }).setView([depart.lat, depart.lng], 17);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(carteAjout);

        /* Détection anti-doublon : nom proche à moins de 600 m, ou même numéro de téléphone */
        let minuteurDoublon;
        let numero = 0;
        const verifierDoublons = () => {
            clearTimeout(minuteurDoublon);
            minuteurDoublon = setTimeout(async () => {
                const zone = form.querySelector('#alerte-doublon');
                const n = ++numero;
                if (nom.value.trim().length < 3) { zone.innerHTML = ''; return; }
                const c = carteAjout.getCenter();
                try {
                    const { doublons } = await api(`/doublons?categorie=${choix.categorie}&nom=${encodeURIComponent(nom.value.trim())}&lat=${c.lat.toFixed(6)}&lng=${c.lng.toFixed(6)}&telephone=${encodeURIComponent(form.querySelector('#aj-tel').value)}`);
                    if (n !== numero || !zone.isConnected) return;
                    zone.innerHTML = doublons.map(d => `<div class="alerte-doublon">${ic('warning', 'fill')}<p><b>Détection anti-doublon :</b> « ${esc(d.nom)} » existe déjà à ${distance(d.distance)}${d.meme_telephone ? ' (même numéro de téléphone)' : ''}.
                        Souhaitez-vous plutôt <a href="#/fiche/${d.id}">signaler une correction sur sa fiche</a> ?</p></div>`).join('');
                } catch { /* l'alerte est une aide : l'envoi reste possible */ }
            }, 450);
        };
        nom.addEventListener('input', () => {
            form.querySelector('.champ-icone.fin').classList.toggle('valide', nom.value.trim().length >= 3);
            verifierDoublons();
        });
        form.querySelector('#aj-tel').addEventListener('change', verifierDoublons);
        carteAjout.on('dragend', () => { choix.positionChoisie = true; verifierDoublons(); });

        form.querySelector('#aj-categories').addEventListener('click', ev => {
            const b = ev.target.closest('.categorie-choix');
            if (!b) return;
            choix.categorie = b.dataset.cat;
            form.querySelectorAll('.categorie-choix').forEach(x => {
                x.classList.toggle('active', x === b);
                x.setAttribute('aria-checked', x === b);
            });
            form.querySelector('#garde-zone').hidden = choix.categorie !== 'pharmacie';
            if (choix.categorie !== 'pharmacie') form.querySelector('#aj-garde').checked = false;
            verifierDoublons();
        });

        form.querySelector('#ajout-gps').addEventListener('click', () => {
            const etatGps = form.querySelector('#gps-etat');
            etatGps.hidden = false;
            etatGps.textContent = 'Recherche de votre position…';
            if (!navigator.geolocation) {
                etatGps.textContent = 'La localisation n\'est pas disponible sur cet appareil : placez le repère à la main.';
                return;
            }
            navigator.geolocation.getCurrentPosition(
                pos => {
                    carteAjout?.setView([pos.coords.latitude, pos.coords.longitude], 18);
                    choix.positionChoisie = true;
                    etatGps.textContent = `Position GPS enregistrée (précision ≈ ${Math.round(pos.coords.accuracy)} m). Vérifiez que le repère est sur l'entrée.`;
                    verifierDoublons();
                },
                () => { etatGps.textContent = 'Position introuvable : placez le repère à la main sur la carte.'; },
                { enableHighAccuracy: true, timeout: 10000 }
            );
        });

        form.querySelector('#aj-photo').addEventListener('change', async ev => {
            const fichier = ev.target.files[0];
            if (!fichier) return;
            try {
                choix.photo = await redimensionner(fichier);
                choix.nomPhoto = fichier.name;
                form.querySelector('#photo-apercu').src = choix.photo;
                form.querySelector('#photo-nom').textContent = fichier.name;
                form.querySelector('#photo-prete').hidden = false;
                form.querySelector('#photo-zone').hidden = true;
                majTotal();
            } catch {
                toast('Impossible de lire cette photo', true);
            }
        });
        form.querySelector('#photo-retirer').addEventListener('click', () => {
            choix.photo = null;
            form.querySelector('#aj-photo').value = '';
            form.querySelector('#photo-prete').hidden = true;
            form.querySelector('#photo-zone').hidden = false;
            majTotal();
        });

        form.addEventListener('submit', async ev => {
            ev.preventDefault();
            const erreur = form.querySelector('.erreur');
            erreur.hidden = true;
            const probleme = nom.value.trim().length < 3 ? 'Indiquez le nom de l\'établissement'
                : !choix.categorie ? 'Choisissez la catégorie du lieu'
                : !form.querySelector('#aj-commune').value.trim() ? 'Indiquez la commune'
                : !form.querySelector('#aj-quartier').value.trim() ? 'Indiquez le quartier'
                : !choix.positionChoisie ? 'Placez l\'établissement : prenez votre position GPS ou déplacez la carte jusqu\'à l\'entrée'
                : null;
            if (probleme) {
                erreur.textContent = probleme;
                erreur.hidden = false;
                erreur.scrollIntoView({ block: 'center', behavior: 'smooth' });
                return;
            }
            const bouton = form.querySelector('#aj-envoyer');
            bouton.disabled = true;
            const c = carteAjout.getCenter();
            try {
                const res = await api('/moi/contributions', {
                    methode: 'POST',
                    corps: {
                        categorie: choix.categorie,
                        nom: nom.value,
                        telephone: form.querySelector('#aj-tel').value,
                        commune: form.querySelector('#aj-commune').value,
                        quartier: form.querySelector('#aj-quartier').value,
                        adresse: form.querySelector('#aj-adresse').value,
                        horaires: form.querySelector('#aj-horaires').value,
                        garde: form.querySelector('#aj-garde').checked,
                        lat: c.lat,
                        lng: c.lng,
                        photo: choix.photo
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
            // « Me localiser » montre ce qui est autour : la recherche en cours est effacée
            if (manuel && etat.recherche) {
                etat.recherche = '';
                $('#recherche').value = '';
                $('#btn-effacer').hidden = true;
            }
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
        document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('active', a.dataset.vue === (vue === 'notifications' ? 'compte' : vue)));
        $('#liste').hidden = vue !== 'liste';
        vueEl.hidden = !VUES_PLEIN_ECRAN.includes(vue);
        if (vue !== 'ajouter' && carteAjout) {
            carteAjout.remove();
            carteAjout = null;
        }
        if (carteFiche) {
            carteFiche.remove();
            carteFiche = null;
        }
        vueEl.scrollTop = 0;

        switch (vue) {
            case 'liste': afficherListe(); $('.main').scrollTop = 0; break;
            case 'urgences': vueUrgences(); break;
            case 'compte': vueCompte(); break;
            case 'fiche': vueFiche(Number(param)); break;
            case 'rdv': vueRdv(Number(param)); break;
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
            else if (action === 'echanger') {
                if (!cible.disabled) ouvrirEchange(cible.dataset.offre);
            } else if (action === 'modifier-fiche') {
                modifierFiche();
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
                // Un refus ou une annulation s'accompagne d'un message pour le patient (facultatif)
                const message = ['refuse', 'annule'].includes(cible.dataset.statut) ? prompt('Message pour le patient (facultatif) :') : '';
                if (message === null) return;
                try {
                    await api(`/pro/rendez-vous/${cible.dataset.id}`, { methode: 'PATCH', corps: { statut: cible.dataset.statut, message } });
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
