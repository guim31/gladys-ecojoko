# CLAUDE.md — ecojoko

Puissance en direct, consommation du jour et capteurs d'ambiance de votre assistant ecojoko.

Intégration externe pour [Gladys Assistant](https://gladysassistant.com), bâtie sur le template officiel `GladysAssistant/integration-template-js` (SDK `@gladysassistant/integration-sdk` ^0.13.0, `gladys_version` `>=4.86.0`). Mainteneur : Guilhem (`guim31`).

Ce fichier rassemble ce qu'une session de code doit savoir et qui ne se lit pas dans le code : choix de conception, faits vérifiés en réel, pièges déjà payés. Le compléter quand un nouveau piège est découvert.

## État au 05/10/2026

Version 1.0.3 publiée (index de production cumulé compris), indexée dans le store.

Branche `feat/dashboard-widgets` (PR brouillon vers `main`) : trois widgets de tableau de bord
(`energy`, `week`, `ambient`), SDK monté à `^0.14.0`, `gladys_version` à `>=5.1.0`. Rien de tout
cela n'a été vu sur une instance Gladys ni avec un compte ecojoko : seuls la suite de tests, le
validateur de contenu du SDK et le validateur du store ont tourné. À faire tester par Pat.

Guilhem n'a pas d'ecojoko : les retours réels viennent de **Pat**, producteur solaire, sur le fil
https://community.gladysassistant.com/t/10833. Validée en réel le 09/09/2026, chiffres,
`kwh_prod` et `subconsumption` compris.

## API ecojoko

Aucune documentation officielle ; référence : l'intégration Home Assistant
`jmcruvellier/little_monkey`.

- `POST https://service.ecojoko.com/login {l,p}` rend le cookie `LKS`, posé deux fois dont la
  seconde déjà expirée : garder la première.
- `GET /gateways` donne `gateway_id` et les appareils `POWER_METER` et `TEMP_HUM`.
- `/gateway/<gw>/device/<pm>/realtime_conso` → `real_time.value` (W).
- `/powerstat/w/<YYYY-MM-DD>` → 7 entrées du lundi au dimanche (`kwh`, `kwh_prod`,
  `subconsumption[{label,kwh}]`).
- `/tempstat/d4/` et `/humstat/d4/` → `value` / `ext_value`.
- Erreurs vérifiées : 400/102 e-mail invalide, 401/101 mauvais identifiants, 401/305 session
  expirée (un seul re-login).

## Choix non évidents

- Gladys ne dérive la consommation 30 min et le coût que d'un `energy-sensor`/`index`
  **cumulé**, or ecojoko ne donne que des totaux journaliers : `src/index-store.js` synthétise un
  index monotone persistant dans `/data` (repli des jours révolus, rattrapage par semaines,
  anti-recul). Il part de 0, pas de l'index du Linky.
- **La puissance est un échange réseau signé** : `grid-sensor`/`power` (import > 0, export < 0),
  jamais `energy-sensor`/`power`, qui est une consommation. Bornes symétriques −12000/+12000 W :
  un `min: 0` mettait tout surplus solaire hors de la jauge.
- Deux cadences internes, puissance toutes les 30 s et statistiques toutes les 5 min, avec
  `should_poll: false`.
- Mauvais identifiants : arrêt des timers, pour ne pas faire bloquer le compte.
- Périodes tarifaires découvertes dans `subconsumption` : une fonctionnalité `index-today` par
  libellé.
- L'index de production (`energy-production-sensor`/`index`) n'allumera pas pour autant le suivi
  de production 30 min : `addEnergyFeatures` du cœur ne dérive que la consommation. Il faudrait
  une PR du cœur pour le type PRODUCTION.
- Une jauge centrée sur zéro est impossible dans Gladys (`radialBar` à une seule série).
- **Les widgets ne coûtent aucune requête** : le moteur garde en mémoire le dernier relevé de
  puissance, les dernières statistiques et les semaines brutes qu'il a vues (`getLastReadings()`
  dans `src/engine.js`). La semaine précédente n'y est que si le rattrapage de l'index l'a lue
  (premier relevé d'un lundi, ou reprise après un arrêt) : la ligne « Semaine dernière » du widget
  est donc occasionnelle, par choix, plutôt que de rajouter un appel `/powerstat/w/`.
- Tuiles et courbes de puissance/température sont **liées aux fonctionnalités** publiées
  (`device_feature`, `device_features`) : elles vivent sans rafraîchissement du contenu, mais
  restent vides tant que l'appareil n'est pas ajouté à Gladys. Seul le graphique « Semaine » est
  une série inline (kWh du jour placés à midi Paris, `parisNoonIso`), les jours à venir omis.
- Pas d'appel à `requestWidgetRefresh` : le `ttl_seconds` suffit (30 s, 900 s, 300 s) et les
  tuiles sont déjà en direct. Aucun bouton, donc pas d'`action_timeout_seconds`.
- Les builders de `src/widgets.js` sont purs ; `widgetFeatureIds(gladys, snapshot)` rederive les
  `external_id` exactement comme `src/devices/` (même `gladys.externalIds(type, platformId)`).

## Travailler sur ce dépôt

- Mêmes étapes que la CI, dans le même ordre : `npm ci`, `npm run format:check`, `npm run lint`,
  `npm test` (`node --test`). Prettier contrôle **aussi le Markdown** : lancer `npm run format`
  après avoir modifié ce fichier ou le README, sinon la CI tombe.
- La CI tourne en Node 24. Une session cloud a Node 22 par défaut, ce qui suffit (`engines` :
  `>=20`). Le validateur du store exige Node 24 (`EBADENGINE`) mais tourne quand même en 22.
- Le passage du SDK 0.13 à 0.14 n'a rien cassé : les 50 tests existants passent sans retouche.
- Une session de code n'a **ni instance Gladys ni appareil réel**. La suite de tests, le lint et
  le validateur du store sont les seules vérifications possibles : le test réel passe par
  Guilhem ou par les testeurs du forum. Le dire, plutôt que de conclure que « ça marche ».
- **Publier est un geste de Guilhem** : Actions → Release (patch, minor ou major) construit
  l'image `ghcr.io/guim31/<dépôt>`, monte la version du manifeste et pose le tag. Un correctif
  poussé sur `main` sans Release n'atteint aucune installation : le signaler.
- Le workflow Release réindente le manifeste sans relancer la CI : passer `npm run format` au
  commit suivant.
- Le dépôt est **public** : aucun secret, aucune adresse ni détail d'infrastructure privée, ni
  ici, ni dans les tests, ni dans les captures.

## Pièges du cœur Gladys (communs aux intégrations de guim31)

Vérifiés dans le code du cœur ou payés sur une intégration publiée. Ils valent pour toutes.

**Appareils et fonctionnalités**

- **Polling** : le planificateur n'interroge un appareil que si `should_poll: true` **et**
  `poll_frequency` vaut une valeur de la liste fixe (1000, 2000, 10000, 15000, 30000, 60000 ms).
  Publier seulement `poll_frequency` donne un appareil accepté mais jamais interrogé. Pour une
  cadence hors liste, publier `should_poll: false` et pousser les états depuis le conteneur, en
  gardant un `onPoll` de repli.
- **`min` et `max` sont NOT NULL** dans `t_device_feature`, y compris pour `text/text` : sans eux,
  « Ajouter à Gladys » échoue en HTTP 422. Mettre 0/0, comme Zigbee2MQTT.
- `level-sensor/decimal` n'existe pas côté serveur. `light-sensor/binary` n'a pas de libellé dans
  le front (pastille vide) : préférer `input/binary`. Un `text/text` reçoit `{ text }`, jamais
  vide, sinon l'état est ignoré.
- Les **noms de fonctionnalités sont figés à la création**. Et quand une fonctionnalité est seule
  de son type sur l'appareil, le tableau de bord affiche le libellé générique du type à la place
  du nom publié (`getDeviceFeatureName` du front).
- Depuis Gladys 4.84, un changement de structure fait proposer « Mettre à jour » dans l'onglet
  Découverte (`structure_changed`) : plus besoin de supprimer et recréer l'appareil. Un
  changement des seules `supported_options` ne le déclenche pas.
- **Jauge** : l'aiguille se place par `(value - min) / (max - min)` des bornes de la
  fonctionnalité. `gauge_min`/`gauge_max` ne pilotent que les couleurs, et le cœur n'applique
  jamais `min`/`max` en écriture : ce sont des bornes d'affichage. Une valeur signée exige des
  bornes symétriques.
- Le cœur plafonne à **300 états par minute** et réévalue les scènes à chaque état : ne publier
  que les changements.
- Une intégration `device` ne reçoit pas la langue de l'utilisateur, une action de scène non
  plus (un widget, si) : prévoir un champ de config `language`. Le superviseur injecte `TZ`, le
  fuseau de Gladys, dans le conteneur. La sandbox est limitée à 256 Mo.

**Formulaires de configuration et actions**

- Les champs `number` sont rendus en `<input type="number" min max>` **sans `step`** (le
  manifeste n'en accepte pas) : le navigateur n'accepte alors que `min + k`. Min et défaut
  **entiers** seulement ; une valeur décimale passe par un `select` ou par un `string` parsé
  (virgule acceptée).
- Un champ `secret` dans les `fields` d'une **action** est impossible à remplir (la saisie
  s'efface à chaque frappe), et une action n'applique **aucun `default`**, ni à l'affichage ni
  côté serveur, tout en exigeant les champs `required` (422).

**Widgets, déclencheurs, actions de scène (SDK ≥ 0.14, Gladys ≥ 5.1)**

- Budget du cœur : **8 composants par widget, dont 2 textes au plus**. Le validateur du SDK le
  signale ; `validateWidgetContent` est exporté pour les tests.
- Le cœur **jette un bouton dont la clé d'action est déjà prise** : clés numérotées, ce que fait
  le bouton dans ses paramètres.
- Le vocabulaire des widgets n'a ni liste ni curseur. Seul un bouton `device_feature` numérique
  a un état actif natif.
- Dans une grille `card-list`, la `date` s'affiche **à la place** du sous-titre.
- `onWidgetAction` fait recharger le widget dès la résolution, alors que `requestWidgetRefresh`
  est plafonné à un appel toutes les 10 s.
- Les filtres de scène ne font qu'égalité et appartenance : un seuil (Kp > 6) reste le travail
  d'un capteur.
- **Les clés de widgets, de déclencheurs et d'actions sont figées une fois publiées.**
- Passer `gladys_version` à `>=5.1.0` coupe les mises à jour des cœurs plus anciens, qui
  refusent les champs inconnus du manifeste.

## Publication et store

- Avant de demander une Release ou le topic, lancer le validateur officiel depuis la racine :
  `npx -y github:GladysAssistant/integration-store`. Il vérifie le schéma, la `description`
  (**100 caractères au plus par langue**), la documentation (300 caractères au moins), l'image
  Docker et la cover (**150 Ko au plus**).
- Le topic `gladys-assistant-integration` fait indexer le dépôt ; Guilhem le pose (le jeton de
  l'agent n'en a pas le droit). L'indexeur passe à H:13 chaque heure, souvent avec une demi-heure
  de retard, et rejette **en silence** : la raison n'apparaît que dans `rejected.json`, à côté de
  l'index `https://integration-store-storage.gladysassistant.com/index.json`.
- Sans topic, on installe par la carte « Installer depuis GitHub » (URL du dépôt, Gladys ≥ 4.84) :
  le cœur lit le manifeste sur `main` et propose les mises à jour à chaque rafraîchissement du
  catalogue.
- La règle `data/` du `.gitignore` du template (pour le volume `/data`) exclut aussi `src/data/` :
  l'ancrer en `/data/`, dans `.prettierignore` aussi. Avant de pousser un dépôt neuf, tester sur
  un `git clone` propre, pas sur la copie de travail.
