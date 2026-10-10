/* SantéMap — administration : contributions, établissements, gardes, rendez-vous, signalements, comptes */
'use strict';

(() => {
    const { session, api, esc, ic, toast, dialogue, dateHeure, jourLisible, fcfa, STATUTS, STATUTS_RDV, PLAGES, dateLocale } = SM;
    const contenu = document.getElementById('contenu');
    const JOURS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
    let categories = [];
    let onglet = 'tableau';
    const urlsPhotos = [];

    const libelleCategorie = code => categories.find(c => c.code === code)?.libelle || code;
    const optionsCategories = choisie => categories.map(c => `<option value="${c.code}" ${c.code === choisie ? 'selected' : ''}>${esc(c.libelle)}</option>`).join('');
    const chargement = () => `<div class="vide">${ic('refresh')}Chargement…</div>`;

    /** Les photos des contributions en attente ne sont pas publiques : on les charge avec le jeton */
    async function chargerPhoto(img, id) {
        try {
            const res = await fetch(`/api/admin/photos/${id}`, { headers: { Authorization: `Bearer ${session.jeton()}` } });
            if (!res.ok) return;
            const url = URL.createObjectURL(await res.blob());
            urlsPhotos.push(url);
            img.src = url;
        } catch { /* photo facultative */ }
    }

    /* ---------- Connexion ---------- */

    function ecranConnexion(message) {
        document.getElementById('onglets').hidden = true;
        document.getElementById('admin-deconnexion').hidden = true;
        document.getElementById('admin-nom').textContent = '';
        contenu.innerHTML = `<div class="card" style="max-width:420px;margin:40px auto;padding:24px">
            <h1>Administration</h1>
            <p class="note">Réservé à l'équipe SantéMap.</p>
            <form class="form" id="form-admin">
                <div class="champ"><label for="ad-id">E-mail ou téléphone</label><input class="input" id="ad-id" autocomplete="username" required></div>
                <div class="champ"><label for="ad-mdp">Mot de passe</label><input class="input" id="ad-mdp" type="password" autocomplete="current-password" required></div>
                <p class="erreur" ${message ? '' : 'hidden'}>${esc(message || '')}</p>
                <button class="btn btn-primary" type="submit">Se connecter</button>
            </form></div>`;
        contenu.querySelector('form').addEventListener('submit', async ev => {
            ev.preventDefault();
            try {
                const res = await api('/auth/connexion', { methode: 'POST', corps: { identifiant: contenu.querySelector('#ad-id').value, mot_de_passe: contenu.querySelector('#ad-mdp').value } });
                if (res.user.role !== 'admin') return ecranConnexion('Ce compte n\'a pas accès à l\'administration');
                session.enregistrer(res.token, res.user);
                demarrer();
            } catch (err) {
                ecranConnexion(err.message);
            }
        });
    }

    /* ---------- Tableau de bord ---------- */

    async function tableau() {
        const s = await api('/admin/stats');
        majCompteurs(s);
        const max = Math.max(...s.par_categorie.map(c => c.n), 1);
        contenu.innerHTML = `
            <h1>Tableau de bord</h1>
            <div class="stats">
                <div class="stat"><b>${s.etablissements.toLocaleString('fr-FR')}</b><span>établissements publiés</span></div>
                <div class="stat ${s.contributions ? 'alerte' : ''}"><b>${s.contributions}</b><span>contributions à vérifier</span></div>
                <div class="stat ${s.rendez_vous ? 'alerte' : ''}"><b>${s.rendez_vous}</b><span>rendez-vous en attente</span></div>
                <div class="stat ${s.signalements ? 'alerte' : ''}"><b>${s.signalements}</b><span>signalements à traiter</span></div>
                <div class="stat ${s.revendications ? 'alerte' : ''}"><b>${s.revendications}</b><span>fiches à revendiquer</span></div>
                <div class="stat ${s.echanges ? 'alerte' : ''}"><b>${s.echanges}</b><span>échanges de points à traiter</span></div>
                <div class="stat ${s.budget.mensuel && s.budget.utilise >= s.budget.mensuel ? 'alerte' : ''}"><b>${fcfa(s.budget.utilise)}</b><span>récompenses ce mois-ci${s.budget.mensuel ? ` sur ${fcfa(s.budget.mensuel)}` : ' (sans plafond)'}</span></div>
                <div class="stat"><b>${s.utilisateurs}</b><span>membres inscrits</span></div>
                <div class="stat"><b>${s.partenaires}</b><span>établissements partenaires</span></div>
            </div>
            <div class="deux-colonnes">
                <div class="card" style="padding:18px"><h2 class="section" style="margin-top:0">Par catégorie</h2>
                    <div class="barres">${s.par_categorie.map(c => `<div><span>${esc(libelleCategorie(c.categorie))}</span><i style="width:${Math.max(2, (c.n / max) * 100)}%"></i><b>${c.n}</b></div>`).join('')}</div></div>
                <div class="card" style="padding:18px"><h2 class="section" style="margin-top:0">Meilleurs contributeurs</h2>
                    ${s.contributeurs.length ? s.contributeurs.map(c => `<div class="element-haut" style="padding:6px 0"><span>${esc(c.nom)}</span><b>${c.points} pts</b></div>`).join('') : '<p class="note">Aucune contribution validée pour le moment.</p>'}</div>
            </div>`;
    }

    function majCompteurs(s) {
        document.getElementById('nb-contributions').textContent = s.contributions || '';
        document.getElementById('nb-rdv').textContent = s.rendez_vous || '';
        document.getElementById('nb-signalements').textContent = s.signalements || '';
        document.getElementById('nb-revendications').textContent = s.revendications || '';
        document.getElementById('nb-echanges').textContent = s.echanges || '';
    }

    /* ---------- Contributions ---------- */

    async function contributions(statut = 'en_attente') {
        contenu.innerHTML = `<h1>Contributions</h1>
            <p class="note">Vérifiez chaque ajout (nom, type, position, photo) avant de le publier. Le contributeur gagne ses points à la validation.</p>
            <div class="barre"><select class="input" id="filtre-contrib">
                <option value="en_attente">À vérifier</option><option value="valide">Validées</option><option value="refuse">Refusées</option>
            </select></div>
            <div id="liste-contrib">${chargement()}</div>`;
        const filtre = contenu.querySelector('#filtre-contrib');
        filtre.value = statut;
        filtre.addEventListener('change', () => contributions(filtre.value));

        const liste = await api(`/admin/contributions?statut=${statut}`);
        const zone = contenu.querySelector('#liste-contrib');
        if (!liste.length) {
            zone.innerHTML = `<div class="vide">${ic('check')}Rien à afficher ici.</div>`;
            return;
        }
        zone.innerHTML = `<div class="grille-cartes">${liste.map(c => `
            <article class="contrib" data-id="${c.id}">
                <div class="contrib-photo">${c.photo_id ? `<img alt="Photo envoyée par le contributeur" data-photo="${c.photo_id}">` : 'Pas de photo'}</div>
                ${statut === 'en_attente' ? `
                    <input class="input" name="nom" value="${esc(c.nom)}" aria-label="Nom">
                    <select class="input" name="categorie" aria-label="Type">${optionsCategories(c.categorie)}</select>` : `<b>${esc(c.nom)}</b><span class="badge">${esc(libelleCategorie(c.categorie))}</span>`}
                <dl>
                    <dt>Contributeur</dt><dd>${esc(c.contributeur || '—')}${c.contributeur_telephone ? ` (${esc(c.contributeur_telephone)})` : ''}</dd>
                    <dt>Commune</dt><dd>${esc([c.quartier, c.commune].filter(Boolean).join(', ') || '—')}</dd>
                    ${c.garde_declaree ? '<dt>Garde</dt><dd><b>Déclarée de garde cette semaine</b> (créée à la validation)</dd>' : ''}
                    <dt>Repère</dt><dd>${esc(c.adresse || '—')}</dd>
                    <dt>Téléphone</dt><dd>${esc(c.telephone || '—')}</dd>
                    <dt>Horaires</dt><dd>${esc(c.horaires || '—')}</dd>
                    <dt>Position</dt><dd><a href="https://www.openstreetmap.org/?mlat=${c.lat}&mlon=${c.lng}#map=18/${c.lat}/${c.lng}" target="_blank" rel="noopener">Voir sur la carte ${ic('open_in_new')}</a></dd>
                    ${c.motif_refus ? `<dt>Motif du refus</dt><dd>${esc(c.motif_refus)}</dd>` : ''}
                </dl>
                ${c.doublons.length ? `<div class="doublons"><b>${ic('warning')}Doublon possible</b>${c.doublons.map(d => `${esc(d.nom)} (${esc(libelleCategorie(d.categorie))}) à ${d.distance} m`).join('<br>')}</div>` : ''}
                ${statut === 'en_attente' ? `
                    <label class="cases"><span><input type="checkbox" name="verifie"> Informations vérifiées (badge « Vérifié »)</span></label>
                    <div class="actions">
                        <button type="button" class="btn btn-primary btn-petit" data-action="valider">${ic('check')}Valider</button>
                        <button type="button" class="btn btn-ligne btn-petit" data-action="refuser">${ic('close')}Refuser</button>
                    </div>` : ''}
            </article>`).join('')}</div>`;

        zone.querySelectorAll('img[data-photo]').forEach(img => chargerPhoto(img, img.dataset.photo));
        zone.querySelectorAll('.contrib').forEach(carte => {
            const id = carte.dataset.id;
            carte.querySelector('[data-action="valider"]')?.addEventListener('click', async () => {
                try {
                    const res = await api(`/admin/contributions/${id}/valider`, {
                        methode: 'POST',
                        corps: { nom: carte.querySelector('[name="nom"]').value, categorie: carte.querySelector('[name="categorie"]').value, verifie: carte.querySelector('[name="verifie"]').checked }
                    });
                    toast(`Publié${res.points_attribues ? ` : ${res.points_attribues} points pour le contributeur` : ''}`);
                    contributions('en_attente');
                    rafraichirCompteurs();
                } catch (err) { toast(err.message, true); }
            });
            carte.querySelector('[data-action="refuser"]')?.addEventListener('click', () => refuser(id));
        });
    }

    function refuser(id) {
        const motifs = ['Établissement introuvable à cette adresse', 'Déjà présent sur la carte', 'Ce n\'est pas un établissement de santé', 'Informations insuffisantes'];
        const { el, fermer } = dialogue(`<h3>Refuser la contribution</h3>
            <form class="form">
                <div class="champ"><label for="motif">Motif (envoyé au contributeur)</label>
                    <input class="input" id="motif" list="motifs" required maxlength="255">
                    <datalist id="motifs">${motifs.map(m => `<option value="${esc(m)}">`).join('')}</datalist></div>
                <div class="actions"><button type="button" class="btn btn-ligne" data-fermer>Annuler</button><button class="btn btn-rouge" type="submit">Refuser</button></div>
            </form>`);
        el.querySelector('form').addEventListener('submit', async ev => {
            ev.preventDefault();
            try {
                await api(`/admin/contributions/${id}/refuser`, { methode: 'POST', corps: { motif: el.querySelector('#motif').value } });
                fermer();
                toast('Contribution refusée');
                contributions('en_attente');
                rafraichirCompteurs();
            } catch (err) { toast(err.message, true); }
        });
    }

    /* ---------- Établissements ---------- */

    async function etablissements(q = '', filtre = '') {
        contenu.innerHTML = `<h1>Établissements</h1>
            <p class="note">Modifiez une fiche, activez l'offre partenaire (services, rendez-vous en ligne) ou déclarez les pharmacies de garde.</p>
            <form class="barre" id="form-recherche-etab">
                <input class="input" name="q" placeholder="Nom ou commune…" value="${esc(q)}">
                <select class="input" name="filtre">
                    <option value="">Tous</option><option value="pharmacies">Pharmacies (gardes)</option><option value="partenaires">Partenaires</option>
                </select>
                <button class="btn btn-primary btn-petit" type="submit">${ic('search')}Rechercher</button>
            </form>
            <div id="liste-etab">${chargement()}</div>`;
        const form = contenu.querySelector('#form-recherche-etab');
        form.filtre.value = filtre;
        form.addEventListener('submit', ev => {
            ev.preventDefault();
            etablissements(form.q.value, form.filtre.value);
        });

        const liste = await api(`/admin/etablissements?q=${encodeURIComponent(q)}&filtre=${filtre}`);
        contenu.querySelector('#liste-etab').innerHTML = liste.length ? `<table class="tableau">
            <thead><tr><th>Nom</th><th>Type</th><th>Commune</th><th>État</th><th></th></tr></thead>
            <tbody>${liste.map(e => `<tr>
                <td><b>${esc(e.nom)}</b>${e.verifie ? ' ' + ic('verified') : ''}</td>
                <td>${esc(libelleCategorie(e.categorie))}</td>
                <td>${esc(e.commune || '—')}</td>
                <td>${e.premium ? '<span class="badge or">Partenaire</span> ' : ''}${e.rdv_actif ? '<span class="badge">RDV</span> ' : ''}${e.gardes ? '<span class="badge vert">Garde</span>' : ''}</td>
                <td><button type="button" class="btn btn-ligne btn-petit" data-editer="${e.id}">Modifier</button></td>
            </tr>`).join('')}</tbody></table>
            ${liste.length === 50 ? '<p class="note">50 premiers résultats : précisez la recherche.</p>' : ''}`
            : `<div class="vide">${ic('search')}Aucun établissement trouvé.</div>`;
        contenu.querySelectorAll('[data-editer]').forEach(b => b.addEventListener('click', () => editer(b.dataset.editer, () => etablissements(q, filtre))));
    }

    /** Lignes « a | b | c » d'un champ de saisie, sans les lignes vides */
    const lignes = texte => texte.split('\n').map(l => l.split('|').map(x => x.trim())).filter(l => l[0]);

    async function editer(id, apres) {
        let e;
        try {
            e = await api(`/admin/etablissements/${id}`);
        } catch (err) {
            return toast(err.message, true);
        }
        const plages = j => (e.rdv_horaires[j] || []).join(', ');
        const { el, fermer } = dialogue(`
            <h3>${esc(e.nom)}</h3>
            <form class="form" id="form-etab">
                <div class="grille-champs">
                    <div class="champ large"><label>Nom</label><input class="input" name="nom" value="${esc(e.nom)}" required maxlength="200"></div>
                    <div class="champ"><label>Type</label><select class="input" name="categorie">${optionsCategories(e.categorie)}</select></div>
                    <div class="champ"><label>Téléphone</label><input class="input" name="telephone" value="${esc(e.telephone || '')}" maxlength="60"></div>
                    <div class="champ"><label>Commune</label><input class="input" name="commune" value="${esc(e.commune || '')}" maxlength="100"></div>
                    <div class="champ"><label>Quartier</label><input class="input" name="quartier" value="${esc(e.quartier || '')}" maxlength="100"></div>
                    <div class="champ"><label>Agrément / autorisation</label><input class="input" name="agrement" value="${esc(e.agrement || '')}" maxlength="255" placeholder="Ex. Agrément Ministère de la Santé n° …"></div>
                    <div class="champ"><label>Adresse / repère</label><input class="input" name="adresse" value="${esc(e.adresse || '')}" maxlength="255"></div>
                    <div class="champ"><label>Horaires (texte affiché)</label><input class="input" name="horaires" value="${esc(e.horaires || '')}" maxlength="255"></div>
                    <div class="champ"><label>Site web</label><input class="input" name="site_web" value="${esc(e.site_web || '')}" maxlength="255"></div>
                    <div class="champ large"><label>Description</label><textarea class="input" name="description" maxlength="2000">${esc(e.description || '')}</textarea></div>
                </div>
                <div class="cases">
                    <label><input type="checkbox" name="verifie" ${e.verifie ? 'checked' : ''}> Vérifié</label>
                    <label><input type="checkbox" name="ouvert_24h" ${e.ouvert_24h ? 'checked' : ''}> Ouvert 24h/24</label>
                    <label><input type="checkbox" name="urgences" ${e.urgences ? 'checked' : ''}> Service d'urgences</label>
                    <label><input type="checkbox" name="revendique" ${e.revendique ? 'checked' : ''}> Fiche revendiquée (justificatifs contrôlés)</label>
                    <label><input type="checkbox" name="masque" ${e.statut !== 'valide' ? 'checked' : ''}> Masqué de la carte</label>
                </div>

                <h2 class="section">Offre partenaire</h2>
                <label class="cases"><span><input type="checkbox" name="premium" ${e.premium ? 'checked' : ''}> Établissement partenaire (fiche détaillée)</span></label>
                <div class="grille-champs">
                    <div class="champ large"><label>Services proposés <small>(un par ligne)</small></label><textarea class="input" name="services">${esc(e.services.join('\n'))}</textarea></div>
                    <div class="champ large"><label>Horaires par service <small>(un par ligne : Service | horaires)</small></label><textarea class="input" name="horaires_detail">${esc(e.horaires_detail.map(h => `${h.libelle} | ${h.horaires}`).join('\n'))}</textarea></div>
                    <div class="champ large"><label>Tarifs indicatifs <small>(un par ligne : Prestation | précision | prix en FCFA)</small></label><textarea class="input" name="tarifs">${esc(e.tarifs.map(t => `${t.libelle} | ${t.detail || ''} | ${t.prix}`).join('\n'))}</textarea></div>
                    <div class="champ large"><label>Assurances et moyens de paiement acceptés</label><input class="input" name="assurances" value="${esc(e.assurances || '')}" maxlength="255"></div>
                    <div class="champ"><label>Consultation à partir de (FCFA)</label><input class="input" name="prix_consultation" type="number" min="0" step="500" value="${e.prix_consultation ?? ''}"></div>
                    <div class="champ"><label>Durée d'un rendez-vous (minutes)</label><input class="input" name="rdv_duree" type="number" min="10" max="120" step="5" value="${e.rdv_duree}"></div>
                </div>
                <label class="cases"><span><input type="checkbox" name="rdv_actif" ${e.rdv_actif ? 'checked' : ''}> Rendez-vous en ligne</span></label>
                <div class="champ"><span class="label">Horaires de consultation <small>(ex. 08:00-12:00, 14:00-17:00 ; vide = fermé)</small></span>
                    <div class="horaires-semaine">${JOURS.map((j, i) => `<span>${j}</span><input class="input" name="jour-${i + 1}" value="${esc(plages(i + 1))}" placeholder="Fermé">`).join('')}</div></div>

                ${e.categorie === 'pharmacie' ? `
                    <h2 class="section">Gardes</h2>
                    <div class="gardes-liste" id="gardes">${e.gardes.map(g => `<div><span>Du ${esc(jourLisible(g.debut))} au ${esc(jourLisible(g.fin))}</span><button type="button" class="icon-btn" data-garde="${g.id}" aria-label="Supprimer">${ic('delete')}</button></div>`).join('') || '<p class="note">Aucune garde à venir.</p>'}</div>
                    <div class="barre"><input class="input" type="date" name="garde_debut" value="${dateLocale()}" aria-label="Début"><input class="input" type="date" name="garde_fin" value="${dateLocale()}" aria-label="Fin"><button type="button" class="btn btn-ligne btn-petit" id="ajout-garde">${ic('add')}Ajouter la garde</button></div>` : ''}

                ${e.comptes.length ? `<p class="note">Compte(s) établissement : ${e.comptes.map(c => esc(c.nom)).join(', ')}</p>` : ''}
                <p class="erreur" hidden></p>
                <div class="actions"><button type="button" class="btn btn-ligne" data-fermer>Fermer</button><button class="btn btn-primary" type="submit">${ic('save')}Enregistrer</button></div>
            </form>`);
        el.classList.add('edition');
        const form = el.querySelector('form');

        form.addEventListener('submit', async ev => {
            ev.preventDefault();
            const f = form.elements;
            const horaires = {};
            for (let j = 1; j <= 7; j++) {
                const plagesJour = f[`jour-${j}`].value.split(',').map(p => p.trim().replace(/\s/g, '')).filter(Boolean);
                if (plagesJour.length) horaires[j] = plagesJour;
            }
            const corps = {
                nom: f.nom.value, categorie: f.categorie.value, telephone: f.telephone.value, commune: f.commune.value,
                adresse: f.adresse.value, horaires: f.horaires.value, site_web: f.site_web.value, description: f.description.value,
                quartier: f.quartier.value, agrement: f.agrement.value, assurances: f.assurances.value, revendique: f.revendique.checked,
                horaires_detail: lignes(f.horaires_detail.value).map(([libelle, h]) => ({ libelle, horaires: h })),
                tarifs: lignes(f.tarifs.value).map(([libelle, detail, prix]) => ({ libelle, detail, prix: Number(String(prix).replace(/\D/g, '')) })),
                verifie: f.verifie.checked, ouvert_24h: f.ouvert_24h.checked, urgences: f.urgences.checked,
                statut: f.masque.checked ? 'refuse' : 'valide',
                premium: f.premium.checked, services: f.services.value.split('\n').map(s => s.trim()).filter(Boolean),
                prix_consultation: f.prix_consultation.value, rdv_duree: f.rdv_duree.value, rdv_horaires: horaires, rdv_actif: f.rdv_actif.checked
            };
            const erreur = form.querySelector('.erreur');
            try {
                await api(`/admin/etablissements/${id}`, { methode: 'PATCH', corps });
                fermer();
                toast('Fiche enregistrée');
                apres?.();
            } catch (err) {
                erreur.textContent = err.message;
                erreur.hidden = false;
            }
        });

        el.querySelector('#ajout-garde')?.addEventListener('click', async () => {
            try {
                await api(`/admin/etablissements/${id}/gardes`, { methode: 'POST', corps: { debut: form.garde_debut.value, fin: form.garde_fin.value } });
                toast('Garde ajoutée');
                fermer();
                editer(id, apres);
            } catch (err) { toast(err.message, true); }
        });
        el.querySelectorAll('[data-garde]').forEach(b => b.addEventListener('click', async () => {
            try {
                await api(`/admin/gardes/${b.dataset.garde}`, { methode: 'DELETE' });
                b.parentElement.remove();
                toast('Garde supprimée');
            } catch (err) { toast(err.message, true); }
        }));
    }

    /* ---------- Rendez-vous ---------- */

    async function rendezVous(statut = 'en_attente') {
        contenu.innerHTML = `<h1>Rendez-vous</h1>
            <p class="note">Demandes faites depuis l'application. Les établissements partenaires peuvent aussi les gérer depuis leur compte.</p>
            <div class="barre"><select class="input" id="filtre-rdv">
                <option value="en_attente">Demandés</option><option value="confirme">Confirmés</option><option value="refuse">Refusés</option><option value="annule">Annulés</option><option value="termine">Terminés</option><option value="absent">Absences</option><option value="">Tous</option>
            </select></div>
            <div id="liste-rdv">${chargement()}</div>`;
        const filtre = contenu.querySelector('#filtre-rdv');
        filtre.value = statut;
        filtre.addEventListener('change', () => rendezVous(filtre.value));

        const liste = await api(`/admin/rendez-vous${statut ? `?statut=${statut}` : ''}`);
        contenu.querySelector('#liste-rdv').innerHTML = liste.length ? `<table class="tableau">
            <thead><tr><th>Date</th><th>Établissement</th><th>Patient</th><th>Motif</th><th>Statut</th><th></th></tr></thead>
            <tbody>${liste.map(r => `<tr>
                <td>${esc(r.plage ? `${jourLisible(String(r.debut).slice(0, 10))} • ${PLAGES[r.plage]}` : dateHeure(r.debut))}<br><small class="note">${esc(r.reference)}</small></td>
                <td>${esc(r.etablissement)}</td>
                <td>${esc(r.patient)}<br><a href="tel:${esc(r.telephone)}">${ic('call')}${esc(r.telephone)}</a></td>
                <td>${esc(r.motif || '—')}</td>
                <td><span class="statut ${r.statut}">${esc(STATUTS_RDV[r.statut])}</span></td>
                <td>${['en_attente', 'confirme'].includes(r.statut) ? `<div class="actions">
                    ${r.statut === 'en_attente'
                        ? `<button type="button" class="btn btn-primary btn-petit" data-rdv="${r.id}" data-statut="confirme">Confirmer</button><button type="button" class="btn btn-ligne btn-petit" data-rdv="${r.id}" data-statut="refuse">Refuser</button>`
                        : `<button type="button" class="btn btn-ligne btn-petit" data-rdv="${r.id}" data-statut="termine">Terminé</button><button type="button" class="btn btn-ligne btn-petit" data-rdv="${r.id}" data-statut="absent">Absent</button>`}
                    <button type="button" class="btn btn-ligne btn-petit" data-rdv="${r.id}" data-statut="annule">Annuler</button></div>` : ''}</td>
            </tr>`).join('')}</tbody></table>` : `<div class="vide">${ic('event')}Aucun rendez-vous.</div>`;

        contenu.querySelectorAll('[data-rdv]').forEach(b => b.addEventListener('click', async () => {
            try {
                await api(`/admin/rendez-vous/${b.dataset.rdv}`, { methode: 'PATCH', corps: { statut: b.dataset.statut } });
                toast('Rendez-vous mis à jour, le patient est prévenu');
                rendezVous(statut);
                rafraichirCompteurs();
            } catch (err) { toast(err.message, true); }
        }));
    }

    /* ---------- Signalements ---------- */

    const MOTIFS = { ferme: 'Établissement fermé', mauvaise_position: 'Mauvaise position', mauvaises_infos: 'Informations fausses', doublon: 'Doublon', autre: 'Autre' };

    async function signalements() {
        contenu.innerHTML = `<h1>Signalements</h1><p class="note">Erreurs signalées par les utilisateurs sur les fiches.</p><div id="liste-sig">${chargement()}</div>`;
        const liste = await api('/admin/signalements');
        contenu.querySelector('#liste-sig').innerHTML = liste.length ? `<table class="tableau">
            <thead><tr><th>Établissement</th><th>Problème</th><th>Précisions</th><th>Par</th><th></th></tr></thead>
            <tbody>${liste.map(s => `<tr>
                <td><b>${esc(s.etablissement)}</b></td>
                <td>${esc(MOTIFS[s.motif])}</td>
                <td>${esc(s.message || '—')}</td>
                <td>${esc(s.auteur || 'Anonyme')}</td>
                <td><div class="actions">
                    <button type="button" class="btn btn-ligne btn-petit" data-editer="${s.etablissement_id}">Corriger la fiche</button>
                    <button type="button" class="btn btn-primary btn-petit" data-traite="${s.id}">Traité</button></div></td>
            </tr>`).join('')}</tbody></table>` : `<div class="vide">${ic('check')}Aucun signalement en attente.</div>`;

        contenu.querySelectorAll('[data-editer]').forEach(b => b.addEventListener('click', () => editer(b.dataset.editer)));
        contenu.querySelectorAll('[data-traite]').forEach(b => b.addEventListener('click', async () => {
            try {
                await api(`/admin/signalements/${b.dataset.traite}/traite`, { methode: 'POST' });
                toast('Signalement traité');
                signalements();
                rafraichirCompteurs();
            } catch (err) { toast(err.message, true); }
        }));
    }

    /* ---------- Revendications de fiches ---------- */

    async function revendications() {
        contenu.innerHTML = `<h1>Revendications</h1>
            <p class="note">Un professionnel demande à gérer la fiche de son établissement. Contrôlez ses justificatifs (numéro d'ordre, licence, agrément) avant d'accepter : le compte devient « établissement » et la fiche passe en « revendiquée ».</p>
            <div id="liste-rev">${chargement()}</div>`;
        const liste = await api('/admin/revendications');
        contenu.querySelector('#liste-rev').innerHTML = liste.length ? `<div class="grille-cartes">${liste.map(r => `
            <article class="contrib" data-id="${r.id}">
                <b>${esc(r.etablissement)}</b><span class="badge">${esc(libelleCategorie(r.categorie))}${r.commune ? ` • ${esc(r.commune)}` : ''}</span>
                <dl>
                    <dt>Demandeur</dt><dd>${esc(r.nom)} (${esc(r.fonction)})</dd>
                    <dt>Téléphone</dt><dd><a href="tel:${esc(r.telephone)}">${esc(r.telephone)}</a></dd>
                    <dt>Justificatif</dt><dd>${esc(r.justificatif)}</dd>
                    <dt>Compte</dt><dd>${esc(r.compte)}${r.role !== 'utilisateur' ? ` (${esc(r.role)})` : ''}</dd>
                    <dt>Pièce</dt><dd>${r.piece ? `<button type="button" class="btn btn-ligne btn-petit" data-piece="${r.id}">Voir le document</button>` : 'Aucune photo jointe'}</dd>
                    <dt>Fiche</dt><dd><button type="button" class="btn btn-ligne btn-petit" data-editer="${r.etablissement_id}">Ouvrir la fiche</button></dd>
                </dl>
                <div class="actions">
                    <button type="button" class="btn btn-primary btn-petit" data-approuver="${r.id}">${ic('check')}Attribuer la fiche</button>
                    <button type="button" class="btn btn-ligne btn-petit" data-refuser="${r.id}">${ic('close')}Refuser</button>
                </div>
            </article>`).join('')}</div>` : `<div class="vide">${ic('check')}Aucune demande en attente.</div>`;

        contenu.querySelectorAll('[data-editer]').forEach(b => b.addEventListener('click', () => editer(b.dataset.editer)));
        contenu.querySelectorAll('[data-piece]').forEach(b => b.addEventListener('click', async () => {
            // Le justificatif n'est pas public : il se charge avec le jeton de l'équipe
            try {
                const res = await fetch(`/api/admin/revendications/${b.dataset.piece}/piece`, { headers: { Authorization: `Bearer ${session.jeton()}` } });
                if (!res.ok) throw new Error('Document introuvable');
                const url = URL.createObjectURL(await res.blob());
                urlsPhotos.push(url);
                dialogue(`<h3>Justificatif</h3><img src="${url}" alt="Justificatif du demandeur" style="width:100%;border-radius:12px">`);
            } catch (err) { toast(err.message, true); }
        }));
        contenu.querySelectorAll('[data-approuver]').forEach(b => b.addEventListener('click', async () => {
            if (!confirm('Attribuer la gestion de cette fiche à ce compte ?')) return;
            try {
                await api(`/admin/revendications/${b.dataset.approuver}/approuver`, { methode: 'POST' });
                toast('Fiche attribuée');
                revendications();
                rafraichirCompteurs();
            } catch (err) { toast(err.message, true); }
        }));
        contenu.querySelectorAll('[data-refuser]').forEach(b => b.addEventListener('click', async () => {
            const motif = prompt('Motif du refus (envoyé au demandeur) :');
            if (!motif) return;
            try {
                await api(`/admin/revendications/${b.dataset.refuser}/refuser`, { methode: 'POST', corps: { motif } });
                toast('Demande refusée');
                revendications();
                rafraichirCompteurs();
            } catch (err) { toast(err.message, true); }
        }));
    }

    /* ---------- Échanges de points ---------- */

    async function echanges() {
        contenu.innerHTML = `<h1>Échanges de points</h1>
            <p class="note">Les membres échangent leurs points contre du crédit ou un forfait. Faites la recharge, puis marquez l'échange « effectué » ; un refus rend les points au membre.</p>
            <div id="liste-ech">${chargement()}</div>`;
        const liste = await api('/admin/echanges');
        contenu.querySelector('#liste-ech').innerHTML = liste.length ? `<table class="tableau">
            <thead><tr><th>Membre</th><th>Offre</th><th>Numéro à recharger</th><th>Points</th><th>Demandé le</th><th></th></tr></thead>
            <tbody>${liste.map(x => `<tr>
                <td><b>${esc(x.membre)}</b></td><td>${esc(x.libelle)}</td><td><a href="tel:${esc(x.telephone)}">${esc(x.telephone)}</a></td><td>${x.points}</td><td>${esc(dateHeure(x.created_at))}</td>
                <td><div class="actions">
                    <button type="button" class="btn btn-primary btn-petit" data-echange="${x.id}" data-statut="effectue">Recharge faite</button>
                    <button type="button" class="btn btn-ligne btn-petit" data-echange="${x.id}" data-statut="refuse">Refuser</button></div></td>
            </tr>`).join('')}</tbody></table>` : `<div class="vide">${ic('check')}Aucun échange à traiter.</div>`;
        contenu.querySelectorAll('[data-echange]').forEach(b => b.addEventListener('click', async () => {
            if (b.dataset.statut === 'refuse' && !confirm('Refuser cet échange ? Les points seront rendus au membre.')) return;
            try {
                const res = await api(`/admin/echanges/${b.dataset.echange}/traiter`, { methode: 'POST', corps: { statut: b.dataset.statut } });
                toast(res.message);
                echanges();
                rafraichirCompteurs();
            } catch (err) { toast(err.message, true); }
        }));
    }

    /* ---------- Comptes ---------- */

    async function comptes(q = '') {
        contenu.innerHTML = `<h1>Comptes</h1>
            <p class="note">Un compte « établissement » gère les rendez-vous de l'établissement qui lui est rattaché (indiquez son numéro, visible dans l'adresse de sa fiche : /#/fiche/<b>numéro</b>).</p>
            <form class="barre" id="form-comptes"><input class="input" name="q" placeholder="Nom, e-mail ou téléphone…" value="${esc(q)}"><button class="btn btn-primary btn-petit" type="submit">${ic('search')}Rechercher</button></form>
            <div id="liste-comptes">${chargement()}</div>`;
        const form = contenu.querySelector('#form-comptes');
        form.addEventListener('submit', ev => {
            ev.preventDefault();
            comptes(form.q.value);
        });

        const liste = await api(`/admin/utilisateurs?q=${encodeURIComponent(q)}`);
        const moi = session.user();
        contenu.querySelector('#liste-comptes').innerHTML = `<table class="tableau">
            <thead><tr><th>Nom</th><th>Contact</th><th>Points</th><th>Rôle</th><th>N° établissement</th><th>Actif</th><th></th></tr></thead>
            <tbody>${liste.map(u => `<tr data-id="${u.id}">
                <td><b>${esc(u.nom)}</b>${u.etablissement ? `<br><small class="note">${esc(u.etablissement)}</small>` : ''}</td>
                <td>${esc(u.email || '')}<br>${esc(u.telephone || '')}</td>
                <td>${u.points}</td>
                <td><select class="input btn-petit" name="role" ${u.id === moi?.id ? 'disabled' : ''}>
                    ${['utilisateur', 'etablissement', 'admin'].map(r => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${r === 'utilisateur' ? 'Membre' : r === 'etablissement' ? 'Établissement' : 'Équipe'}</option>`).join('')}
                </select></td>
                <td><input class="input btn-petit" name="etablissement_id" type="number" min="1" value="${u.etablissement_id || ''}" style="width:110px" ${u.id === moi?.id ? 'disabled' : ''}></td>
                <td><input type="checkbox" name="actif" ${u.actif ? 'checked' : ''} ${u.id === moi?.id ? 'disabled' : ''} aria-label="Compte actif"></td>
                <td>${u.id === moi?.id ? '<span class="note">Vous</span>' : `<button type="button" class="btn btn-ligne btn-petit" data-enregistrer>${ic('save')}</button>`}</td>
            </tr>`).join('')}</tbody></table>`;

        contenu.querySelectorAll('[data-enregistrer]').forEach(b => b.addEventListener('click', async () => {
            const ligne = b.closest('tr');
            try {
                await api(`/admin/utilisateurs/${ligne.dataset.id}`, {
                    methode: 'PATCH',
                    corps: { role: ligne.querySelector('[name="role"]').value, etablissement_id: ligne.querySelector('[name="etablissement_id"]').value, actif: ligne.querySelector('[name="actif"]').checked }
                });
                toast('Compte mis à jour');
                comptes(q);
            } catch (err) { toast(err.message, true); }
        }));
    }

    /* ---------- Navigation ---------- */

    const PAGES = { tableau, contributions, etablissements, 'rendez-vous': rendezVous, signalements, revendications, echanges, comptes };

    async function ouvrir(nom) {
        onglet = nom;
        urlsPhotos.splice(0).forEach(URL.revokeObjectURL);
        document.querySelectorAll('[data-onglet]').forEach(b => b.classList.toggle('active', b.dataset.onglet === nom));
        contenu.innerHTML = chargement();
        try {
            await PAGES[nom]();
        } catch (err) {
            if (err.status === 401 || err.status === 403) return ecranConnexion('Reconnectez-vous');
            contenu.innerHTML = `<p class="erreur">${esc(err.message)}</p>`;
        }
    }

    async function rafraichirCompteurs() {
        try { majCompteurs(await api('/admin/stats')); } catch { /* compteurs facultatifs */ }
    }

    async function demarrer() {
        const user = session.user();
        if (!session.jeton() || user?.role !== 'admin') return ecranConnexion();
        try {
            categories = (await api('/meta')).categories;
        } catch (err) {
            return ecranConnexion(err.message);
        }
        document.getElementById('admin-nom').textContent = user.nom;
        document.getElementById('admin-deconnexion').hidden = false;
        document.getElementById('onglets').hidden = false;
        ouvrir(onglet);
        rafraichirCompteurs();
    }

    document.getElementById('onglets').addEventListener('click', ev => {
        const b = ev.target.closest('[data-onglet]');
        if (b) ouvrir(b.dataset.onglet);
    });
    document.getElementById('admin-deconnexion').addEventListener('click', () => {
        session.fermer();
        ecranConnexion();
    });
    document.addEventListener('sm:deconnexion', () => ecranConnexion('Session expirée, reconnectez-vous'));

    demarrer();
})();
