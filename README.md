# SantéMap — la carte de la santé et du bien-être

Application web qui recense les établissements de santé d'un pays et les affiche sur une carte : pharmacies, hôpitaux, cliniques, médecins et centres de santé, laboratoires d'analyses, imagerie médicale, cabinets dentaires, kinésithérapie, spa et massage.

Pays de départ : **Côte d'Ivoire**. Le modèle est prévu pour être repris dans d'autres pays (Bénin, Togo, Mali, Burkina Faso…).

## Fonctionnalités

**Pour la population (gratuit)**
- Carte autour de soi (géolocalisation), filtres par type d'établissement et rayon de recherche (1 à 50 km).
- Recherche par nom ou par commune, y compris à la voix sur les navigateurs compatibles.
- Pharmacies de garde du jour.
- Fiche de chaque établissement : photos, adresse, téléphone, horaires par service, spécialités, tarifs indicatifs déclarés, assurances acceptées, petite carte, itinéraire, partage, signalement d'erreur.
- Niveau de vérification affiché clairement (publié non vérifié, vérifié par l'équipe, fiche gérée par l'établissement). Une fiche n'est jamais présentée comme une certification officielle.
- Page Urgences : SAMU (185), sapeurs-pompiers (180), police, et hôpitaux les plus proches.
- Demande de rendez-vous chez les établissements partenaires : service souhaité, jour, plage (matin, midi, après-midi), canal de confirmation (WhatsApp, SMS, appel). Une demande « en attente de réponse » n'est jamais présentée comme une réservation confirmée. Pas de dossier médical, d'ordonnance ni de résultats.
- Installable sur l'écran d'accueil du téléphone, comme une application.
- Notifications dans l'application, avec une copie par e-mail pour les comptes qui ont une adresse (rendez-vous confirmé ou refusé, contribution validée, échange de points…). Il suffit de renseigner `SMTP_HOST` et les variables `SMTP_*` ; sans elles, aucun e-mail n'est envoyé. Les SMS et WhatsApp ne sont pas encore branchés.

**Contribution et parrainage**
- Tout membre peut ajouter un établissement manquant : position sur la carte, photo prise avec le téléphone, téléphone, horaires.
- Détection de doublons pendant la saisie (nom proche à moins de 600 m, même type, ou même numéro de téléphone), et de nouveau côté équipe à moins de 150 m.
- Une pharmacie peut être déclarée « de garde cette semaine » : la garde commence à la validation.
- Chaque ajout est vérifié par l'équipe avant d'être publié.
- Points gagnés (barème modifiable dans `config.js`, à fixer avant le lancement public) :
  - +50 par établissement validé (nom, catégorie et position) ;
  - +50 avec la photo de la devanture ou de la plaque ;
  - +50 au parrain quand son filleul fait sa première contribution.
- Niveaux : Éclaireur, Relais (150 points), Veilleur (300), Sentinelle (600).
- Échange des points contre du crédit (Orange, MTN, Moov) ou un forfait Internet : 1 point = 5 FCFA, 3 échanges par mois et par membre au plus, et un budget total par mois (`ECHANGES_BUDGET_MOIS`, 100 000 FCFA par défaut, 0 = sans limite) : une fois atteint, les échanges sont bloqués jusqu'au mois suivant. Les points sont débités tout de suite ; l'équipe fait la recharge (ou refuse, et les points sont rendus).
- Signalement d'une erreur sur une fiche (établissement fermé, mauvaise position…).

**Offre payante pour les établissements**
- Fiche détaillée : services proposés et prix de consultation.
- Rendez-vous en ligne selon les horaires de consultation : créneaux calculés automatiquement, sans double réservation.
- Revendication de fiche : le professionnel fournit son numéro d'ordre, de licence ou d'agrément (et une photo du document, vue seulement par l'équipe). Après contrôle, son compte devient « établissement » et la fiche « revendiquée ».
- Compte « établissement » : modifier les informations autorisées (téléphone, horaires par service, tarifs, assurances, description) ; accepter, refuser, terminer ou marquer absent un rendez-vous. Le patient est prévenu dans l'application.

**Administration (`/admin.html`)**
- Validation et refus des contributions, avec un motif envoyé au contributeur.
- Modification des fiches : offre partenaire, horaires de rendez-vous, déclaration des pharmacies de garde.
- Revendications de fiches (contrôle des justificatifs) et échanges de points à traiter.
- Gestion des rendez-vous, des signalements et des comptes.

## Données

Les 2 387 établissements de départ proviennent d'**OpenStreetMap** (© contributeurs OpenStreetMap, licence ODbL). On les récupère avec :

```bash
node scripts/import-osm.js CI
```

Le fichier `data/osm-ci.json` est chargé automatiquement au premier démarrage. La licence ODbL impose de citer la source, ce que fait la carte, et de partager sous la même licence une base qui en est dérivée et diffusée.

Pourquoi OpenStreetMap plutôt que Google Maps : les fonds de carte et les données OpenStreetMap sont gratuits, alors que l'API Google Maps devient payante au-delà d'un quota mensuel. Pour un trafic important, on passera à un fournisseur de tuiles dédié (MapTiler, Stadia Maps…) ou à des tuiles auto-hébergées. Les serveurs de tuiles d'openstreetmap.org sont réservés à un usage modéré.

## Technique

- **Serveur** : Node.js, Express, MySQL/MariaDB, authentification JWT, mots de passe hachés (bcrypt), limitation des tentatives de connexion, en-têtes de sécurité (CSP).
- **Interface** : HTML, CSS et JavaScript sans framework, carte Leaflet. Pensée d'abord pour le téléphone, avec un panneau latéral sur ordinateur.
- **Distance** : calcul de haversine en SQL, précédé d'un filtre rapide par rectangle.
- **Photos** : réduites dans le navigateur (1280 px, JPEG) pour économiser les données mobiles, puis vérifiées côté serveur (vrai JPEG, PNG ou WebP, 1,5 Mo maximum).

## Lancer le projet

Prérequis : Node.js 20+ et MySQL ou MariaDB.

```bash
npm install
cp .env.example .env    # puis renseignez la base de données
npm start
```

Ouvrez ensuite http://localhost:3000.

### Comptes de démonstration (`SEED_DEMO=true`)

| Rôle | Identifiant | Mot de passe |
|------|-------------|--------------|
| Membre | demo@santemap.ci | demo12345 |
| Établissement (centre de démonstration) | centre@santemap.ci | demo12345 |
| Équipe (administration) | admin@santemap.ci | valeur de `ADMIN_PASSWORD` |

Le « Centre médical de démonstration » est un établissement fictif, créé pour montrer la fiche partenaire et la prise de rendez-vous.

## Tests

Les tests d'intégration utilisent une vraie base dédiée, vidée au début des tests :

```bash
DB_NAME=santemap_tests npm test
```

Ils couvrent :
- la recherche par distance, rayon et catégorie, et les pharmacies de garde ;
- l'inscription et la connexion ;
- les contributions (validation, refus, points, parrainage, photos) ;
- les rendez-vous (créneau déjà pris, demande par plage, confirmation, refus, absence, annulation) ;
- la détection de doublons, la garde déclarée à la contribution ;
- l'échange de points (débit, plafond mensuel, remboursement) ;
- la revendication d'une fiche et les droits du professionnel ;
- les droits d'accès et les signalements.

## Déploiement (Render + Aiven)

1. Sur Render : **New + → Blueprint**, puis choisir ce dépôt.
2. Renseigner les informations de la base MySQL (Aiven) : `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_SSL_CA`. Indiquer aussi le mot de passe administrateur, `ADMIN_PASSWORD`.
3. La base `santemap` est créée au premier démarrage, et les établissements y sont importés.

## Ajouter un pays

1. Importer ses établissements, par exemple pour le Bénin : `node scripts/import-osm.js BJ`.
2. Compléter `lib/pays.js` : centre de la carte, fuseau horaire, numéros d'urgence.
3. Indiquer `PAYS_DEFAUT=BJ` pour une instance dédiée à ce pays.
