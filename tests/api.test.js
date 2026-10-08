/**
 * Tests d'intégration de l'API SantéMap, sur une vraie base MySQL/MariaDB dédiée :
 *   DB_NAME=santemap_tests npm test
 * Les tables de cette base sont supprimées au début des tests.
 */

process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.DB_NAME || 'santemap_tests';
process.env.ADMIN_PASSWORD = 'admin-test-123';
process.env.IMPORT_OSM = 'false';
process.env.SEED_DEMO = 'true';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../config');

if (!/test/i.test(config.DB_NAME)) {
    throw new Error(`Par sécurité, les tests ne tournent que sur une base dont le nom contient "test" (actuel : ${config.DB_NAME})`);
}

const { initDB, initTables, supprimerTables, closePool, query } = require('../db/mysql');
const { seedAdmin, seedDemo } = require('../db/seed');
const { createApp } = require('../server');
const { maintenantLocal } = require('../lib/util');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const PLATEAU = { lat: 5.32, lng: -4.02 };

let server;
let baseUrl;
let admin;
let patient;
const ids = {};

async function api(method, chemin, { token, body } = {}) {
    const res = await fetch(baseUrl + chemin, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
        body: body ? JSON.stringify(body) : undefined
    });
    const texte = await res.text();
    let json;
    try { json = JSON.parse(texte); } catch { json = texte; }
    return { status: res.status, body: json };
}

async function etablissement(categorie, nom, lat, lng, extra = {}) {
    const r = await query(
        "INSERT INTO etablissements (pays, categorie, nom, lat, lng, commune, statut, source, urgences) VALUES ('CI', ?, ?, ?, ?, ?, 'valide', 'admin', ?)",
        [categorie, nom, lat, lng, extra.commune || 'Plateau', !!extra.urgences]
    );
    return r.insertId;
}

before(async () => {
    await initDB();
    await supprimerTables();
    await initTables();
    await seedAdmin();
    await seedDemo();

    ids.pharmacieProche = await etablissement('pharmacie', 'Pharmacie du Plateau', 5.3210, -4.0205);
    ids.dentiste = await etablissement('dentiste', 'Cabinet dentaire Indénié', 5.3230, -4.0230);
    ids.hopital = await etablissement('hopital', 'Hôpital du Centre', 5.3300, -4.0150, { urgences: true });
    ids.pharmacieLoin = await etablissement('pharmacie', 'Pharmacie d\'Abobo', 5.4500, -4.0000, { commune: 'Abobo' });
    [{ id: ids.centre }] = await query("SELECT id FROM etablissements WHERE source = 'demo' AND statut = 'valide'");

    server = createApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    admin = (await api('POST', '/api/auth/connexion', { body: { identifiant: 'admin@santemap.ci', mot_de_passe: 'admin-test-123' } })).body.token;
    const inscription = await api('POST', '/api/auth/inscription', { body: { nom: 'Awa Koné', telephone: '+225 07 11 22 33 44', mot_de_passe: 'motdepasse1' } });
    patient = inscription.body;
});

after(async () => {
    server?.close();
    await closePool();
});

test('les fichiers du serveur ne sont jamais servis', async () => {
    for (const fichier of ['/.env', '/server.js', '/config.js', '/package.json', '/db/mysql.js', '/data/osm-ci.json']) {
        const texte = await (await fetch(baseUrl + fichier)).text();
        assert.ok(!texte.includes('require('), `${fichier} ne doit pas être exposé`);
        assert.ok(!texte.includes('"etablissements"'), `${fichier} ne doit pas être exposé`);
    }
    const leaflet = await fetch(baseUrl + '/vendor/leaflet/leaflet.js');
    assert.equal(leaflet.status, 200);
});

test('meta : pays, catégories et numéros d\'urgence', async () => {
    const { body } = await api('GET', '/api/meta');
    assert.equal(body.pays.code, 'CI');
    assert.equal(body.categories.length, 9);
    assert.ok(body.pays.urgences.some(u => u.numero === '185'));
});

test('recherche autour de soi : tri par distance, rayon et filtres', async () => {
    const { body } = await api('GET', `/api/etablissements?lat=${PLATEAU.lat}&lng=${PLATEAU.lng}&rayon=5`);
    const noms = body.items.map(e => e.nom);
    assert.equal(noms[0], 'Pharmacie du Plateau');
    assert.ok(!noms.includes('Pharmacie d\'Abobo'), 'hors du rayon de 5 km');
    assert.ok(body.items.every((e, i, t) => i === 0 || t[i - 1].distance <= e.distance));
    assert.equal(body.compteurs.pharmacie, 1);
    assert.equal(body.compteurs.dentiste, 1);

    const dentistes = await api('GET', `/api/etablissements?lat=${PLATEAU.lat}&lng=${PLATEAU.lng}&rayon=5&categorie=dentiste`);
    assert.deepEqual(dentistes.body.items.map(e => e.nom), ['Cabinet dentaire Indénié']);

    const large = await api('GET', `/api/etablissements?lat=${PLATEAU.lat}&lng=${PLATEAU.lng}&rayon=20&categorie=pharmacie`);
    assert.equal(large.body.total, 2);

    const recherche = await api('GET', `/api/etablissements?lat=${PLATEAU.lat}&lng=${PLATEAU.lng}&q=abobo`);
    assert.deepEqual(recherche.body.items.map(e => e.nom), ['Pharmacie d\'Abobo']);
});

test('inscription et connexion', async () => {
    const court = await api('POST', '/api/auth/inscription', { body: { nom: 'Test', telephone: '0102030405', mot_de_passe: '123' } });
    assert.equal(court.status, 400);

    const doublon = await api('POST', '/api/auth/inscription', { body: { nom: 'Autre', telephone: '0711223344', mot_de_passe: 'motdepasse1' } });
    assert.equal(doublon.status, 409, 'le même numéro, écrit sans indicatif, est reconnu');

    const mauvais = await api('POST', '/api/auth/connexion', { body: { identifiant: '0711223344', mot_de_passe: 'faux-mot-de-passe' } });
    assert.equal(mauvais.status, 401);

    const bon = await api('POST', '/api/auth/connexion', { body: { identifiant: '07 11 22 33 44', mot_de_passe: 'motdepasse1' } });
    assert.equal(bon.status, 200);
    assert.equal(bon.body.user.nom, 'Awa Koné');
});

test('contribution : en attente, puis validée par l\'équipe avec points et parrainage', async () => {
    const anonyme = await api('POST', '/api/moi/contributions', { body: { nom: 'Pharmacie X', categorie: 'pharmacie', lat: 5.33, lng: -4.01 } });
    assert.equal(anonyme.status, 401);

    // Un filleul s'inscrit avec le code de parrainage d'Awa
    const filleul = (await api('POST', '/api/auth/inscription', {
        body: { nom: 'Yao Kouassi', telephone: '0555667788', mot_de_passe: 'motdepasse2', code_parrainage: patient.user.code_parrainage }
    })).body;

    const fausse = await api('POST', '/api/moi/contributions', {
        token: filleul.token,
        body: { nom: 'Pharmacie Lagune', categorie: 'pharmacie', lat: 5.335, lng: -4.012, photo: 'data:image/png;base64,' + Buffer.from('pas une image').toString('base64') }
    });
    assert.equal(fausse.status, 400);

    const ajout = await api('POST', '/api/moi/contributions', {
        token: filleul.token,
        body: { nom: 'Pharmacie Lagune', categorie: 'pharmacie', lat: 5.335, lng: -4.012, commune: 'Plateau', photo: PNG }
    });
    assert.equal(ajout.status, 201);

    const carte = await api('GET', '/api/etablissements?lat=5.335&lng=-4.012&rayon=2');
    assert.ok(!carte.body.items.some(e => e.id === ajout.body.id), 'invisible tant qu\'elle n\'est pas validée');
    assert.equal((await api('GET', `/api/etablissements/${ajout.body.id}`)).status, 404);
    assert.equal((await api('GET', `/api/etablissements/${ajout.body.id}`, { token: filleul.token })).status, 200, 'visible par son auteur');

    assert.equal((await api('GET', '/api/admin/contributions', { token: filleul.token })).status, 403);
    const liste = await api('GET', '/api/admin/contributions', { token: admin });
    assert.ok(liste.body.some(c => c.id === ajout.body.id && c.photo_id));

    const validation = await api('POST', `/api/admin/contributions/${ajout.body.id}/valider`, { token: admin, body: {} });
    assert.equal(validation.status, 200);
    assert.equal(validation.body.points_attribues, config.POINTS.CONTRIBUTION + config.POINTS.PHOTO);

    const fiche = await api('GET', `/api/etablissements/${ajout.body.id}`);
    assert.equal(fiche.status, 200);
    assert.equal(fiche.body.photos.length, 1);
    assert.equal((await fetch(`${baseUrl}/api/photos/${fiche.body.photos[0]}`)).headers.get('content-type'), 'image/png');

    const tableau = (await api('GET', '/api/moi/tableau', { token: filleul.token })).body;
    assert.equal(tableau.user.points, 15);
    assert.equal(tableau.notifications_non_lues, 1);

    const parrain = (await api('GET', '/api/moi/tableau', { token: patient.token })).body;
    assert.equal(parrain.user.points, config.POINTS.PARRAINAGE);
    assert.equal(parrain.filleuls, 1);
});

test('contribution refusée avec un motif', async () => {
    const ajout = await api('POST', '/api/moi/contributions', { token: patient.token, body: { nom: 'Clinique inconnue', categorie: 'clinique', lat: 5.34, lng: -4.0 } });
    const sansMotif = await api('POST', `/api/admin/contributions/${ajout.body.id}/refuser`, { token: admin, body: {} });
    assert.equal(sansMotif.status, 400);
    const refus = await api('POST', `/api/admin/contributions/${ajout.body.id}/refuser`, { token: admin, body: { motif: 'Adresse introuvable' } });
    assert.equal(refus.status, 200);
    const tableau = (await api('GET', '/api/moi/tableau', { token: patient.token })).body;
    const contribution = tableau.contributions.find(c => c.id === ajout.body.id);
    assert.equal(contribution.statut, 'refuse');
    assert.equal(contribution.motif_refus, 'Adresse introuvable');
});

test('pharmacies de garde', async () => {
    const { date } = maintenantLocal('Africa/Abidjan');
    const nonPharmacie = await api('POST', `/api/admin/etablissements/${ids.dentiste}/gardes`, { token: admin, body: { debut: date, fin: date } });
    assert.equal(nonPharmacie.status, 400);

    const garde = await api('POST', `/api/admin/etablissements/${ids.pharmacieProche}/gardes`, { token: admin, body: { debut: date, fin: date } });
    assert.equal(garde.status, 201);

    const { body } = await api('GET', `/api/etablissements?lat=${PLATEAU.lat}&lng=${PLATEAU.lng}&rayon=5&garde=1`);
    assert.deepEqual(body.items.map(e => e.nom), ['Pharmacie du Plateau']);
    assert.equal(body.items[0].de_garde, true);
    assert.equal(body.compteurs.garde, 1);
});

test('rendez-vous : réservation, créneau déjà pris, confirmation par l\'établissement, annulation', async () => {
    const fiche = (await api('GET', `/api/etablissements/${ids.centre}`)).body;
    assert.equal(fiche.rdv_actif, true);
    assert.ok(fiche.services.includes('Pédiatrie'));
    assert.equal(fiche.prochains_creneaux.length, 3);
    const { date, heure } = fiche.prochains_creneaux[0];

    const sansConnexion = await api('POST', '/api/moi/rendez-vous', { body: { etablissement_id: ids.centre, date, heure, telephone: '0711223344' } });
    assert.equal(sansConnexion.status, 401);

    const rdv = await api('POST', '/api/moi/rendez-vous', { token: patient.token, body: { etablissement_id: ids.centre, date, heure, telephone: '0711223344', motif: 'Consultation' } });
    assert.equal(rdv.status, 201);
    assert.match(rdv.body.reference, /^SM-/);

    const encore = await api('POST', '/api/moi/rendez-vous', { token: patient.token, body: { etablissement_id: ids.centre, date, heure, telephone: '0711223344' } });
    assert.equal(encore.status, 409);

    const creneaux = (await api('GET', `/api/etablissements/${ids.centre}/creneaux?date=${date}`)).body.creneaux;
    assert.ok(!creneaux.includes(heure), 'le créneau réservé n\'est plus proposé');

    const pasDeRdv = await api('POST', '/api/moi/rendez-vous', { token: patient.token, body: { etablissement_id: ids.dentiste, date, heure, telephone: '0711223344' } });
    assert.equal(pasDeRdv.status, 404);

    // L'établissement voit la demande et la confirme : le patient est prévenu
    const pro = (await api('POST', '/api/auth/connexion', { body: { identifiant: 'centre@santemap.ci', mot_de_passe: 'demo12345' } })).body.token;
    const espace = (await api('GET', '/api/pro', { token: pro })).body;
    assert.ok(espace.rendez_vous.some(r => r.id === rdv.body.id));
    assert.equal((await api('PATCH', `/api/pro/rendez-vous/${rdv.body.id}`, { token: pro, body: { statut: 'confirme' } })).status, 200);
    assert.equal((await api('GET', '/api/pro', { token: patient.token })).status, 403);

    const notifications = (await api('GET', '/api/moi/notifications', { token: patient.token })).body;
    assert.ok(notifications.some(n => n.titre === 'Rendez-vous confirmé'));

    const annulation = await api('POST', `/api/moi/rendez-vous/${rdv.body.id}/annuler`, { token: patient.token });
    assert.equal(annulation.status, 200);
    const apres = (await api('GET', `/api/etablissements/${ids.centre}/creneaux?date=${date}`)).body.creneaux;
    assert.ok(apres.includes(heure), 'le créneau est de nouveau libre');
});

test('fiche partenaire : contrôles de l\'administration', async () => {
    const sansHoraires = await api('PATCH', `/api/admin/etablissements/${ids.hopital}`, { token: admin, body: { rdv_actif: true } });
    assert.equal(sansHoraires.status, 400);
    const mauvaisHoraires = await api('PATCH', `/api/admin/etablissements/${ids.hopital}`, { token: admin, body: { rdv_horaires: { 1: ['17:00-08:00'] } } });
    assert.equal(mauvaisHoraires.status, 400);
    const ok = await api('PATCH', `/api/admin/etablissements/${ids.hopital}`, {
        token: admin,
        body: { premium: true, services: ['Urgences', 'Maternité'], rdv_horaires: { 1: ['08:00-12:00'] }, rdv_actif: true, prix_consultation: '10000' }
    });
    assert.equal(ok.status, 200);
    const fiche = (await api('GET', `/api/etablissements/${ids.hopital}`)).body;
    assert.deepEqual(fiche.services, ['Urgences', 'Maternité']);
    assert.equal(fiche.prix_consultation, 10000);
});

test('signalement d\'une erreur', async () => {
    const invalide = await api('POST', `/api/etablissements/${ids.dentiste}/signalements`, { body: { motif: 'nimporte' } });
    assert.equal(invalide.status, 400);
    const ok = await api('POST', `/api/etablissements/${ids.dentiste}/signalements`, { body: { motif: 'ferme', message: 'Fermé depuis un mois' } });
    assert.equal(ok.status, 201);
    const liste = (await api('GET', '/api/admin/signalements', { token: admin })).body;
    assert.ok(liste.some(s => s.etablissement_id === ids.dentiste && s.motif === 'ferme'));
});
