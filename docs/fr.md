# ecojoko pour Gladys Assistant

Ramenez dans Gladys les mesures de votre assistant d'énergie **ecojoko** : la
puissance consommée en direct, la consommation du jour et, si votre afficheur
les remonte, la température et l'humidité. L'intégration fabrique aussi un
**index cumulé** à partir des totaux journaliers, ce qui permet à Gladys de
construire son tableau de bord énergie (consommation par demi-heure et coût
selon votre contrat).

| Capteur                     | Unité | Ce qu'il indique                                                |
| --------------------------- | ----- | --------------------------------------------------------------- |
| **Puissance instantanée**   | W     | Ce que la maison tire du réseau à l'instant                     |
| **Index de consommation**   | kWh   | Compteur cumulé depuis l'installation (base du tableau de bord) |
| **Consommation du jour**    | kWh   | Le total du jour, remis à zéro chaque nuit                      |
| **_Période_ du jour**       | kWh   | Idem par période tarifaire (HC/HP, couleurs Tempo…), optionnel  |
| **Surplus solaire du jour** | kWh   | Énergie injectée au réseau, si ecojoko la mesure chez vous      |
| **Température / humidité**  | °C, % | Intérieure (afficheur) et extérieure, dans un second appareil   |

## Prérequis

- Un capteur ecojoko installé et relié au cloud ecojoko.
- Les identifiants de votre compte ecojoko (ceux de l'application mobile ou de
  [service.ecojoko.com](https://service.ecojoko.com/)).

## Configuration

1. Saisissez votre **e-mail** et votre **mot de passe** ecojoko, puis
   enregistrez.
2. Cliquez sur **Tester la connexion** : le message confirme la passerelle
   trouvée, la puissance du moment et ce que votre compte expose (périodes
   tarifaires, surplus solaire, capteur d'ambiance).
3. Allez dans **Appareils** de l'intégration et ajoutez l'appareil `ecojoko`
   (et `ecojoko (ambiance)` s'il apparaît).
4. Pour le tableau de bord énergie, choisissez dans les réglages énergie de
   Gladys la fonctionnalité **Index de consommation** comme compteur principal
   et renseignez votre contrat.

Les deux fréquences se règlent dans la configuration : la puissance instantanée
(30 s par défaut) et les statistiques du jour (5 min par défaut). Chaque lecture
est une requête vers le cloud ecojoko : inutile de descendre en dessous de
quelques secondes, l'afficheur lui-même n'est pas plus rapide.

## À savoir

- **Aucune API officielle.** ecojoko n'en publie pas ; l'intégration utilise
  l'interface de sa propre application web, comme le font les intégrations
  communautaires pour Home Assistant. Elle peut cesser de fonctionner si
  ecojoko la modifie. Rien n'est jamais écrit sur votre compte.
- **L'index part de zéro à l'installation**, pas de la valeur de votre Linky :
  ecojoko n'expose pas l'index du compteur. Seules les différences comptent
  pour Gladys. L'état est conservé dans le volume de l'intégration : un
  redémarrage ne le remet pas à zéro, et les jours manqués pendant un arrêt
  sont rattrapés depuis les statistiques hebdomadaires d'ecojoko.
- **Les périodes tarifaires** viennent du tarif que vous avez déclaré dans
  l'application ecojoko. Si vous le changez, enregistrez à nouveau la
  configuration : les nouveaux capteurs apparaîtront dans Appareils.
- **Un seul compte, une seule passerelle** : si plusieurs passerelles sont
  rattachées au compte, seule la première est prise en charge.

## Dépannage

- _« ecojoko refuse l'identifiant ou le mot de passe »_ : vérifiez-les sur
  [service.ecojoko.com](https://service.ecojoko.com/). L'intégration s'arrête
  volontairement tant que la configuration n'est pas corrigée, pour ne pas
  bloquer votre compte.
- _« Le cloud ecojoko ne répond pas »_ : incident côté ecojoko ou coupure
  Internet ; les tentatives reprennent d'elles-mêmes. Les valeurs reprennent
  sans intervention.
- _Pas d'appareil « ambiance »_ : votre compte ne remonte pas de capteur
  température/humidité, ou l'option est désactivée dans la configuration.

Projet communautaire indépendant, sans lien avec la société ecojoko.
