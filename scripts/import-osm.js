/**
 * Récupère les établissements de santé d'un pays dans OpenStreetMap (API Overpass)
 * et les enregistre dans data/osm-<pays>.json, chargé au premier démarrage du serveur.
 *
 * Utilisation : node scripts/import-osm.js CI
 * Données © contributeurs OpenStreetMap, sous licence ODbL.
 */

const fs = require('fs');
const path = require('path');
const { categorieDepuisOsm } = require('../lib/categories');

const pays = (process.argv[2] || 'CI').toUpperCase();

const requete = `
[out:json][timeout:180];
area["ISO3166-1"="${pays}"][admin_level=2]->.pays;
(
  nwr["amenity"~"^(pharmacy|hospital|clinic|doctors|dentist)$"](area.pays);
  nwr["healthcare"~"^(laboratory|physiotherapist|centre|hospital|clinic|pharmacy|dentist|doctor|radiology)$"](area.pays);
  nwr["leisure"="spa"](area.pays);
  nwr["shop"="massage"](area.pays);
);
out tags center;`;

const texte = valeur => (valeur || '').trim() || null;

function telephone(tags) {
    const brut = tags.phone || tags['contact:phone'] || tags['contact:mobile'];
    if (!brut) return null;
    return brut.split(/[;,]/).map(t => t.trim()).filter(Boolean).slice(0, 2).join(' / ');
}

function adresse(tags) {
    const rue = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
    return texte([rue, tags['addr:place']].filter(Boolean).join(', '));
}

async function main() {
    console.log(`Interrogation d'OpenStreetMap pour le pays ${pays}…`);
    const reponse = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SanteMap/1.0 (import ponctuel)' },
        body: 'data=' + encodeURIComponent(requete)
    });
    if (!reponse.ok) throw new Error(`Overpass a répondu ${reponse.status}`);
    const { elements } = await reponse.json();

    const vus = new Set();
    const etablissements = [];
    for (const e of elements) {
        const tags = e.tags || {};
        const nom = texte(tags.name);
        const lat = e.lat ?? e.center?.lat;
        const lng = e.lon ?? e.center?.lon;
        const categorie = categorieDepuisOsm(tags);
        // Sans nom ni position, l'établissement n'est pas exploitable : il pourra être ajouté par la communauté
        if (!nom || lat == null || lng == null || !categorie) continue;

        const osmId = `${e.type[0]}${e.id}`;
        if (vus.has(osmId)) continue;
        vus.add(osmId);

        etablissements.push({
            osm_id: osmId,
            categorie,
            nom: nom.slice(0, 200),
            lat: Number(lat.toFixed(6)),
            lng: Number(lng.toFixed(6)),
            adresse: adresse(tags),
            commune: texte(tags['addr:suburb'] || tags['addr:district'] || tags['addr:city'] || tags['addr:town'] || tags['addr:village']),
            telephone: telephone(tags),
            site_web: texte(tags.website || tags['contact:website']),
            horaires: texte(tags.opening_hours),
            ouvert_24h: tags.opening_hours === '24/7',
            urgences: tags.emergency === 'yes'
        });
    }

    etablissements.sort((a, b) => a.osm_id.localeCompare(b.osm_id));
    const fichier = path.join(__dirname, '..', 'data', `osm-${pays.toLowerCase()}.json`);
    fs.mkdirSync(path.dirname(fichier), { recursive: true });
    fs.writeFileSync(fichier, JSON.stringify({
        source: 'OpenStreetMap (ODbL) — © contributeurs OpenStreetMap',
        pays,
        date: new Date().toISOString().slice(0, 10),
        etablissements
    }));

    const parCategorie = etablissements.reduce((acc, e) => ({ ...acc, [e.categorie]: (acc[e.categorie] || 0) + 1 }), {});
    console.log(`${etablissements.length} établissements enregistrés dans ${path.relative(process.cwd(), fichier)}`);
    console.log(parCategorie);
}

main().catch(err => {
    console.error('Échec de l\'import :', err.message);
    process.exit(1);
});
